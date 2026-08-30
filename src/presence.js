// src/presence.js
// -----------------------------------------------------------------------
// Presence updates ONLY on socket connect/disconnect — never a 1-second
// heartbeat, and never a write to the players/teams/auctions tables.
// A hundred users' connection churn can never slow down a bid, because
// this table isn't read or written anywhere in auctionEngine.js.

import { db } from "./db.js";

export function markOnline(auctionId, userId, role, teamId) {
  db.prepare(
    `INSERT INTO presence (auction_id, user_id, role, team_id, online, last_seen_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(auction_id, user_id) DO UPDATE SET online = 1, role = excluded.role, team_id = excluded.team_id, last_seen_at = datetime('now')`
  ).run(auctionId, userId, role || null, teamId || null);
}

export function markOffline(auctionId, userId) {
  db.prepare(
    `UPDATE presence SET online = 0, last_seen_at = datetime('now') WHERE auction_id = ? AND user_id = ?`
  ).run(auctionId, userId);
}

export function getPresenceSummary(auctionId) {
  const rows = db.prepare("SELECT * FROM presence WHERE auction_id = ?").all(auctionId);
  const onlineCount = rows.filter((r) => r.online).length;
  const teamsOnline = {};
  for (const r of rows) {
    if (r.team_id) teamsOnline[r.team_id] = teamsOnline[r.team_id] || r.online === 1;
  }
  const hostOnline = rows.some((r) => r.role === "HOST" && r.online);
  return { onlineCount, teamsOnline, hostOnline, rows };
}
