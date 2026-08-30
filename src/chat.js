// src/chat.js
// -----------------------------------------------------------------------
// Chat is entirely separate from the auction/players/teams tables and
// from the bidding transaction. A slow moderation query or a chat flood
// can never make a bid wait, because nothing in auctionEngine.js ever
// reads or writes these tables.

import { db } from "./db.js";
import { v4 as uuid } from "uuid";

const SLOW_MODE_MS = 2000; // per-user minimum gap between messages
const lastMessageAt = new Map(); // in-memory, not DB-backed — cheap, resets on server restart, fine for slow mode

// Phase 20 fix: without this, lastMessageAt grows by one entry per
// distinct (auction, user) pair for the lifetime of the process — over
// a long-running server across many auctions, that's an unbounded
// memory leak. Stale entries (no message in 10+ minutes) are pruned
// periodically; this is pure housekeeping, never on the chat send path.
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of lastMessageAt) {
    if (now - timestamp > 10 * 60_000) lastMessageAt.delete(key);
  }
}, 5 * 60_000).unref();

export function isMuted(auctionId, userId) {
  return !!db.prepare("SELECT 1 FROM muted_users WHERE auction_id = ? AND user_id = ?").get(auctionId, userId);
}

export function muteUser(auctionId, userId) {
  db.prepare("INSERT OR IGNORE INTO muted_users (auction_id, user_id) VALUES (?, ?)").run(auctionId, userId);
}

export function unmuteUser(auctionId, userId) {
  db.prepare("DELETE FROM muted_users WHERE auction_id = ? AND user_id = ?").run(auctionId, userId);
}

/**
 * Send a chat message. Returns { accepted, message?, reason? } — never
 * throws for ordinary moderation reasons (muted, slow mode), so the
 * caller can show a clean inline reason instead of an error toast.
 */
export function sendMessage({ auctionId, senderUserId, senderName, teamId, type = "GLOBAL", message }) {
  if (!message || !message.trim()) return { accepted: false, reason: "Empty message." };
  if (message.length > 500) return { accepted: false, reason: "Message too long." };

  if (isMuted(auctionId, senderUserId)) {
    return { accepted: false, reason: "You have been muted in this auction." };
  }

  // Slow mode — skip it for SYSTEM/ANNOUNCEMENT messages (host announcements
  // shouldn't be rate-limited against themselves).
  if (type !== "SYSTEM" && type !== "ANNOUNCEMENT") {
    const key = `${auctionId}:${senderUserId}`;
    const last = lastMessageAt.get(key) || 0;
    const now = Date.now();
    if (now - last < SLOW_MODE_MS) {
      return { accepted: false, reason: "Slow down — wait a moment before sending another message." };
    }
    lastMessageAt.set(key, now);
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO chat_messages (id, auction_id, sender_user_id, sender_name, team_id, type, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, auctionId, senderUserId, senderName || null, teamId || null, type, message.trim());

  return {
    accepted: true,
    chatMessage: { id, auctionId, senderUserId, senderName, teamId, type, message: message.trim(), createdAt: new Date().toISOString() },
  };
}

export function listRecentMessages(auctionId, limit = 50) {
  return db
    .prepare(
      `SELECT * FROM chat_messages WHERE auction_id = ? AND deleted = 0
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(auctionId, limit)
    .reverse();
}

export function deleteMessage(messageId) {
  db.prepare("UPDATE chat_messages SET deleted = 1 WHERE id = ?").run(messageId);
}
