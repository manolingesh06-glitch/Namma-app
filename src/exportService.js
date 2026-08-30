// src/exportService.js
// -----------------------------------------------------------------------
// Builds the export data sets (squads, purchases, unsold, bid history)
// and serializes them as CSV or a multi-sheet .xlsx workbook. All queries
// are read-only SELECTs — same non-blocking reasoning as analytics.js.

import { db } from "./db.js";
import * as XLSX from "xlsx";

export function getSquadsRows(auctionId) {
  return db
    .prepare(
      `SELECT t.name as team, p.name as player, p.role, p.country, p.category, p.sold_price as price
       FROM players p JOIN teams t ON t.id = p.sold_to_team_id
       WHERE p.auction_id = ? AND p.status = 'SOLD'
       ORDER BY t.name, p.sold_price DESC`
    )
    .all(auctionId);
}

export function getPurchasesRows(auctionId) {
  return db
    .prepare(
      `SELECT p.name as player, t.name as team, p.sold_price as price, p.category, p.role
       FROM players p JOIN teams t ON t.id = p.sold_to_team_id
       WHERE p.auction_id = ? AND p.status = 'SOLD'
       ORDER BY p.sold_price DESC`
    )
    .all(auctionId);
}

export function getUnsoldRows(auctionId) {
  return db
    .prepare(`SELECT name as player, role, country, category, base_price FROM players WHERE auction_id = ? AND status = 'UNSOLD'`)
    .all(auctionId);
}

export function getBidHistoryRows(auctionId) {
  const rows = db
    .prepare(`SELECT metadata_json, created_at FROM audit_log WHERE auction_id = ? AND type = 'BID_ACCEPTED' ORDER BY created_at ASC`)
    .all(auctionId);
  return rows.map((r) => {
    const meta = JSON.parse(r.metadata_json);
    return { playerId: meta.playerId, teamId: meta.teamId, amount: meta.amount, at: r.created_at };
  });
}

export function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    const s = String(val ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  return lines.join("\n");
}

/**
 * One .xlsx workbook, multiple sheets — the "auction summary" export.
 * Returns a Buffer suitable for sending directly as a file download.
 */
export function buildFullWorkbook(auctionId) {
  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  addSheet("Squads", getSquadsRows(auctionId));
  addSheet("Purchases", getPurchasesRows(auctionId));
  addSheet("Unsold", getUnsoldRows(auctionId));
  addSheet("BidHistory", getBidHistoryRows(auctionId));

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
