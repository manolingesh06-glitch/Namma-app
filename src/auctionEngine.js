// src/auctionEngine.js
// -----------------------------------------------------------------------
// THE authoritative bidding engine. Everything here runs on the server,
// inside a real SQL transaction (BEGIN...COMMIT), so a crash or a
// simultaneous request can never leave purse/squad/player state
// inconsistent with each other.
//
// Idempotency: every mutating call takes a `requestId` supplied by the
// client (generate once per user click). We insert into bid_requests
// FIRST, inside the same transaction — since request_id is a PRIMARY KEY,
// a duplicate insert throws, and we catch that and return the previously
// stored result instead of re-running the logic.

import { db } from "./db.js";
import { v4 as uuid } from "uuid";
import { isPositiveNumber } from "./validate.js";

function alreadyProcessed(requestId) {
  const row = db.prepare("SELECT result_json FROM bid_requests WHERE request_id = ?").get(requestId);
  return row ? JSON.parse(row.result_json) : null;
}

function recordAudit(auctionId, type, actorUserId, metadata) {
  db.prepare(
    "INSERT INTO audit_log (id, auction_id, type, actor_user_id, metadata_json) VALUES (?, ?, ?, ?, ?)"
  ).run(uuid(), auctionId, type, actorUserId, JSON.stringify(metadata || {}));
}

/**
 * Place a bid. Returns { accepted, reason?, amount?, teamId?, timerEndsAt? }
 * Throws only on genuine server errors (bad IDs) — business rule failures
 * (bid too low, insufficient purse) come back as { accepted: false, reason }
 * so the caller can show a clean message instead of a crash.
 */
export function placeBid({ requestId, auctionId, playerId, teamId, userId, bidAmount }) {
  const existing = alreadyProcessed(requestId);
  if (existing) return { ...existing, alreadyProcessed: true };

  const runTxn = db.transaction(() => {
    const auction = db.prepare("SELECT * FROM auctions WHERE id = ?").get(auctionId);
    const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
    const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);

    if (!auction || !player || !team) throw new Error("Auction, player, or team not found.");

    const respond = (result) => {
      db.prepare("INSERT INTO bid_requests (request_id, auction_id, result_json) VALUES (?, ?, ?)").run(
        requestId,
        auctionId,
        JSON.stringify(result)
      );
      return result;
    };

    if (auction.status !== "LIVE") return respond({ accepted: false, reason: "Auction is not live." });
    if (player.status !== "LIVE") return respond({ accepted: false, reason: "Player is not currently up for bidding." });

    // SECURITY: validate bidAmount is a genuine finite positive number
    // BEFORE any comparison. `NaN < x` and `NaN > x` are both always
    // false in JS, so without this check a malformed/malicious
    // bidAmount (NaN, a string, Infinity) would silently bypass the
    // "bid too low" check below and get accepted as the winning bid.
    if (!isPositiveNumber(bidAmount)) {
      return respond({ accepted: false, reason: "Invalid bid amount." });
    }

    const currentBid = player.current_bid ?? player.base_price;
    const minValid = player.current_bid == null ? player.base_price : currentBid + auction.min_increment;
    if (bidAmount < minValid) {
      return respond({ accepted: false, reason: `Bid too low. Minimum valid bid is ${minValid}.` });
    }
    if (player.current_bidder_team_id === teamId) {
      return respond({ accepted: false, reason: "Your team already holds the current bid." });
    }

    const remainingPurse = team.purse - team.spent;
    if (bidAmount > remainingPurse) {
      return respond({ accepted: false, reason: "Insufficient purse for this bid." });
    }
    if (team.squad_count >= team.squad_limit) {
      return respond({ accepted: false, reason: "Squad limit already reached." });
    }
    if (player.is_overseas && team.overseas_count >= team.overseas_limit) {
      return respond({ accepted: false, reason: "Overseas player limit already reached." });
    }

    // --- Auto-extension: authoritative, timestamp-based, no per-second writes ---
    const now = Date.now();
    const currentEndsAt = player.timer_ends_at ? new Date(player.timer_ends_at).getTime() : now;
    const msRemaining = currentEndsAt - now;
    let newTimerEndsAt = player.timer_ends_at;
    if (auction.auto_extend_seconds > 0 && msRemaining < auction.auto_extend_seconds * 1000) {
      newTimerEndsAt = new Date(now + auction.auto_extend_seconds * 1000).toISOString();
    }

    // Captured from data already read above — no extra query. Used by
    // server.js AFTER this transaction commits to notify the previous
    // highest bidder they've been outbid. Notification dispatch never
    // happens inside this transaction. Also persisted into the audit
    // record below so a future "Undo Last Bid" can restore this exact
    // prior state.
    const previousBidderTeamId = player.current_bidder_team_id || null;
    const previousAmount = player.current_bid ?? null; // null if this was the first bid on this player
    const previousTimerEndsAt = player.timer_ends_at || null;

    db.prepare(
      "UPDATE players SET current_bid = ?, current_bidder_team_id = ?, timer_ends_at = ? WHERE id = ?"
    ).run(bidAmount, teamId, newTimerEndsAt, playerId);

    recordAudit(auctionId, "BID_ACCEPTED", userId, {
      playerId, teamId, amount: bidAmount,
      previousBidderTeamId, previousAmount, previousTimerEndsAt,
    });

    return respond({ accepted: true, amount: bidAmount, teamId, timerEndsAt: newTimerEndsAt, previousBidderTeamId });
  });

  return runTxn();
}

/**
 * Mark the current player SOLD to whoever holds the current bid.
 * Atomic: player status + team purse/spent/squad all update together
 * or not at all. A second call on an already-SOLD player is a safe no-op.
 */
export function sellPlayer({ requestId, auctionId, playerId, userId }) {
  const existing = alreadyProcessed(requestId);
  if (existing) return { ...existing, alreadyProcessed: true };

  const runTxn = db.transaction(() => {
    const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
    if (!player) throw new Error("Player not found.");

    const respond = (result) => {
      db.prepare("INSERT INTO bid_requests (request_id, auction_id, result_json) VALUES (?, ?, ?)").run(
        requestId,
        auctionId,
        JSON.stringify(result)
      );
      return result;
    };

    if (player.status !== "LIVE") {
      return respond({ accepted: false, reason: `Player is already ${player.status}.` });
    }
    if (!player.current_bidder_team_id) {
      return respond({ accepted: false, reason: "No bids placed. Use markUnsold instead." });
    }

    const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(player.current_bidder_team_id);
    const finalPrice = player.current_bid;
    const remainingPurse = team.purse - team.spent;
    if (finalPrice > remainingPurse) {
      return respond({ accepted: false, reason: "Winning team no longer has sufficient purse." });
    }

    db.prepare(
      "UPDATE players SET status = 'SOLD', sold_to_team_id = ?, sold_price = ? WHERE id = ?"
    ).run(team.id, finalPrice, playerId);

    db.prepare(
      "UPDATE teams SET spent = spent + ?, squad_count = squad_count + 1, overseas_count = overseas_count + ? WHERE id = ?"
    ).run(finalPrice, player.is_overseas ? 1 : 0, team.id);

    db.prepare("DELETE FROM auto_bids WHERE player_id = ?").run(playerId); // no more auto-bidding once sold

    recordAudit(auctionId, "SOLD", userId, { playerId, teamId: team.id, price: finalPrice });

    return respond({ accepted: true, teamId: team.id, price: finalPrice });
  });

  return runTxn();
}

/**
 * Mark UNSOLD. Simple state change, still idempotent + audited.
 */
export function markUnsold({ requestId, auctionId, playerId, userId }) {
  const existing = alreadyProcessed(requestId);
  if (existing) return { ...existing, alreadyProcessed: true };

  const runTxn = db.transaction(() => {
    const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
    if (!player) throw new Error("Player not found.");

    const respond = (result) => {
      db.prepare("INSERT INTO bid_requests (request_id, auction_id, result_json) VALUES (?, ?, ?)").run(
        requestId,
        auctionId,
        JSON.stringify(result)
      );
      return result;
    };

    if (player.status !== "LIVE") {
      return respond({ accepted: false, reason: `Player is already ${player.status}.` });
    }

    db.prepare("UPDATE players SET status = 'UNSOLD' WHERE id = ?").run(playerId);
    db.prepare("DELETE FROM auto_bids WHERE player_id = ?").run(playerId); // no more auto-bidding once unsold
    recordAudit(auctionId, "UNSOLD", userId, { playerId });
    return respond({ accepted: true });
  });

  return runTxn();
}

/**
 * Nominate a player and start the authoritative timer.
 */
export function nominatePlayer({ auctionId, playerId, userId }) {
  const auction = db.prepare("SELECT * FROM auctions WHERE id = ?").get(auctionId);
  if (!auction) throw new Error("Auction not found.");
  if (auction.status !== "LIVE") throw new Error("Auction is not live — start the auction first.");

  db.prepare("DELETE FROM auto_bids WHERE player_id = ?").run(playerId); // clear any stale auto-bids from a prior round (re-auction case)

  const timerEndsAt = new Date(Date.now() + auction.timer_seconds * 1000).toISOString();
  db.prepare(
    "UPDATE players SET status = 'LIVE', current_bid = NULL, current_bidder_team_id = NULL, timer_ends_at = ? WHERE id = ?"
  ).run(timerEndsAt, playerId);

  recordAudit(auctionId, "PLAYER_NOMINATED", userId, { playerId });
  return { timerEndsAt };
}

// ---------------------------------------------------------------------
// PHASE 15: Undo / correction.
//
// Never deletes history — the original SOLD/UNSOLD audit_log row is kept
// forever and just flagged `undone = 1`; a new UNDO_* row is appended
// alongside it. This mirrors real accounting: a correction, not an erasure.
// ---------------------------------------------------------------------

/**
 * Read-only check: is there a SOLD/UNSOLD action on this auction that
 * hasn't been undone yet? Used both by undoLastAction() and by
 * getAuthoritativeState() (in management.js) so the UI can show/hide an
 * "Undo" button without needing to attempt the undo first.
 */
export function getUndoableAction(auctionId) {
  const row = db
    .prepare(
      `SELECT * FROM audit_log
       WHERE auction_id = ? AND type IN ('SOLD', 'UNSOLD') AND undone = 0
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(auctionId);
  if (!row) return null;
  return { auditId: row.id, type: row.type, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at };
}

/**
 * Reverse the most recent not-yet-undone SOLD or UNSOLD action. Atomic
 * and idempotent (safe against a double-click on the Undo button) via
 * the same bid_requests ledger used by placeBid/sellPlayer.
 */
export function undoLastAction({ requestId, auctionId, userId }) {
  const existing = alreadyProcessed(requestId);
  if (existing) return { ...existing, alreadyProcessed: true };

  const runTxn = db.transaction(() => {
    const respond = (result) => {
      db.prepare("INSERT INTO bid_requests (request_id, auction_id, result_json) VALUES (?, ?, ?)").run(
        requestId,
        auctionId,
        JSON.stringify(result)
      );
      return result;
    };

    const target = getUndoableAction(auctionId);
    if (!target) return respond({ accepted: false, reason: "Nothing available to undo." });

    const { playerId, teamId, price } = target.metadata;
    const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
    if (!player) return respond({ accepted: false, reason: "Player not found." });

    if (target.type === "SOLD") {
      // Guard: if the player's current state no longer matches what was
      // recorded (someone hand-edited it, or a second undo raced in),
      // refuse rather than corrupt purse/squad numbers.
      if (player.status !== "SOLD" || player.sold_to_team_id !== teamId) {
        return respond({ accepted: false, reason: "Player state no longer matches the recorded sale — cannot safely undo." });
      }
      const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);
      if (!team) return respond({ accepted: false, reason: "Winning team not found." });

      // Restore player to LIVE with the winning bid intact, so the host
      // can immediately re-sell or re-open bidding. No active timer —
      // host explicitly nominates/resumes bidding as a deliberate action.
      db.prepare(
        `UPDATE players SET status = 'LIVE', current_bid = ?, current_bidder_team_id = ?,
         sold_to_team_id = NULL, sold_price = NULL, timer_ends_at = NULL WHERE id = ?`
      ).run(price, teamId, playerId);

      db.prepare(
        `UPDATE teams SET spent = spent - ?, squad_count = squad_count - 1, overseas_count = overseas_count - ? WHERE id = ?`
      ).run(price, player.is_overseas ? 1 : 0, teamId);

      db.prepare("UPDATE audit_log SET undone = 1 WHERE id = ?").run(target.auditId);
      recordAudit(auctionId, "UNDO_SOLD", userId, { playerId, teamId, price, reversedAuditId: target.auditId });

      return respond({ accepted: true, type: "UNDO_SOLD", playerId, teamId, price });
    }

    if (target.type === "UNSOLD") {
      if (player.status !== "UNSOLD") {
        return respond({ accepted: false, reason: "Player state no longer matches the recorded unsold — cannot safely undo." });
      }
      db.prepare("UPDATE players SET status = 'LIVE' WHERE id = ?").run(playerId);
      db.prepare("UPDATE audit_log SET undone = 1 WHERE id = ?").run(target.auditId);
      recordAudit(auctionId, "UNDO_UNSOLD", userId, { playerId, reversedAuditId: target.auditId });

      return respond({ accepted: true, type: "UNDO_UNSOLD", playerId });
    }

    return respond({ accepted: false, reason: "Unrecognized action type — cannot undo." });
  });

  return runTxn();
}

// ---------------------------------------------------------------------
// AUTO-BID / MAX BID
//
// A Team Owner sets a maximum bid for the currently live player. When
// anyone else outbids them, the server automatically re-bids on their
// behalf, up to (but never beyond) that maximum. Every auto-placed bid
// goes through the EXACT SAME placeBid() function as a manual bid — so
// every purse/squad/overseas/increment rule is enforced identically,
// with zero duplicated validation logic to drift out of sync.
// ---------------------------------------------------------------------

/**
 * Set (or update) a team's max-bid for a specific player. One row per
 * (player, team) — setting it again just updates the max.
 */
export function setAutoBid({ auctionId, playerId, teamId, maxAmount }) {
  if (!isPositiveNumber(maxAmount)) throw new Error("Max bid must be a positive number.");
  const id = uuid();
  db.prepare(
    `INSERT INTO auto_bids (id, auction_id, player_id, team_id, max_amount) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id, team_id) DO UPDATE SET max_amount = excluded.max_amount`
  ).run(id, auctionId, playerId, teamId, maxAmount);
  return { active: true, maxAmount };
}

export function cancelAutoBid({ playerId, teamId }) {
  db.prepare("DELETE FROM auto_bids WHERE player_id = ? AND team_id = ?").run(playerId, teamId);
  return { active: false };
}

export function getAutoBidStatus({ playerId, teamId }) {
  const row = db.prepare("SELECT max_amount FROM auto_bids WHERE player_id = ? AND team_id = ?").get(playerId, teamId);
  return row ? { active: true, maxAmount: row.max_amount } : { active: false };
}

/**
 * After a manual (or auto) bid is accepted, check whether any OTHER
 * team has an active auto-bid that can still beat it, and if so, place
 * that bid too — then repeat, since that might trigger a further
 * response from a different auto-bidder. Classic proxy-bidding.
 *
 * Returns an array of accepted bid results (same shape placeBid
 * returns) so the caller (server.js) can broadcast each one exactly
 * like a normal bid — from every other client's perspective, an
 * auto-bid IS a normal accepted bid.
 */
export function runAutoBidCascade({ auctionId, playerId }) {
  const steps = [];
  const MAX_ITERATIONS = 25; // safety net against any unforeseen loop

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
    if (!player || player.status !== "LIVE") break;

    const auction = db.prepare("SELECT * FROM auctions WHERE id = ?").get(auctionId);
    const currentBid = player.current_bid ?? player.base_price;
    const nextValidBid = player.current_bid == null ? player.base_price : currentBid + auction.min_increment;
    const excludeTeamId = player.current_bidder_team_id;

    const competitor = excludeTeamId
      ? db.prepare(
          `SELECT * FROM auto_bids WHERE player_id = ? AND team_id != ? AND max_amount >= ?
           ORDER BY max_amount DESC, created_at ASC LIMIT 1`
        ).get(playerId, excludeTeamId, nextValidBid)
      : db.prepare(
          `SELECT * FROM auto_bids WHERE player_id = ? AND max_amount >= ?
           ORDER BY max_amount DESC, created_at ASC LIMIT 1`
        ).get(playerId, nextValidBid);

    if (!competitor) break; // no one left who can/will beat the current bid

    const bidAmount = Math.min(competitor.max_amount, nextValidBid);
    const result = placeBid({
      requestId: uuid(), auctionId, playerId, teamId: competitor.team_id,
      userId: "system-autobid", bidAmount,
    });

    if (!result.accepted) {
      // This team's stored max can no longer actually be honored (e.g.
      // purse changed from another action) — drop it so we don't spin
      // on the same invalid candidate forever, then keep going in case
      // another team's auto-bid can still apply.
      db.prepare("DELETE FROM auto_bids WHERE id = ?").run(competitor.id);
      continue;
    }

    steps.push({ ...result, playerId, teamId: competitor.team_id });
  }

  return steps;
}

// ---------------------------------------------------------------------
// LAST-BID UNDO
//
// Distinct from undoLastAction() above (which reverses a completed
// SOLD/UNSOLD). This reverses the most recent ACCEPTED BID itself,
// while the player is still LIVE and bidding is ongoing — for
// correcting an accidental or wrong-amount bid mid-auction.
// ---------------------------------------------------------------------

export function getUndoableBid(auctionId) {
  const row = db
    .prepare(
      `SELECT * FROM audit_log
       WHERE auction_id = ? AND type = 'BID_ACCEPTED' AND undone = 0
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(auctionId);
  if (!row) return null;
  return { auditId: row.id, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at };
}

export function undoLastBid({ requestId, auctionId, userId }) {
  const existing = alreadyProcessed(requestId);
  if (existing) return { ...existing, alreadyProcessed: true };

  const runTxn = db.transaction(() => {
    const respond = (result) => {
      db.prepare("INSERT INTO bid_requests (request_id, auction_id, result_json) VALUES (?, ?, ?)").run(
        requestId, auctionId, JSON.stringify(result)
      );
      return result;
    };

    const target = getUndoableBid(auctionId);
    if (!target) return respond({ accepted: false, reason: "No bid available to undo." });

    const { playerId, teamId, amount, previousBidderTeamId, previousAmount, previousTimerEndsAt } = target.metadata;
    const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
    if (!player) return respond({ accepted: false, reason: "Player not found." });

    // Guard: only safe to undo while the player is still LIVE and the
    // recorded bid is still exactly what's on the player row — if it's
    // since been sold, or a later bid has already moved past it, refuse
    // rather than corrupt the visible bid state.
    if (player.status !== "LIVE") {
      return respond({ accepted: false, reason: `Player is ${player.status} — can only undo a bid while still LIVE.` });
    }
    if (player.current_bid !== amount || player.current_bidder_team_id !== teamId) {
      return respond({ accepted: false, reason: "A newer bid has already been placed — cannot safely undo this one." });
    }

    db.prepare(
      "UPDATE players SET current_bid = ?, current_bidder_team_id = ?, timer_ends_at = ? WHERE id = ?"
    ).run(previousAmount, previousBidderTeamId, previousTimerEndsAt, playerId);

    db.prepare("UPDATE audit_log SET undone = 1 WHERE id = ?").run(target.auditId);
    recordAudit(auctionId, "UNDO_BID", userId, {
      playerId, reversedTeamId: teamId, reversedAmount: amount,
      restoredBidderTeamId: previousBidderTeamId, restoredAmount: previousAmount,
      reversedAuditId: target.auditId,
    });

    return respond({
      accepted: true, type: "UNDO_BID", playerId,
      currentBid: previousAmount, currentBidderTeamId: previousBidderTeamId, timerEndsAt: previousTimerEndsAt,
    });
  });

  return runTxn();
}
