# Cricket Auction Platform — Phase 1

Backend-authoritative auth + bidding engine. Runs free, locally, no cloud account needed.

## Run it

```bash
npm install
npm run dev
```

Server starts on `http://localhost:4000`.

## What's done (Phase 1–4 from the spec)

- Email/password auth (bcrypt + JWT) — `src/auth.js`
- Role-based authorization (OWNER/HOST/TEAM_OWNER/VIEWER), checked server-side — `src/auth.js`
- Real SQLite schema, separate tables per entity (no giant document) — `src/db.js`
- Atomic, idempotent bidding engine: `placeBid`, `sellPlayer`, `markUnsold`, `nominatePlayer` — `src/auctionEngine.js`
  - Purse/squad/overseas limit checks
  - Server-authoritative timer via end-timestamp (no per-second writes)
  - Basic auto-extension
  - Idempotency ledger so double-clicks/retries never double-process
- Socket.io real-time layer with per-auction rooms (selective broadcast, not global) — `src/server.js`

## What's NOT done yet (next phases)

- No seed/setup routes yet for creating an auction, teams, or players (you'll want a small admin script or routes for this next)
- No custom-bid / auto-bid (proxy bidding) logic
- No undo/correction, emergency pause, reconnect-state-sync endpoint
- No chat, voice, presence, notifications, analytics, Excel import/export
- No frontend — this is backend only

## Testing the bidding engine directly (no frontend needed yet)

You can call `placeBid`/`sellPlayer` straight from a Node REPL or a small
test script against the SQLite DB to verify behavior before building UI.

## Deploying later (still free)

Render, Railway, or Fly.io all have free tiers sufficient for a 12-team
friend auction. SQLite's file-based DB works fine there too as long as
you're on a plan with persistent disk (Render's free web services reset
disk on redeploy — for a one-night auction that's usually fine, but ask
if you want this moved to a small hosted Postgres instead, still free-tier).
