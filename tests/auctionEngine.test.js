// tests/auctionEngine.test.js
// -----------------------------------------------------------------------
// Run with: npm test  (after `npm install`)
// Uses Node's built-in test runner (node:test) — zero extra dependencies.
//
// IMPORTANT: sets DB_PATH to a throwaway file BEFORE importing db.js (or
// anything that imports it), so these tests never touch your real
// auction.db. The file is deleted at the end of the run.

import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import { v4 as uuid } from "uuid";

const TEST_DB_PATH = "test-auction.db";
process.env.DB_PATH = TEST_DB_PATH;

const { db } = await import("../src/db.js");
const { placeBid, sellPlayer, markUnsold, undoLastAction } = await import("../src/auctionEngine.js");

// ---------------- Test fixtures ----------------
// auctions.owner_id has a FOREIGN KEY REFERENCES users(id), and
// better-sqlite3 enforces foreign keys by default — so the referenced
// user must exist before an auction can point at it. We reuse the same
// owner-1 row across tests rather than inserting it fresh every time.
let ownerSeeded = false;
function seedOwnerUser() {
  if (ownerSeeded) return;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name) VALUES ('owner-1', 'test_owner', 'x', 'Test Owner')`
  ).run();
  ownerSeeded = true;
}

function seedAuction({ minIncrement = 50, autoExtendSeconds = 0, status = "LIVE" } = {}) {
  seedOwnerUser();
  const auctionId = uuid();
  db.prepare(
    `INSERT INTO auctions (id, name, owner_id, status, base_bid, min_increment, timer_seconds, auto_extend_seconds)
     VALUES (?, 'Test Auction', 'owner-1', ?, 100, ?, 15, ?)`
  ).run(auctionId, status, minIncrement, autoExtendSeconds);
  return auctionId;
}

function seedTeam(auctionId, { purse = 1000, spent = 0, squadCount = 0, squadLimit = 5, overseasCount = 0, overseasLimit = 2 } = {}) {
  const teamId = uuid();
  db.prepare(
    `INSERT INTO teams (id, auction_id, name, purse, spent, squad_count, squad_limit, overseas_count, overseas_limit)
     VALUES (?, ?, 'Test Team', ?, ?, ?, ?, ?, ?)`
  ).run(teamId, auctionId, purse, spent, squadCount, squadLimit, overseasCount, overseasLimit);
  return teamId;
}

function seedPlayer(auctionId, { basePrice = 100, status = "LIVE", isOverseas = 0 } = {}) {
  const playerId = uuid();
  db.prepare(
    `INSERT INTO players (id, auction_id, name, base_price, status, is_overseas) VALUES (?, ?, 'Test Player', ?, ?, ?)`
  ).run(playerId, auctionId, basePrice, status, isOverseas);
  return playerId;
}

// ---------------- Tests ----------------

test("placeBid rejects a non-numeric bid amount (NaN-bypass regression test)", () => {
  const auctionId = seedAuction();
  const teamId = seedTeam(auctionId);
  const playerId = seedPlayer(auctionId);

  const result = placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: NaN });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /invalid bid amount/i);
});

test("placeBid rejects a bid below the minimum increment", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamA = seedTeam(auctionId);
  const teamB = seedTeam(auctionId);
  const playerId = seedPlayer(auctionId, { basePrice: 100 });

  // Establish a first bid at base price (no increment required on the
  // opening bid — that's the auction's actual rule, mirrored in
  // runAutoBidCascade too).
  const first = placeBid({ requestId: uuid(), auctionId, playerId, teamId: teamA, userId: "user-1", bidAmount: 100 });
  assert.equal(first.accepted, true);

  // A different team now bids only 10 more, short of the 50 increment.
  const result = placeBid({ requestId: uuid(), auctionId, playerId, teamId: teamB, userId: "user-2", bidAmount: 110 });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /too low/i);
});

test("placeBid accepts a valid bid and updates player state atomically", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamId = seedTeam(auctionId);
  const playerId = seedPlayer(auctionId, { basePrice: 100 });

  const result = placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: 150 });
  assert.equal(result.accepted, true);
  assert.equal(result.amount, 150);

  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  assert.equal(player.current_bid, 150);
  assert.equal(player.current_bidder_team_id, teamId);
});

test("placeBid is idempotent — same requestId twice only applies once", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamId = seedTeam(auctionId);
  const playerId = seedPlayer(auctionId, { basePrice: 100 });
  const requestId = uuid();

  const first = placeBid({ requestId, auctionId, playerId, teamId, userId: "user-1", bidAmount: 150 });
  const second = placeBid({ requestId, auctionId, playerId, teamId, userId: "user-1", bidAmount: 150 });

  assert.equal(first.accepted, true);
  assert.equal(second.alreadyProcessed, true);

  // Confirm it wasn't somehow applied twice (e.g. double-counted anywhere).
  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  assert.equal(player.current_bid, 150);
});

test("placeBid rejects when team has insufficient purse", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamId = seedTeam(auctionId, { purse: 100, spent: 0 });
  const playerId = seedPlayer(auctionId, { basePrice: 100 });

  const result = placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: 150 });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /purse/i);
});

test("sellPlayer prevents a duplicate sale (double-click / race protection)", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamId = seedTeam(auctionId, { purse: 1000 });
  const playerId = seedPlayer(auctionId, { basePrice: 100 });

  placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: 150 });

  const firstSale = sellPlayer({ requestId: uuid(), auctionId, playerId, userId: "host-1" });
  assert.equal(firstSale.accepted, true);

  const secondSale = sellPlayer({ requestId: uuid(), auctionId, playerId, userId: "host-1" });
  assert.equal(secondSale.accepted, false);
  assert.match(secondSale.reason, /already SOLD/i);

  const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);
  assert.equal(team.spent, 150); // NOT double-charged
  assert.equal(team.squad_count, 1); // NOT double-counted
});

test("sellPlayer atomically updates purse, squad count, and player status together", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamId = seedTeam(auctionId, { purse: 1000, squadCount: 2 });
  const playerId = seedPlayer(auctionId, { basePrice: 100, isOverseas: 1 });

  placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: 200 });
  const sale = sellPlayer({ requestId: uuid(), auctionId, playerId, userId: "host-1" });
  assert.equal(sale.accepted, true);

  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);

  assert.equal(player.status, "SOLD");
  assert.equal(player.sold_price, 200);
  assert.equal(team.spent, 200);
  assert.equal(team.squad_count, 3);
  assert.equal(team.overseas_count, 1);
});

test("undoLastAction reverses a SOLD transaction completely (purse, squad, status)", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamId = seedTeam(auctionId, { purse: 1000, squadCount: 2, overseasCount: 1 });
  const playerId = seedPlayer(auctionId, { basePrice: 100, isOverseas: 1 });

  placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: 200 });
  sellPlayer({ requestId: uuid(), auctionId, playerId, userId: "host-1" });

  const undoResult = undoLastAction({ requestId: uuid(), auctionId, userId: "host-1" });
  assert.equal(undoResult.accepted, true);
  assert.equal(undoResult.type, "UNDO_SOLD");

  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);

  assert.equal(player.status, "LIVE"); // restored, not stuck SOLD
  assert.equal(player.sold_price, null);
  assert.equal(team.spent, 0); // fully reversed
  assert.equal(team.squad_count, 2); // back to pre-sale count
  assert.equal(team.overseas_count, 1);

  // Original SOLD audit row must still exist (never deleted), just flagged undone.
  const originalSoldRow = db.prepare("SELECT * FROM audit_log WHERE auction_id = ? AND type = 'SOLD'").get(auctionId);
  assert.equal(originalSoldRow.undone, 1);
});

test("undoLastAction refuses to double-undo the same sale", () => {
  const auctionId = seedAuction({ minIncrement: 50 });
  const teamId = seedTeam(auctionId, { purse: 1000 });
  const playerId = seedPlayer(auctionId, { basePrice: 100 });

  placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: 200 });
  sellPlayer({ requestId: uuid(), auctionId, playerId, userId: "host-1" });
  undoLastAction({ requestId: uuid(), auctionId, userId: "host-1" });

  const secondUndo = undoLastAction({ requestId: uuid(), auctionId, userId: "host-1" });
  assert.equal(secondUndo.accepted, false);
  assert.match(secondUndo.reason, /nothing available to undo/i);
});

test("markUnsold refuses to act on a player that isn't LIVE", () => {
  const auctionId = seedAuction();
  const playerId = seedPlayer(auctionId, { status: "SOLD" });

  const result = markUnsold({ requestId: uuid(), auctionId, playerId, userId: "host-1" });
  assert.equal(result.accepted, false);
});

test("auto-extension pushes the timer out when a bid lands near expiry", () => {
  const auctionId = seedAuction({ minIncrement: 50, autoExtendSeconds: 10 });
  const teamId = seedTeam(auctionId);
  const playerId = seedPlayer(auctionId, { basePrice: 100 });

  // Simulate a timer about to expire (1 second left).
  const almostExpired = new Date(Date.now() + 1000).toISOString();
  db.prepare("UPDATE players SET timer_ends_at = ? WHERE id = ?").run(almostExpired, playerId);

  const result = placeBid({ requestId: uuid(), auctionId, playerId, teamId, userId: "user-1", bidAmount: 150 });
  assert.equal(result.accepted, true);

  const newRemainingMs = new Date(result.timerEndsAt).getTime() - Date.now();
  assert.ok(newRemainingMs > 8000, "timer should have been extended to roughly 10s remaining");
});

// ---------------- Cleanup ----------------
test("cleanup: remove the test database file", () => {
  db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  if (existsSync(TEST_DB_PATH + "-wal")) unlinkSync(TEST_DB_PATH + "-wal");
  if (existsSync(TEST_DB_PATH + "-shm")) unlinkSync(TEST_DB_PATH + "-shm");
});
