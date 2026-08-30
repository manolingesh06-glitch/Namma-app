// src/management.js
// -----------------------------------------------------------------------
// Phase 3: Auction / Team / Player management.
// Plain functions, kept separate from Express routes so they're easy to
// unit-test directly (per the spec's testing requirements).

import { db } from "./db.js";
import { v4 as uuid } from "uuid";
import { getUndoableAction, getUndoableBid } from "./auctionEngine.js";
import { isNonEmptyString, isPositiveNumber, isNonNegativeNumber } from "./validate.js";

// ---------------- Auctions ----------------

export function createAuction(ownerId, { name, baseBid = 0, minIncrement = 0, timerSeconds = 15, autoExtendSeconds = 0 }) {
  if (!name || !name.trim()) throw new Error("Auction name is required.");

  const id = uuid();
  db.prepare(
    `INSERT INTO auctions (id, name, owner_id, status, base_bid, min_increment, timer_seconds, auto_extend_seconds)
     VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)`
  ).run(id, name.trim(), ownerId, baseBid, minIncrement, timerSeconds, autoExtendSeconds);

  // Creator is automatically OWNER of their own auction.
  db.prepare(
    `INSERT INTO auction_memberships (id, auction_id, user_id, role) VALUES (?, ?, ?, 'OWNER')`
  ).run(uuid(), id, ownerId);

  return getAuction(id);
}

export function getAuction(auctionId) {
  const auction = db.prepare("SELECT * FROM auctions WHERE id = ?").get(auctionId);
  if (!auction) throw new Error("Auction not found.");
  return auction;
}

export function listAuctionsForUser(userId) {
  return db
    .prepare(
      `SELECT a.*, m.role FROM auctions a
       JOIN auction_memberships m ON m.auction_id = a.id
       WHERE m.user_id = ?
       ORDER BY a.created_at DESC`
    )
    .all(userId);
}

export function updateAuction(auctionId, fields) {
  const auction = getAuction(auctionId);
  if (auction.status === "COMPLETED" || auction.status === "CANCELLED") {
    throw new Error("Cannot edit a completed or cancelled auction.");
  }
  const allowed = ["name", "base_bid", "min_increment", "timer_seconds", "auto_extend_seconds"];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (updates.length === 0) return auction;

  const setClause = updates.map(([k]) => `${k} = ?`).join(", ");
  const values = updates.map(([, v]) => v);
  db.prepare(`UPDATE auctions SET ${setClause} WHERE id = ?`).run(...values, auctionId);
  return getAuction(auctionId);
}

export function setAuctionStatus(auctionId, status) {
  const valid = ["DRAFT", "UPCOMING", "LIVE", "PAUSED", "COMPLETED", "CANCELLED"];
  if (!valid.includes(status)) throw new Error(`Invalid status: ${status}`);
  db.prepare("UPDATE auctions SET status = ? WHERE id = ?").run(status, auctionId);
  return getAuction(auctionId);
}

export function duplicateAuction(auctionId, ownerId, newName) {
  const original = getAuction(auctionId);
  const copy = createAuction(ownerId, {
    name: newName || `${original.name} (copy)`,
    baseBid: original.base_bid,
    minIncrement: original.min_increment,
    timerSeconds: original.timer_seconds,
    autoExtendSeconds: original.auto_extend_seconds,
  });

  // Copy teams (fresh purse, no spend/squad yet).
  const teams = db.prepare("SELECT * FROM teams WHERE auction_id = ?").all(auctionId);
  for (const t of teams) {
    db.prepare(
      `INSERT INTO teams (id, auction_id, name, logo_url, purse, spent, squad_count, squad_limit, overseas_count, overseas_limit)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?)`
    ).run(uuid(), copy.id, t.name, t.logo_url, t.purse, t.squad_limit, t.overseas_limit);
  }

  // Copy players back to AVAILABLE, no bid/sale history.
  const players = db.prepare("SELECT * FROM players WHERE auction_id = ?").all(auctionId);
  for (const p of players) {
    db.prepare(
      `INSERT INTO players (id, auction_id, name, role, country, category, is_overseas, base_price, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')`
    ).run(uuid(), copy.id, p.name, p.role, p.country, p.category, p.is_overseas, p.base_price);
  }

  return getAuction(copy.id);
}

export function deleteAuction(auctionId) {
  // Cascade manually since we're not relying on foreign key cascade in SQLite by default.
  db.prepare("DELETE FROM bid_requests WHERE auction_id = ?").run(auctionId);
  db.prepare("DELETE FROM audit_log WHERE auction_id = ?").run(auctionId);
  db.prepare("DELETE FROM players WHERE auction_id = ?").run(auctionId);
  db.prepare("DELETE FROM teams WHERE auction_id = ?").run(auctionId);
  db.prepare("DELETE FROM auction_memberships WHERE auction_id = ?").run(auctionId);
  db.prepare("DELETE FROM auctions WHERE id = ?").run(auctionId);
}

// ---------------- Teams ----------------

export function addTeam(auctionId, { name, logoUrl, purse, squadLimit, overseasLimit = 0 }) {
  if (!isNonEmptyString(name)) throw new Error("Team name is required.");
  if (!isPositiveNumber(purse)) throw new Error("Team purse must be a positive number.");
  if (!isPositiveNumber(squadLimit)) throw new Error("Squad limit must be a positive number.");
  if (!isNonNegativeNumber(overseasLimit)) throw new Error("Overseas limit must be a non-negative number.");

  const id = uuid();
  db.prepare(
    `INSERT INTO teams (id, auction_id, name, logo_url, purse, spent, squad_count, squad_limit, overseas_count, overseas_limit)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?)`
  ).run(id, auctionId, name.trim(), logoUrl || null, purse, squadLimit, overseasLimit);

  return db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
}

// Bulk team import (Phase 16 — Excel/CSV). Wrapped in one transaction so
// a bad row doesn't leave a half-imported team list.
export function bulkAddTeams(auctionId, teamsArray) {
  const insert = db.prepare(
    `INSERT INTO teams (id, auction_id, name, logo_url, purse, spent, squad_count, squad_limit, overseas_count, overseas_limit)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?)`
  );
  const runAll = db.transaction((rows) => {
    const created = [];
    for (const row of rows) {
      if (!isNonEmptyString(row.name) || !isPositiveNumber(row.purse) || !isPositiveNumber(row.squadLimit)) {
        throw new Error(`Invalid team row, needs name/purse/squadLimit: ${JSON.stringify(row)}`);
      }
      const id = uuid();
      insert.run(id, auctionId, String(row.name).trim(), row.logoUrl || null, row.purse, row.squadLimit, row.overseasLimit || 0);
      created.push(id);
    }
    return created;
  });
  const ids = runAll(teamsArray);
  return ids.map((id) => db.prepare("SELECT * FROM teams WHERE id = ?").get(id));
}

export function editTeam(teamId, fields) {
  const allowed = ["name", "logo_url", "purse", "squad_limit", "overseas_limit"];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (updates.length === 0) return db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);

  const setClause = updates.map(([k]) => `${k} = ?`).join(", ");
  const values = updates.map(([, v]) => v);
  db.prepare(`UPDATE teams SET ${setClause} WHERE id = ?`).run(...values, teamId);
  return db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);
}

export function deleteTeam(teamId) {
  const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);
  if (!team) throw new Error("Team not found.");
  if (team.squad_count > 0) {
    throw new Error("Cannot delete a team that already has players — squad history would be lost.");
  }
  db.prepare("DELETE FROM auction_memberships WHERE team_id = ?").run(teamId);
  db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
}

export function listTeams(auctionId) {
  return db.prepare("SELECT * FROM teams WHERE auction_id = ?").all(auctionId);
}

// Used by notification fan-out (e.g. "notify all team owners", "find the host").
// Read-only, never touched by the bidding transaction.
export function listMembers(auctionId) {
  return db
    .prepare("SELECT user_id, role, team_id FROM auction_memberships WHERE auction_id = ?")
    .all(auctionId);
}

// Assign or reassign a Team Owner. Looks up the user by username; the
// user must already have registered an account.
export function assignTeamOwner(auctionId, teamId, username) {
  const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (!user) throw new Error("No registered user with that username. They must sign up first.");

  const existing = db
    .prepare("SELECT id FROM auction_memberships WHERE auction_id = ? AND user_id = ?")
    .get(auctionId, user.id);

  if (existing) {
    db.prepare("UPDATE auction_memberships SET role = 'TEAM_OWNER', team_id = ? WHERE id = ?").run(teamId, existing.id);
  } else {
    db.prepare(
      "INSERT INTO auction_memberships (id, auction_id, user_id, role, team_id) VALUES (?, ?, ?, 'TEAM_OWNER', ?)"
    ).run(uuid(), auctionId, user.id, teamId);
  }
  return { auctionId, teamId, userId: user.id };
}

export function removeTeamOwner(auctionId, teamId) {
  db.prepare("DELETE FROM auction_memberships WHERE auction_id = ? AND team_id = ?").run(auctionId, teamId);
}

export function assignHost(auctionId, username) {
  const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (!user) throw new Error("No registered user with that username. They must sign up first.");

  const existing = db
    .prepare("SELECT id FROM auction_memberships WHERE auction_id = ? AND user_id = ?")
    .get(auctionId, user.id);

  if (existing) {
    db.prepare("UPDATE auction_memberships SET role = 'HOST', team_id = NULL WHERE id = ?").run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO auction_memberships (id, auction_id, user_id, role) VALUES (?, ?, ?, 'HOST')"
    ).run(uuid(), auctionId, user.id);
  }
  return { auctionId, userId: user.id };
}

// ---------------- Players ----------------

export function addPlayer(auctionId, { name, role, country, category, isOverseas = false, basePrice }) {
  if (!isNonEmptyString(name)) throw new Error("Player name is required.");
  // SECURITY: was `basePrice == null || basePrice < 0`, which lets NaN
  // through (NaN == null is false, NaN < 0 is false). isNonNegativeNumber
  // correctly rejects NaN, strings, Infinity, etc.
  if (!isNonNegativeNumber(basePrice)) throw new Error("Valid base price is required.");

  const id = uuid();
  db.prepare(
    `INSERT INTO players (id, auction_id, name, role, country, category, is_overseas, base_price, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')`
  ).run(id, auctionId, name.trim(), role || null, country || null, category || null, isOverseas ? 1 : 0, basePrice);

  return db.prepare("SELECT * FROM players WHERE id = ?").get(id);
}

// Bulk import — e.g. from a parsed Excel/CSV file. Wrapped in one
// transaction so a bad row doesn't leave a half-imported player list.
export function bulkAddPlayers(auctionId, playersArray) {
  const insert = db.prepare(
    `INSERT INTO players (id, auction_id, name, role, country, category, is_overseas, base_price, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')`
  );
  const runAll = db.transaction((rows) => {
    const created = [];
    for (const row of rows) {
      if (!isNonEmptyString(row.name) || !isNonNegativeNumber(row.basePrice)) {
        throw new Error(`Invalid row, missing/invalid name or basePrice: ${JSON.stringify(row)}`);
      }
      const id = uuid();
      insert.run(id, auctionId, row.name.trim(), row.role || null, row.country || null, row.category || null, row.isOverseas ? 1 : 0, row.basePrice);
      created.push(id);
    }
    return created;
  });
  const ids = runAll(playersArray);
  return ids.map((id) => db.prepare("SELECT * FROM players WHERE id = ?").get(id));
}

export function editPlayer(playerId, fields) {
  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  if (!player) throw new Error("Player not found.");
  if (player.status === "SOLD") throw new Error("Cannot edit a player who has already been sold.");

  const allowed = ["name", "role", "country", "category", "is_overseas", "base_price"];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (updates.length === 0) return player;

  const setClause = updates.map(([k]) => `${k} = ?`).join(", ");
  const values = updates.map(([, v]) => v);
  db.prepare(`UPDATE players SET ${setClause} WHERE id = ?`).run(...values, playerId);
  return db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
}

export function deletePlayer(playerId) {
  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  if (!player) throw new Error("Player not found.");
  if (player.status === "SOLD") throw new Error("Cannot delete a player who has already been sold — mark as REMOVED instead if needed.");
  db.prepare("DELETE FROM players WHERE id = ?").run(playerId);
}

// Search / filter / sort, all server-side (never trust a client-filtered list for anything authoritative).
export function listPlayers(auctionId, { search, status, category, sortBy = "name", order = "ASC" } = {}) {
  let query = "SELECT * FROM players WHERE auction_id = ?";
  const params = [auctionId];

  if (search) {
    query += " AND name LIKE ?";
    params.push(`%${search}%`);
  }
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  if (category) {
    query += " AND category = ?";
    params.push(category);
  }

  const allowedSort = ["name", "base_price", "status", "category"];
  const sortCol = allowedSort.includes(sortBy) ? sortBy : "name";
  const sortOrder = order === "DESC" ? "DESC" : "ASC";
  query += ` ORDER BY ${sortCol} ${sortOrder}`;

  return db.prepare(query).all(...params);
}

// Re-auction: reset SOLD/UNSOLD players back to AVAILABLE (optionally with a new base price).
export function reAuctionPlayers(auctionId, playerIds, newBasePrice) {
  const runAll = db.transaction((ids) => {
    for (const id of ids) {
      const player = db.prepare("SELECT * FROM players WHERE id = ? AND auction_id = ?").get(id, auctionId);
      if (!player) continue;
      if (player.status === "SOLD") {
        throw new Error(`Player ${player.name} is SOLD — reverse the sale (undo) before re-auctioning, don't re-auction directly.`);
      }
      db.prepare(
        `UPDATE players SET status = 'AVAILABLE', current_bid = NULL, current_bidder_team_id = NULL, timer_ends_at = NULL, base_price = COALESCE(?, base_price) WHERE id = ?`
      ).run(newBasePrice ?? null, id);
    }
  });
  runAll(playerIds);
  return listPlayers(auctionId, { status: "AVAILABLE" });
}

// ---------------- Pre-auction checklist ----------------

export function preAuctionChecklist(auctionId) {
  const auction = getAuction(auctionId);
  const teams = listTeams(auctionId);
  const players = listPlayers(auctionId);
  const host = db
    // BUG FIX: this used to check ONLY for role = 'HOST', which meant an
    // Owner running their own auction solo (no separate Host account —
    // a completely normal setup) would be permanently blocked from
    // starting, since every route already treats OWNER as host-capable
    // (requireRole("HOST", "OWNER")) but the checklist didn't match that.
    .prepare("SELECT * FROM auction_memberships WHERE auction_id = ? AND role IN ('HOST', 'OWNER')")
    .get(auctionId);

  const teamsWithoutOwner = teams.filter((t) => {
    const owner = db
      .prepare("SELECT 1 FROM auction_memberships WHERE auction_id = ? AND team_id = ? AND role = 'TEAM_OWNER'")
      .get(auctionId, t.id);
    return !owner;
  });

  const checks = {
    hasTeams: teams.length > 0,
    allTeamsHaveOwners: teams.length > 0 && teamsWithoutOwner.length === 0,
    hasPlayers: players.length > 0,
    baseBidConfigured: auction.base_bid >= 0,
    incrementConfigured: auction.min_increment > 0,
    timerConfigured: auction.timer_seconds > 0,
    hostAssigned: !!host,
  };

  const ready = Object.values(checks).every(Boolean);
  return { ready, checks, teamsWithoutOwner: teamsWithoutOwner.map((t) => t.name) };
}

// ---------------- Pause / Resume (timer-aware) ----------------
// Naive pause (just flipping status) would let a paused timer keep
// counting down against its stored end-timestamp. Instead we freeze the
// REMAINING duration on pause, and recompute a fresh end-timestamp from
// that remaining duration on resume — the timer is never "wrong" even if
// the auction stays paused for an hour.

export function pauseAuction(auctionId, { emergency = false } = {}) {
  const auction = setAuctionStatus(auctionId, "PAUSED");
  const livePlayer = db
    .prepare("SELECT * FROM players WHERE auction_id = ? AND status = 'LIVE'")
    .get(auctionId);

  if (livePlayer && livePlayer.timer_ends_at) {
    const remainingMs = Math.max(0, new Date(livePlayer.timer_ends_at).getTime() - Date.now());
    db.prepare("UPDATE players SET paused_remaining_ms = ?, timer_ends_at = NULL WHERE id = ?").run(
      remainingMs,
      livePlayer.id
    );
  }

  // Emergency pause gets its own audit trail entry, distinct from a
  // routine pause, so the auction history clearly shows it happened.
  db.prepare(
    "INSERT INTO audit_log (id, auction_id, type, metadata_json) VALUES (?, ?, ?, ?)"
  ).run(uuid(), auctionId, emergency ? "EMERGENCY_PAUSE" : "PAUSE", JSON.stringify({}));

  return auction;
}

// Thin wrapper for clarity at the call site (server.js) — same
// mechanism as a routine pause, just explicitly logged as emergency.
export function emergencyPause(auctionId) {
  return pauseAuction(auctionId, { emergency: true });
}

export function resumeAuction(auctionId) {
  const auction = setAuctionStatus(auctionId, "LIVE");
  const livePlayer = db
    .prepare("SELECT * FROM players WHERE auction_id = ? AND status = 'LIVE'")
    .get(auctionId);

  if (livePlayer && livePlayer.paused_remaining_ms != null) {
    const newEndsAt = new Date(Date.now() + livePlayer.paused_remaining_ms).toISOString();
    db.prepare("UPDATE players SET timer_ends_at = ?, paused_remaining_ms = NULL WHERE id = ?").run(
      newEndsAt,
      livePlayer.id
    );
  }
  return getAuction(auctionId).status === "LIVE" ? { ...auction, livePlayerTimerEndsAt: livePlayer?.timer_ends_at } : auction;
}

// ---------------- Reconnect / Recovery ----------------
// One call a reconnecting client (any role) makes right after
// authenticating, to fully re-sync instead of trusting whatever stale
// state it had before disconnecting. Per spec: AUTHENTICATE -> FETCH
// AUTHORITATIVE STATE -> RECONCILE CLIENT -> CONTINUE.

export function getAuthoritativeState(auctionId, userId) {
  const auction = getAuction(auctionId);

  const membership = db
    .prepare("SELECT role, team_id FROM auction_memberships WHERE auction_id = ? AND user_id = ?")
    .get(auctionId, userId);

  const livePlayer = db
    .prepare("SELECT * FROM players WHERE auction_id = ? AND status = 'LIVE'")
    .get(auctionId);

  // Recent bid history for the current player only — not the whole auction's history.
  let recentBids = [];
  if (livePlayer) {
    recentBids = db
      .prepare(
        `SELECT actor_user_id, metadata_json, created_at FROM audit_log
         WHERE auction_id = ? AND type = 'BID_ACCEPTED' AND json_extract(metadata_json, '$.playerId') = ?
         ORDER BY created_at DESC LIMIT 10`
      )
      .all(auctionId, livePlayer.id)
      .map((row) => ({ ...JSON.parse(row.metadata_json), at: row.created_at }));
  }

  // Role-appropriate purse/squad visibility: everyone sees all teams'
  // public summary (name, spend, squad count) — exact purse numbers are
  // fine to show all roles here since your use case has public purses,
  // but a TEAM_OWNER always gets their own team's full row regardless.
  const teams = listTeams(auctionId);

  return {
    auction,
    role: membership?.role || "VIEWER",
    myTeamId: membership?.team_id || null,
    livePlayer,
    recentBids,
    teams,
    canUndo: !!getUndoableAction(auctionId), // Phase 15 — lets the UI show/hide the Undo button
    canUndoBid: !!getUndoableBid(auctionId), // Last-Bid Undo — lets the UI show/hide that separate button
  };
}

export function startAuction(auctionId) {
  const { ready, checks } = preAuctionChecklist(auctionId);
  if (!ready) {
    throw new Error(`Cannot start auction — checklist incomplete: ${JSON.stringify(checks)}`);
  }
  return setAuctionStatus(auctionId, "LIVE");
}
