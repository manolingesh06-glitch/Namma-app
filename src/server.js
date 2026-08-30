// src/server.js
// -----------------------------------------------------------------------
// Wires HTTP (Express) for auth + auction setup, and Socket.io for
// real-time bidding. Bidding itself goes over the socket for lower
// latency; each connected client joins a room per auction so a bid
// broadcast only reaches people in that auction — not a global blast.
//
// PHASE 14 ADDITIONS: notifications, configurable sound settings, and a
// typing indicator. All three are deliberately kept OUT of the bidding
// critical path — see the comments at each hook point below.

import express from "express";
import cors from "cors";
import http from "http";
import { Server as SocketServer } from "socket.io";
import { v4 as uuid } from "uuid";
import { db } from "./db.js";
import { registerUser, loginUser, requireAuth, requireRole, getRoleInAuction, getUserDisplayName, JWT_SECRET } from "./auth.js";
import {
  placeBid, sellPlayer, markUnsold, nominatePlayer, undoLastAction,
  setAutoBid, cancelAutoBid, getAutoBidStatus, runAutoBidCascade,
  undoLastBid, getUndoableBid,
} from "./auctionEngine.js";
import {
  createAuction, getAuction, listAuctionsForUser, updateAuction, deleteAuction,
  duplicateAuction, setAuctionStatus, startAuction, preAuctionChecklist,
  addTeam, bulkAddTeams, editTeam, deleteTeam, listTeams, listMembers, assignTeamOwner, removeTeamOwner, assignHost,
  addPlayer, bulkAddPlayers, editPlayer, deletePlayer, listPlayers, reAuctionPlayers,
  pauseAuction, resumeAuction, emergencyPause, getAuthoritativeState,
} from "./management.js";
import { sendMessage, listRecentMessages, deleteMessage, muteUser, unmuteUser } from "./chat.js";
import { markOnline, markOffline, getPresenceSummary } from "./presence.js";
import { createNotification, listNotifications, markRead, markAllRead } from "./notifications.js";
import { SOUND_CATALOG, getSoundSettings, updateSoundSettings, resetSoundSettings, getDefaultSoundSettings } from "./soundSettings.js";
import { getLiveAnalytics, getFinalAnalytics } from "./analytics.js";
import { getSquadsRows, getPurchasesRows, getUnsoldRows, getBidHistoryRows, toCSV, buildFullWorkbook } from "./exportService.js";
import { createTemplate, listTemplates, getTemplate, updateTemplate, deleteTemplate } from "./templates.js";
import { rateLimit } from "./rateLimit.js";
import jwt from "jsonwebtoken";

const app = express();
// SECURITY: CORS defaults to "*" for easy local testing. Before deploying
// beyond your own machine, set CORS_ORIGIN to your actual frontend origin.
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

// Serve the frontend (host.html, team-owner.html, soundEngine.js) from
// this same server — one deployment, one URL, no separate static
// hosting or cross-origin config needed.
app.use(express.static(new URL("../frontend", import.meta.url).pathname));

// SECURITY: loose global limit so no single client can hammer the API,
// plus a much stricter limit specifically on login/register (the
// classic brute-force / credential-stuffing target).
app.use(rateLimit({ windowMs: 60_000, max: 120 }));
const authRateLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => `auth:${req.ip}` });

// ---------- Auth routes ----------
app.post("/api/register", authRateLimit, (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    const user = registerUser(username, password, displayName);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/login", authRateLimit, (req, res) => {
  try {
    const { username, password } = req.body;
    const result = loginUser(username, password);
    res.json(result);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ---------- Auctions (Owner) ----------
app.post("/api/auctions", requireAuth, (req, res) => {
  try {
    res.json(createAuction(req.userId, req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/auctions", requireAuth, (req, res) => {
  res.json(listAuctionsForUser(req.userId));
});

app.get("/api/auctions/:auctionId", (req, res) => {
  // Public read — viewers don't need to be members to see basic auction info.
  try {
    res.json(getAuction(req.params.auctionId));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.patch("/api/auctions/:auctionId", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(updateAuction(req.params.auctionId, req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/auctions/:auctionId", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    deleteAuction(req.params.auctionId);
    res.json({ deleted: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/duplicate", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(duplicateAuction(req.params.auctionId, req.userId, req.body.newName));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/pause", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const result = pauseAuction(req.params.auctionId);
    io.to(req.params.auctionId).emit("auction:paused", {});
    notifyAllMembers(req.params.auctionId, "AUCTION_PAUSED", "The auction has been paused.");
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/resume", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const result = resumeAuction(req.params.auctionId);
    io.to(req.params.auctionId).emit("auction:resumed", { livePlayerTimerEndsAt: result.livePlayerTimerEndsAt });
    notifyAllMembers(req.params.auctionId, "AUCTION_RESUMED", "The auction has resumed.");
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Emergency Pause: same freeze mechanism as a routine pause (new bids
// rejected, timer frozen), but logged distinctly and pushed to every
// member with an urgent message, per spec.
app.post("/api/auctions/:auctionId/emergency-pause", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const result = emergencyPause(req.params.auctionId);
    io.to(req.params.auctionId).emit("auction:emergencyPaused", {});
    notifyAllMembers(req.params.auctionId, "EMERGENCY_PAUSE", "EMERGENCY PAUSE — the auction has been stopped by the host/owner.");
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Undo the most recent not-yet-undone SOLD or UNSOLD action. Idempotent
// (requestId) and atomic — see undoLastAction in auctionEngine.js.
app.post("/api/auctions/:auctionId/undo", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const requestId = req.body.requestId || uuid();
    const result = undoLastAction({ requestId, auctionId: req.params.auctionId, userId: req.userId });
    if (result.accepted) {
      io.to(req.params.auctionId).emit("action:undone", result);
      if (result.type === "UNDO_SOLD") {
        notifyTeamOwners(req.params.auctionId, result.teamId, "CORRECTION", `A sale was corrected/undone — your purse and squad have been restored.`);
      } else {
        notifyAllMembers(req.params.auctionId, "CORRECTION", "A recent action was undone by the host.");
      }
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Undo the most recent ACCEPTED BID itself (distinct from undoing a
// completed SOLD/UNSOLD above) — for correcting an accidental or
// wrong-amount bid while the player is still LIVE.
app.post("/api/auctions/:auctionId/undo-bid", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const requestId = req.body.requestId || uuid();
    const result = undoLastBid({ requestId, auctionId: req.params.auctionId, userId: req.userId });
    if (result.accepted) {
      // Broadcast on the SAME event as a normal bid update — every
      // client already knows how to render this, no new listener needed.
      io.to(req.params.auctionId).emit("bid:update", {
        playerId: result.playerId, currentBid: result.currentBid,
        currentBidderTeamId: result.currentBidderTeamId, timerEndsAt: result.timerEndsAt,
      });
      notifyAllMembers(req.params.auctionId, "CORRECTION", "The last bid was undone by the host.");
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Auto-Bid / Max Bid — a Team Owner sets/cancels/checks their own
// standing maximum for the currently live player. teamId is derived
// from the caller's own membership, never trusted from the request body.
app.post("/api/auctions/:auctionId/players/:playerId/auto-bid", requireAuth, (req, res) => {
  const membership = getRoleInAuction(req.params.auctionId, req.userId);
  if (!membership || membership.role !== "TEAM_OWNER") {
    return res.status(403).json({ error: "Only a Team Owner can set an auto-bid." });
  }
  try {
    const result = setAutoBid({ auctionId: req.params.auctionId, playerId: req.params.playerId, teamId: membership.team_id, maxAmount: req.body.maxAmount });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/auctions/:auctionId/players/:playerId/auto-bid", requireAuth, (req, res) => {
  const membership = getRoleInAuction(req.params.auctionId, req.userId);
  if (!membership || membership.role !== "TEAM_OWNER") {
    return res.status(403).json({ error: "Only a Team Owner can cancel an auto-bid." });
  }
  res.json(cancelAutoBid({ playerId: req.params.playerId, teamId: membership.team_id }));
});

app.get("/api/auctions/:auctionId/players/:playerId/auto-bid", requireAuth, (req, res) => {
  const membership = getRoleInAuction(req.params.auctionId, req.userId);
  if (!membership || membership.role !== "TEAM_OWNER") return res.json({ active: false });
  res.json(getAutoBidStatus({ playerId: req.params.playerId, teamId: membership.team_id }));
});

// JSON purchases list (Highlights feature on the frontend) — the CSV/xlsx
// exports already existed; this is the same data as plain JSON.
app.get("/api/auctions/:auctionId/purchases", (req, res) => {
  res.json(getPurchasesRows(req.params.auctionId));
});

// ---------- Reconnect / Recovery ----------
app.get("/api/auctions/:auctionId/state", requireAuth, (req, res) => {
  try {
    res.json(getAuthoritativeState(req.params.auctionId, req.userId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/auctions/:auctionId/checklist", requireAuth, requireRole("OWNER"), (req, res) => {
  res.json(preAuctionChecklist(req.params.auctionId));
});

app.post("/api/auctions/:auctionId/start", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    const result = startAuction(req.params.auctionId);
    io.to(req.params.auctionId).emit("auction:started", {});
    notifyAllMembers(req.params.auctionId, "AUCTION_STARTED", "The auction has started.");
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Teams (Owner) ----------
app.post("/api/auctions/:auctionId/teams", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(addTeam(req.params.auctionId, req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/teams/bulk", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    // Expects { teams: [{ name, purse, squadLimit, overseasLimit, logoUrl }, ...] } —
    // parse the Excel/CSV file client-side (see host.html, uses SheetJS) then POST the array here.
    res.json(bulkAddTeams(req.params.auctionId, req.body.teams));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/auctions/:auctionId/teams", (req, res) => {
  res.json(listTeams(req.params.auctionId));
});

app.patch("/api/auctions/:auctionId/teams/:teamId", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(editTeam(req.params.teamId, req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/auctions/:auctionId/teams/:teamId", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    deleteTeam(req.params.teamId);
    res.json({ deleted: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/teams/:teamId/owner", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(assignTeamOwner(req.params.auctionId, req.params.teamId, req.body.username));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/auctions/:auctionId/teams/:teamId/owner", requireAuth, requireRole("OWNER"), (req, res) => {
  removeTeamOwner(req.params.auctionId, req.params.teamId);
  res.json({ removed: true });
});

app.post("/api/auctions/:auctionId/host", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(assignHost(req.params.auctionId, req.body.username));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Players (Owner) ----------
app.post("/api/auctions/:auctionId/players", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(addPlayer(req.params.auctionId, req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/players/bulk", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(bulkAddPlayers(req.params.auctionId, req.body.players));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/auctions/:auctionId/players", (req, res) => {
  const { search, status, category, sortBy, order } = req.query;
  res.json(listPlayers(req.params.auctionId, { search, status, category, sortBy, order }));
});

app.patch("/api/auctions/:auctionId/players/:playerId", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    res.json(editPlayer(req.params.playerId, req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/auctions/:auctionId/players/:playerId", requireAuth, requireRole("OWNER"), (req, res) => {
  try {
    deletePlayer(req.params.playerId);
    res.json({ deleted: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/players/reauction", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const result = reAuctionPlayers(req.params.auctionId, req.body.playerIds, req.body.newBasePrice);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Host/Owner controls (HTTP, since they're infrequent) ----------
app.post("/api/auctions/:auctionId/nominate", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const result = nominatePlayer({ auctionId: req.params.auctionId, playerId: req.body.playerId, userId: req.userId });
    io.to(req.params.auctionId).emit("player:live", { playerId: req.body.playerId, timerEndsAt: result.timerEndsAt });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/sell", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const requestId = req.body.requestId || uuid();
    const result = sellPlayer({ requestId, auctionId: req.params.auctionId, playerId: req.body.playerId, userId: req.userId });
    if (result.accepted) {
      io.to(req.params.auctionId).emit("player:sold", { playerId: req.body.playerId, ...result });
      // --- Notifications fire AFTER the sale is already committed and
      // broadcast — a failure here can never undo or delay the sale. ---
      notifySoldOutcome(req.params.auctionId, req.body.playerId, result.teamId, result.price);
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auctions/:auctionId/unsold", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const requestId = req.body.requestId || uuid();
    const result = markUnsold({ requestId, auctionId: req.params.auctionId, playerId: req.body.playerId, userId: req.userId });
    if (result.accepted) {
      io.to(req.params.auctionId).emit("player:unsold", { playerId: req.body.playerId });
      notifyAllMembers(req.params.auctionId, "PLAYER_UNSOLD", "A player was marked unsold.");
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Chat (isolated from bidding — separate table, separate path) ----------
app.get("/api/auctions/:auctionId/chat", requireAuth, (req, res) => {
  res.json(listRecentMessages(req.params.auctionId));
});

app.delete("/api/auctions/:auctionId/chat/:messageId", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  deleteMessage(req.params.messageId);
  io.to(req.params.auctionId).emit("chat:deleted", { messageId: req.params.messageId });
  res.json({ deleted: true });
});

app.post("/api/auctions/:auctionId/chat/mute", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  muteUser(req.params.auctionId, req.body.userId);
  res.json({ muted: true });
});

app.post("/api/auctions/:auctionId/chat/unmute", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  unmuteUser(req.params.auctionId, req.body.userId);
  res.json({ muted: false });
});

// ---------- Presence (event-driven, not heartbeat-driven) ----------
app.get("/api/auctions/:auctionId/presence", requireAuth, (req, res) => {
  res.json(getPresenceSummary(req.params.auctionId));
});

// ---------- Notifications (Phase 14) ----------
// Read-only history + read/unread state. Never consulted by the bidding
// engine — purely for the recipient's own inbox UI.
app.get("/api/auctions/:auctionId/notifications", requireAuth, (req, res) => {
  const unreadOnly = req.query.unreadOnly === "true";
  res.json(listNotifications(req.params.auctionId, req.userId, { unreadOnly }));
});

app.post("/api/auctions/:auctionId/notifications/:notificationId/read", requireAuth, (req, res) => {
  markRead(req.params.notificationId);
  res.json({ read: true });
});

app.post("/api/auctions/:auctionId/notifications/read-all", requireAuth, (req, res) => {
  markAllRead(req.params.auctionId, req.userId);
  res.json({ read: true });
});

// ---------- Sound settings (Phase 14) ----------
// Public read (every connected client needs this to know what to play).
// Write is Owner-only and validated server-side against the real catalog.
app.get("/api/sound-catalog", (req, res) => {
  res.json(SOUND_CATALOG);
});

app.get("/api/auctions/:auctionId/sound-settings", (req, res) => {
  res.json(getSoundSettings(req.params.auctionId));
});

app.put("/api/auctions/:auctionId/sound-settings", requireAuth, requireRole("OWNER"), (req, res) => {
  const updated = updateSoundSettings(req.params.auctionId, req.body);
  // Broadcast so every already-connected client picks up the new
  // settings live, without needing to refresh.
  io.to(req.params.auctionId).emit("soundSettings:updated", updated);
  res.json(updated);
});

app.post("/api/auctions/:auctionId/sound-settings/reset", requireAuth, requireRole("OWNER"), (req, res) => {
  const reset = resetSoundSettings(req.params.auctionId);
  io.to(req.params.auctionId).emit("soundSettings:updated", reset);
  res.json(reset);
});

// ---------- Analytics (Phase 16) — read-only, never touches bidding ----------
app.get("/api/auctions/:auctionId/analytics/live", (req, res) => {
  res.json(getLiveAnalytics(req.params.auctionId));
});

app.get("/api/auctions/:auctionId/analytics/final", (req, res) => {
  res.json(getFinalAnalytics(req.params.auctionId));
});

// ---------- Excel/CSV export (Phase 16) — Owner/Host only ----------
app.get("/api/auctions/:auctionId/export/squads.csv", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=squads.csv");
  res.send(toCSV(getSquadsRows(req.params.auctionId)));
});

app.get("/api/auctions/:auctionId/export/purchases.csv", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=purchases.csv");
  res.send(toCSV(getPurchasesRows(req.params.auctionId)));
});

app.get("/api/auctions/:auctionId/export/unsold.csv", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=unsold.csv");
  res.send(toCSV(getUnsoldRows(req.params.auctionId)));
});

app.get("/api/auctions/:auctionId/export/bid-history.csv", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=bid-history.csv");
  res.send(toCSV(getBidHistoryRows(req.params.auctionId)));
});

// Full multi-sheet .xlsx workbook — the "auction summary" export.
app.get("/api/auctions/:auctionId/export/full.xlsx", requireAuth, requireRole("HOST", "OWNER"), (req, res) => {
  try {
    const buffer = buildFullWorkbook(req.params.auctionId);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=auction-summary.xlsx");
    res.send(buffer);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Templates (Phase 17) — config only, owner-scoped ----------
app.get("/api/sound-settings/default", (req, res) => {
  res.json(getDefaultSoundSettings());
});

app.post("/api/templates", requireAuth, (req, res) => {
  try {
    res.json(createTemplate(req.userId, req.body.name, req.body.config));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/templates", requireAuth, (req, res) => {
  res.json(listTemplates(req.userId));
});

app.get("/api/templates/:templateId", requireAuth, (req, res) => {
  try {
    res.json(getTemplate(req.params.templateId, req.userId));
  } catch (e) {
    res.status(e.message.startsWith("Not authorized") ? 403 : 400).json({ error: e.message });
  }
});

app.patch("/api/templates/:templateId", requireAuth, (req, res) => {
  try {
    res.json(updateTemplate(req.params.templateId, req.userId, req.body));
  } catch (e) {
    res.status(e.message.startsWith("Not authorized") ? 403 : 400).json({ error: e.message });
  }
});

app.delete("/api/templates/:templateId", requireAuth, (req, res) => {
  try {
    deleteTemplate(req.params.templateId, req.userId);
    res.json({ deleted: true });
  } catch (e) {
    res.status(e.message.startsWith("Not authorized") ? 403 : 400).json({ error: e.message });
  }
});

const server = http.createServer(app);
console.log(
  process.env.DISABLE_RATE_LIMIT === "true"
    ? "⚠️  Rate limiting is DISABLED (DISABLE_RATE_LIMIT=true) — only for local load testing, never in production."
    : "✅ Rate limiting is ENABLED."
);
const io = new SocketServer(server, { cors: { origin: "*" } });

// ------------------------------------------------------------------
// Notification helpers — all fire-and-forget, all wrapped so a failure
// here can NEVER throw back into a bidding/sale request handler.
// ------------------------------------------------------------------
function notifyUser(auctionId, userId, type, message) {
  try {
    const n = createNotification(auctionId, userId, type, message);
    io.to(`user:${userId}`).emit("notification:new", n);
  } catch (e) {
    console.error("Notification dispatch failed (non-critical):", e.message);
  }
}

function notifyAllMembers(auctionId, type, message) {
  try {
    const members = listMembers(auctionId);
    for (const m of members) notifyUser(auctionId, m.user_id, type, message);
  } catch (e) {
    console.error("Notification fan-out failed (non-critical):", e.message);
  }
}

function notifyTeamOwners(auctionId, teamId, type, message) {
  try {
    const members = listMembers(auctionId).filter((m) => m.team_id === teamId && m.role === "TEAM_OWNER");
    for (const m of members) notifyUser(auctionId, m.user_id, type, message);
  } catch (e) {
    console.error("Notification (team) failed (non-critical):", e.message);
  }
}

function notifySoldOutcome(auctionId, playerId, winningTeamId, price) {
  try {
    notifyTeamOwners(auctionId, winningTeamId, "SOLD_OWN", `Your team won the player for ₹${price}.`);
    const members = listMembers(auctionId).filter((m) => m.role === "TEAM_OWNER" && m.team_id !== winningTeamId);
    for (const m of members) notifyUser(auctionId, m.user_id, "SOLD_OTHER", `Player sold to another team for ₹${price}.`);
  } catch (e) {
    console.error("Sold notification failed (non-critical):", e.message);
  }
}

// ------------------------------------------------------------------
// Typing indicator — PURELY in-memory, no database writes at all, per
// spec. Isolated Map keyed by auctionId, cleared on stop/timeout/
// disconnect. Never touches chat_messages or any auction table.
// ------------------------------------------------------------------
const typingUsers = new Map(); // auctionId -> Map<userId, { name, timeout }>
const TYPING_TIMEOUT_MS = 4000;

function broadcastTyping(auctionId) {
  const map = typingUsers.get(auctionId);
  const names = map ? Array.from(map.values()).map((v) => v.name) : [];
  io.to(auctionId).emit("chat:typing:update", { users: names });
}

function clearTypingForUser(auctionId, userId) {
  const map = typingUsers.get(auctionId);
  if (!map) return;
  const entry = map.get(userId);
  if (entry) {
    clearTimeout(entry.timeout);
    map.delete(userId);
    broadcastTyping(auctionId);
  }
}

// ------------------------------------------------------------------
// Voice chat — WebRTC mesh, signaled entirely over this existing
// socket connection. The server NEVER touches audio itself: it only
// relays offer/answer/ICE-candidate payloads between peers and keeps
// an in-memory roster per auction so a joining client knows who else
// to dial. No DB writes, no bidding-path interaction — same isolation
// principle as chat/presence/typing above.
// ------------------------------------------------------------------
const voiceRooms = new Map(); // auctionId -> Map<userId, { socketId, name }>

function voiceRoster(auctionId) {
  const room = voiceRooms.get(auctionId);
  if (!room) return [];
  return Array.from(room.entries()).map(([userId, v]) => ({ userId, name: v.name }));
}

function leaveVoiceRoom(auctionId, userId) {
  const room = voiceRooms.get(auctionId);
  if (!room || !room.has(userId)) return;
  room.delete(userId);
  if (room.size === 0) voiceRooms.delete(auctionId);
  io.to(auctionId).emit("voice:peer-left", { userId });
}

// Socket auth: client sends its JWT once after connecting.
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch {
    next(new Error("Unauthorized socket connection."));
  }
});

io.on("connection", (socket) => {
  // Personal room for targeted notification delivery (never a broadcast
  // to the whole auction room for something meant for one person).
  socket.join(`user:${socket.userId}`);

  socket.on("auction:join", ({ auctionId }) => {
    socket.join(auctionId);
    socket.currentAuctionId = auctionId;

    const membership = getRoleInAuction(auctionId, socket.userId);
    markOnline(auctionId, socket.userId, membership?.role, membership?.team_id);
    io.to(auctionId).emit("presence:update", { userId: socket.userId, online: true, role: membership?.role, teamId: membership?.team_id });

    // Notify the Host specifically when a Team Owner connects — not a
    // broadcast to everyone, matching the spec ("Host: Team connected").
    if (membership?.role === "TEAM_OWNER") {
      try {
        const hosts = listMembers(auctionId).filter((m) => m.role === "HOST" || m.role === "OWNER");
        const name = getUserDisplayName(socket.userId);
        for (const h of hosts) notifyUser(auctionId, h.user_id, "TEAM_CONNECTED", `${name}'s team connected.`);
      } catch (e) {
        console.error("Connect notification failed (non-critical):", e.message);
      }
    }
  });

  socket.on("disconnect", () => {
    if (socket.currentAuctionId) {
      const auctionId = socket.currentAuctionId;
      markOffline(auctionId, socket.userId);
      io.to(auctionId).emit("presence:update", { userId: socket.userId, online: false });
      clearTypingForUser(auctionId, socket.userId); // proper cleanup, no leaked typing state
      leaveVoiceRoom(auctionId, socket.userId); // drop them from the voice call too

      try {
        const membership = getRoleInAuction(auctionId, socket.userId);
        if (membership?.role === "TEAM_OWNER") {
          const hosts = listMembers(auctionId).filter((m) => m.role === "HOST" || m.role === "OWNER");
          const name = getUserDisplayName(socket.userId);
          for (const h of hosts) notifyUser(auctionId, h.user_id, "TEAM_DISCONNECTED", `${name}'s team disconnected.`);
        }
      } catch (e) {
        console.error("Disconnect notification failed (non-critical):", e.message);
      }
    }
  });

  // Bidding happens over the socket for lowest latency. THIS BLOCK IS
  // UNCHANGED FROM PHASE 4-7 except for the notification calls added
  // AFTER ack() — the ack/broadcast timing is identical to before.
  socket.on("bid:place", ({ requestId, auctionId, playerId, teamId, bidAmount }, ack) => {
    const membership = getRoleInAuction(auctionId, socket.userId);
    if (!membership || membership.role !== "TEAM_OWNER" || membership.team_id !== teamId) {
      return ack?.({ accepted: false, reason: "Not authorized to bid for this team." });
    }
    try {
      const result = placeBid({ requestId, auctionId, playerId, teamId, userId: socket.userId, bidAmount });
      ack?.(result); // <-- caller gets their result immediately, before any notification work below

      if (result.accepted) {
        io.to(auctionId).emit("bid:update", {
          playerId,
          currentBid: result.amount,
          currentBidderTeamId: teamId,
          timerEndsAt: result.timerEndsAt,
        });

        // Notifications AFTER the ack + broadcast — purely additive,
        // cannot delay or affect the bid outcome already sent above.
        notifyTeamOwners(auctionId, teamId, "BID_ACCEPTED", `Your bid of ₹${result.amount} was accepted.`);
        if (result.previousBidderTeamId && result.previousBidderTeamId !== teamId) {
          notifyTeamOwners(auctionId, result.previousBidderTeamId, "OUTBID", `You've been outbid — new bid is ₹${result.amount}.`);
        }

        // --- Auto-Bid cascade: runs AFTER the manual bid is already
        // acked and broadcast, so it can never delay the manual
        // bidder's own response. Each auto-bid step it produces goes
        // through the exact same placeBid() validation as any bid, and
        // gets broadcast/notified identically — every other client
        // simply sees a sequence of normal accepted bids.
        try {
          const autoSteps = runAutoBidCascade({ auctionId, playerId });
          let previousTeamForNotify = teamId;
          for (const step of autoSteps) {
            io.to(auctionId).emit("bid:update", {
              playerId, currentBid: step.amount, currentBidderTeamId: step.teamId, timerEndsAt: step.timerEndsAt,
            });
            notifyTeamOwners(auctionId, step.teamId, "BID_ACCEPTED", `Your auto-bid placed ₹${step.amount}.`);
            if (previousTeamForNotify && previousTeamForNotify !== step.teamId) {
              notifyTeamOwners(auctionId, previousTeamForNotify, "OUTBID", `You've been outbid by an auto-bid — new bid is ₹${step.amount}.`);
            }
            previousTeamForNotify = step.teamId;
          }
        } catch (e) {
          // Auto-bid is an enhancement layer — a failure here must never
          // affect the manual bid that already succeeded above.
          console.error("Auto-bid cascade failed (non-critical, manual bid already succeeded):", e.message);
        }
      } else if (!result.alreadyProcessed) {
        notifyTeamOwners(auctionId, teamId, "BID_REJECTED", result.reason || "Your bid was rejected.");
      }
    } catch (e) {
      ack?.({ accepted: false, reason: e.message });
    }
  });

  // --- Chat: fully separate event/table from bidding. ---
  socket.on("chat:send", ({ auctionId, teamId, type, message }) => {
    const membership = getRoleInAuction(auctionId, socket.userId);
    const isHostOrOwner = membership?.role === "HOST" || membership?.role === "OWNER";
    const senderName = getUserDisplayName(socket.userId);

    const result = sendMessage({
      auctionId,
      senderUserId: socket.userId,
      senderName,
      teamId: membership?.team_id || teamId,
      type: type === "ANNOUNCEMENT" && !isHostOrOwner ? "GLOBAL" : type,
      message,
    });

    if (result.accepted) {
      io.to(auctionId).emit("chat:message", result.chatMessage);
      clearTypingForUser(auctionId, socket.userId); // sending a message implies typing has stopped

      if (result.chatMessage.type === "ANNOUNCEMENT") {
        notifyAllMembers(auctionId, "ANNOUNCEMENT", `Host announcement: ${result.chatMessage.message}`);
      }
    } else {
      socket.emit("chat:rejected", { reason: result.reason });
    }
  });

  // --- Typing indicator: pure in-memory, no DB writes, isolated from
  // bidding and from chat message storage. ---
  socket.on("chat:typing:start", ({ auctionId }) => {
    if (!auctionId) return;
    const name = getUserDisplayName(socket.userId);
    if (!typingUsers.has(auctionId)) typingUsers.set(auctionId, new Map());
    const map = typingUsers.get(auctionId);

    const existing = map.get(socket.userId);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => clearTypingForUser(auctionId, socket.userId), TYPING_TIMEOUT_MS);
    map.set(socket.userId, { name, timeout });
    broadcastTyping(auctionId);
  });

  socket.on("chat:typing:stop", ({ auctionId }) => {
    if (!auctionId) return;
    clearTypingForUser(auctionId, socket.userId);
  });

  // --- Voice: mesh WebRTC, signaling only (server never sees/decodes audio) ---
  socket.on("voice:join", ({ auctionId }) => {
    if (!auctionId) return;
    const name = getUserDisplayName(socket.userId);
    if (!voiceRooms.has(auctionId)) voiceRooms.set(auctionId, new Map());
    const room = voiceRooms.get(auctionId);
    const existingPeers = voiceRoster(auctionId).filter((p) => p.userId !== socket.userId);
    room.set(socket.userId, { socketId: socket.id, name });
    // Tell the joiner who's already here (they'll initiate offers to each);
    // tell everyone else a new peer arrived (they'll wait for that offer).
    socket.emit("voice:roster", { peers: existingPeers });
    socket.to(auctionId).emit("voice:peer-joined", { userId: socket.userId, name });
  });

  socket.on("voice:leave", ({ auctionId }) => {
    if (auctionId) leaveVoiceRoom(auctionId, socket.userId);
  });

  // Pure relay — server forwards the SDP/ICE payload without inspecting it.
  socket.on("voice:signal", ({ auctionId, toUserId, data }) => {
    const room = voiceRooms.get(auctionId);
    const target = room?.get(toUserId);
    if (target) io.to(target.socketId).emit("voice:signal", { fromUserId: socket.userId, data });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Auction backend running on :${PORT}`));

// Phase 20: graceful shutdown. Without this, Ctrl+C or a process
// manager stopping the server just kills it mid-write — usually
// harmless with SQLite's WAL mode, but a clean db.close() checkpoints
// the WAL file back into the main database file properly and closes
// all sockets tidily instead of leaving connections hanging.
function shutdown() {
  console.log("\nShutting down gracefully...");
  io.close(() => {
    server.close(() => {
      db.close();
      console.log("Server and database closed cleanly.");
      process.exit(0);
    });
  });
  // Safety net in case something hangs — don't let shutdown block forever.
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
