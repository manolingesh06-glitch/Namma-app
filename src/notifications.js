// src/notifications.js
// -----------------------------------------------------------------------
// Notifications are informational only. Nothing in auctionEngine.js
// reads this table, so a slow or failed notification write can NEVER
// delay or block a bid. Callers in server.js write these AFTER a bid/
// sale/etc. has already been committed and acknowledged to the client.

import { db } from "./db.js";
import { v4 as uuid } from "uuid";

export function createNotification(auctionId, userId, type, message) {
  const id = uuid();
  db.prepare(
    `INSERT INTO notifications (id, auction_id, user_id, type, message) VALUES (?, ?, ?, ?, ?)`
  ).run(id, auctionId, userId, type, message);
  return { id, auctionId, userId, type, message, read: false, createdAt: new Date().toISOString() };
}

export function listNotifications(auctionId, userId, { unreadOnly = false, limit = 50 } = {}) {
  let query = "SELECT * FROM notifications WHERE auction_id = ? AND user_id = ?";
  const params = [auctionId, userId];
  if (unreadOnly) query += " AND read = 0";
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  return db.prepare(query).all(...params);
}

export function markRead(notificationId) {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(notificationId);
}

export function markAllRead(auctionId, userId) {
  db.prepare("UPDATE notifications SET read = 1 WHERE auction_id = ? AND user_id = ?").run(auctionId, userId);
}
