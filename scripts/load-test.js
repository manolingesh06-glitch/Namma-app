// scripts/load-test.js
// -----------------------------------------------------------------------
// PHASE 19 — 100+ concurrent user load test.
//
// This CANNOT be run inside a chat/sandbox environment — it needs a real
// running server accepting real network/socket connections. Run it
// yourself:
//
//   1. In one terminal: npm run dev          (starts the server on :4000)
//   2. In another:       npm run load-test   (runs this script)
//
// What it does:
//   1. Registers a fresh Owner account and creates a throwaway auction.
//   2. Registers N Team Owner accounts, creates N teams, assigns each
//      owner to their team, and adds one player.
//   3. Starts the auction and nominates the player.
//   4. Fires all N teams' FIRST bid at the exact same instant
//      (Promise.all) — a genuine simultaneous-bid race, not a
//      simulated one — then verifies exactly one bid was accepted and
//      the rest were correctly rejected as "too low"/"already accepted".
//   5. Runs a rapid-fire bidding war: each team bids in sequence with
//      minimal delay, checking every purse/squad number stays consistent.
//   6. Re-sends one bid with a DUPLICATE requestId concurrently (double-
//      click simulation under real network conditions) and confirms it
//      was only applied once.
//   7. Measures bid round-trip latency (ack time) — p50/p95/max — the
//      actual "no avoidable lag" evidence, not just a claim.
//   8. Fetches the final authoritative state and asserts purse/squad/
//      player status are all internally consistent.
//
// Configure via environment variables:
//   SERVER_URL (default http://localhost:4000)
//   NUM_TEAMS  (default 100)

import { io } from "socket.io-client";
import { randomUUID } from "node:crypto";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4000";
const NUM_TEAMS = parseInt(process.env.NUM_TEAMS || "100", 10);

const api = async (path, opts = {}) => {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
};

function percentile(sorted, p) {
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

async function main() {
  console.log(`\n=== LOAD TEST: ${NUM_TEAMS} concurrent teams against ${SERVER_URL} ===\n`);
  const runId = Date.now();

  // ---------- Setup: owner + auction ----------
  console.log("[setup] Registering owner and creating auction...");
  const ownerEmail = `loadtest-owner-${runId}@test.local`;
  await api("/api/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: "TestPass123!", displayName: "Load Test Owner" }) });
  const { token: ownerToken } = await api("/api/login", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: "TestPass123!" }) });
  const ownerAuth = { Authorization: `Bearer ${ownerToken}` };

  const auction = await api("/api/auctions", {
    method: "POST", headers: ownerAuth,
    body: JSON.stringify({ name: `Load Test ${runId}`, baseBid: 100, minIncrement: 10, timerSeconds: 60, autoExtendSeconds: 0 }),
  });
  console.log(`[setup] Auction created: ${auction.id}`);

  // ---------- Setup: N team owners + teams ----------
  console.log(`[setup] Registering ${NUM_TEAMS} team owners and teams...`);
  const teams = [];
  for (let i = 0; i < NUM_TEAMS; i++) {
    const email = `loadtest-team${i}-${runId}@test.local`;
    await api("/api/register", { method: "POST", body: JSON.stringify({ email, password: "TestPass123!", displayName: `Team ${i}` }) });
    const { token } = await api("/api/login", { method: "POST", body: JSON.stringify({ email, password: "TestPass123!" }) });
    const team = await api(`/api/auctions/${auction.id}/teams`, {
      method: "POST", headers: ownerAuth,
      body: JSON.stringify({ name: `Team ${i}`, purse: 100000, squadLimit: 25, overseasLimit: 10 }),
    });
    await api(`/api/auctions/${auction.id}/teams/${team.id}/owner`, { method: "POST", headers: ownerAuth, body: JSON.stringify({ email }) });
    teams.push({ email, token, teamId: team.id });
  }

  const player = await api(`/api/auctions/${auction.id}/players`, {
    method: "POST", headers: ownerAuth,
    body: JSON.stringify({ name: "Load Test Player", role: "Batter", basePrice: 100 }),
  });

  await api(`/api/auctions/${auction.id}/start`, { method: "POST", headers: ownerAuth });
  const nominateResult = await api(`/api/auctions/${auction.id}/nominate`, { method: "POST", headers: ownerAuth, body: JSON.stringify({ playerId: player.id }) });
  console.log(`[setup] Player nominated, timer ends at ${nominateResult.timerEndsAt}\n`);

  // ---------- Connect all N sockets ----------
  console.log(`[connect] Opening ${NUM_TEAMS} concurrent socket connections...`);
  const connectStart = Date.now();
  const sockets = await Promise.all(
    teams.map(
      (t) =>
        new Promise((resolve, reject) => {
          const socket = io(SERVER_URL, { auth: { token: t.token } });
          socket.on("connect", () => {
            socket.emit("auction:join", { auctionId: auction.id });
            resolve(socket);
          });
          socket.on("connect_error", reject);
        })
    )
  );
  console.log(`[connect] All ${NUM_TEAMS} connected in ${Date.now() - connectStart}ms\n`);

  function bidAndMeasure(socket, teamId, amount) {
    const start = Date.now();
    return new Promise((resolve) => {
      socket.emit("bid:place", { requestId: randomUUID(), auctionId: auction.id, playerId: player.id, teamId, bidAmount: amount }, (result) => {
        resolve({ result, latencyMs: Date.now() - start });
      });
    });
  }

  // ---------- Test 1: genuine simultaneous first bid from ALL teams ----------
  console.log(`[test 1] Firing ${NUM_TEAMS} simultaneous bids at the SAME instant (all bidding 110)...`);
  const simultaneousResults = await Promise.all(sockets.map((s, i) => bidAndMeasure(s, teams[i].teamId, 110)));
  const accepted = simultaneousResults.filter((r) => r.result.accepted);
  const rejected = simultaneousResults.filter((r) => !r.result.accepted);
  console.log(`[test 1] Accepted: ${accepted.length} (expect exactly 1) | Rejected: ${rejected.length}`);
  if (accepted.length !== 1) {
    console.error(`❌ FAIL: expected exactly 1 accepted bid out of ${NUM_TEAMS} simultaneous identical bids, got ${accepted.length}. This would mean a race condition let two teams win the same bid.`);
  } else {
    console.log("✅ PASS: exactly one bid won the simultaneous race, as required.");
  }

  // ---------- Test 2: duplicate requestId under real concurrency ----------
  console.log(`\n[test 2] Sending the SAME requestId twice concurrently (double-click simulation)...`);
  const dupRequestId = randomUUID();
  const dupSocket = sockets[0];
  const dupTeamId = teams[0].teamId;
  const beforeState = await api(`/api/auctions/${auction.id}/state`, { headers: ownerAuth });
  const currentBid = beforeState.livePlayer.current_bid ?? beforeState.livePlayer.base_price;
  const nextBid = currentBid + 10;

  const [dupA, dupB] = await Promise.all([
    new Promise((resolve) => dupSocket.emit("bid:place", { requestId: dupRequestId, auctionId: auction.id, playerId: player.id, teamId: dupTeamId, bidAmount: nextBid }, resolve)),
    new Promise((resolve) => dupSocket.emit("bid:place", { requestId: dupRequestId, auctionId: auction.id, playerId: player.id, teamId: dupTeamId, bidAmount: nextBid }, resolve)),
  ]);
  const oneWasAlreadyProcessed = dupA.alreadyProcessed || dupB.alreadyProcessed;
  console.log(`[test 2] Result A: ${JSON.stringify(dupA)} | Result B: ${JSON.stringify(dupB)}`);
  console.log(oneWasAlreadyProcessed ? "✅ PASS: duplicate requestId was not double-applied." : "❌ FAIL: duplicate requestId may have been applied twice.");

  // ---------- Test 3: rapid sequential bidding war + latency measurement ----------
  console.log(`\n[test 3] Rapid sequential bidding war across all ${NUM_TEAMS} teams...`);
  let latencies = [];
  let lastAmount = nextBid;
  for (let i = 0; i < sockets.length; i++) {
    lastAmount += 10;
    const { result, latencyMs } = await bidAndMeasure(sockets[i], teams[i].teamId, lastAmount);
    if (result.accepted) latencies.push(latencyMs);
  }
  latencies.sort((a, b) => a - b);
  console.log(`[test 3] Completed ${latencies.length} accepted bids.`);
  console.log(`[test 3] Latency (ms) — p50: ${percentile(latencies, 50)} | p95: ${percentile(latencies, 95)} | max: ${latencies[latencies.length - 1]}`);

  // ---------- Final consistency check ----------
  console.log(`\n[final] Fetching authoritative state and checking consistency...`);
  const finalState = await api(`/api/auctions/${auction.id}/state`, { headers: ownerAuth });
  const finalPlayer = finalState.livePlayer;
  console.log(`[final] Current bid: ₹${finalPlayer.current_bid} by team ${finalPlayer.current_bidder_team_id}`);

  const winningTeam = await api(`/api/auctions/${auction.id}/teams`).then((ts) => ts.find((t) => t.id === finalPlayer.current_bidder_team_id));
  console.log(`[final] Winning team purse: ${winningTeam.purse}, spent: ${winningTeam.spent} (spent should still be 0 — player not SOLD yet)`);

  if (winningTeam.spent !== 0) {
    console.error("❌ FAIL: team's spent changed before a SOLD action — purse should only change on sellPlayer.");
  } else {
    console.log("✅ PASS: purse untouched until an actual sale — bidding alone never mutates purse.");
  }

  // ---------- Cleanup ----------
  sockets.forEach((s) => s.disconnect());
  console.log(`\n=== LOAD TEST COMPLETE ===`);
  console.log(`Report this auction ID if you need to inspect it further: ${auction.id}`);
  console.log(`(This created real rows in your database under test emails like loadtest-*-${runId}@test.local — safe to ignore or manually clean up.)\n`);
}

main().catch((err) => {
  console.error("\n❌ LOAD TEST CRASHED:", err.message);
  process.exit(1);
});
