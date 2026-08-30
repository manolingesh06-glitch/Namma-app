// src/db.js
// -----------------------------------------------------------------------
// SQLite gives us real ACID transactions (BEGIN/COMMIT) with zero setup —
// no separate database server, no hosting cost, works identically on your
// laptop and on a $0 Render/Railway free tier later.
//
// Entities kept SEPARATE per the spec (no one giant document):
//   users, auctions, auction_memberships, teams, players,
//   bids, bid_requests (idempotency ledger), audit_log

import Database from "better-sqlite3";

// Configurable so automated tests (see tests/) can point at a throwaway
// file instead of the real auction.db — set DB_PATH before importing
// this module (or any module that imports it) to override.
const DB_PATH = process.env.DB_PATH || "auction.db";
export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // better concurrent read/write behavior
// NORMAL is the standard, safe pairing with WAL: SQLite still guarantees
// the database can't be corrupted by an app crash, and only risks losing
// the very last commit in the rare case of an OS crash or power loss —
// an acceptable tradeoff here in exchange for faster writes on the
// bidding critical path. (FULL is stricter but slower; not needed with WAL.)
db.pragma("synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auctions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, UPCOMING, LIVE, PAUSED, COMPLETED, CANCELLED
  base_bid INTEGER DEFAULT 0,
  min_increment INTEGER DEFAULT 0,
  timer_seconds INTEGER DEFAULT 15,
  auto_extend_seconds INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Roles a user holds within a given auction: OWNER, HOST, TEAM_OWNER, VIEWER
CREATE TABLE IF NOT EXISTS auction_memberships (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  team_id TEXT, -- set only when role = TEAM_OWNER
  UNIQUE(auction_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions(id),
  name TEXT NOT NULL,
  logo_url TEXT,
  purse INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  squad_count INTEGER NOT NULL DEFAULT 0,
  squad_limit INTEGER NOT NULL,
  overseas_count INTEGER NOT NULL DEFAULT 0,
  overseas_limit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions(id),
  name TEXT NOT NULL,
  role TEXT,
  country TEXT,
  category TEXT,
  is_overseas INTEGER NOT NULL DEFAULT 0,
  base_price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE', -- AVAILABLE, NOMINATED, LIVE, SOLD, UNSOLD, REMOVED
  current_bid INTEGER,
  current_bidder_team_id TEXT,
  sold_to_team_id TEXT,
  sold_price INTEGER,
  -- authoritative timer: store the END timestamp, never a countdown value
  timer_ends_at TEXT,
  -- when auction is PAUSED, the remaining time is frozen here and
  -- timer_ends_at is cleared, so a paused timer can't silently keep
  -- counting down against a stale timestamp
  paused_remaining_ms INTEGER
);

-- Idempotency ledger: primary key IS the client-supplied request id.
-- A second insert with the same id fails (UNIQUE), so the handler can
-- detect "already processed" and return the stored result instead of
-- redoing the work.
CREATE TABLE IF NOT EXISTS bid_requests (
  request_id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_user_id TEXT,
  metadata_json TEXT,
  undone INTEGER NOT NULL DEFAULT 0, -- Phase 15: marks a SOLD/UNSOLD entry as already reversed
  created_at TEXT DEFAULT (datetime('now'))
);

-- Phase 17: Templates. Config only — no team/player rows, no reference
-- to any real auction. Owner-scoped: owner_id must match the requester
-- on every read/write, enforced in src/templates.js.
CREATE TABLE IF NOT EXISTS auction_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
-- Chat lives in its own table, written independently of any bidding
-- transaction. A flood of chat messages never touches the players/teams
-- tables and can never block or slow down a bid.
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  sender_user_id TEXT,
  sender_name TEXT,
  team_id TEXT,               -- set for TEAM-scoped messages, null for GLOBAL/ANNOUNCEMENT
  type TEXT NOT NULL DEFAULT 'GLOBAL', -- GLOBAL, ANNOUNCEMENT, TEAM, SYSTEM
  message TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS muted_users (
  auction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  muted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (auction_id, user_id)
);

-- Presence is intentionally NOT in the auctions/players/teams tables and
-- is NOT written on a per-second heartbeat. It only changes on
-- connect/disconnect events, which are rare compared to a 1s tick.
CREATE TABLE IF NOT EXISTS presence (
  auction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT,
  team_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (auction_id, user_id)
);

-- Notifications are informational only — never required for
-- transaction correctness. A dropped or delayed notification can never
-- cause a wrong purse, wrong SOLD, or wrong bid outcome, because the
-- bidding engine never reads this table.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,       -- recipient
  type TEXT NOT NULL,          -- OUTBID, BID_ACCEPTED, BID_REJECTED, SOLD_OWN, SOLD_OTHER, AUCTION_STARTED, AUCTION_PAUSED, AUCTION_RESUMED, TEAM_CONNECTED, TEAM_DISCONNECTED
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Per-auction sound configuration. Stored as one JSON blob per auction —
-- this is UI config, never read inside the bidding transaction, so a
-- single-row read/write here can never contend with or slow a bid.
CREATE TABLE IF NOT EXISTS auction_sound_settings (
  auction_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Auto-Bid / Max Bid: one row per (player, team) — a team's standing
-- maximum for the currently live player. Cleared automatically once
-- that player is sold/unsold/re-nominated (see auctionEngine.js).
CREATE TABLE IF NOT EXISTS auto_bids (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  max_amount INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(player_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_autobids_player ON auto_bids(player_id);

-- Phase 20: indexes. Every table above was queried filtered by
-- auction_id (and sometimes status/type) with no index beyond the
-- primary key — fine at a few hundred rows, but each of these becomes
-- a full table scan as an auction's history grows over a long night.
-- These are safe, additive, and never touched by the bidding
-- transaction itself (SQLite maintains them automatically on write).
CREATE INDEX IF NOT EXISTS idx_players_auction_status ON players(auction_id, status);
CREATE INDEX IF NOT EXISTS idx_teams_auction ON teams(auction_id);
CREATE INDEX IF NOT EXISTS idx_audit_auction_type_undone ON audit_log(auction_id, type, undone);
CREATE INDEX IF NOT EXISTS idx_audit_auction_created ON audit_log(auction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_auction_created ON chat_messages(auction_id, deleted, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_auction_user_read ON notifications(auction_id, user_id, read);
CREATE INDEX IF NOT EXISTS idx_memberships_auction ON auction_memberships(auction_id);
CREATE INDEX IF NOT EXISTS idx_memberships_team ON auction_memberships(team_id);
CREATE INDEX IF NOT EXISTS idx_templates_owner ON auction_templates(owner_id);
`);
