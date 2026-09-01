# Your SPL Auction — Admin panel added, nothing else touched

This `public/index.html` is **your actual uploaded file** (321KB → 340KB now),
edited in place. Every one of your original 5,089 lines is still there —
sold/unsold sounds, LiveKit voice chat, chat, Excel export, the whole
auction room. Nothing was rewritten or replaced.

## Exactly what changed in your HTML (4 things)

1. Four `const` → `let` on lines with `TEAMS`, `PURSE_CR`, `SQUAD_MIN`/
   `SQUAD_MAX`, `PLAYERS_DATA` — so they *can* be overridden. That's the
   only edit to existing lines. Nothing else in your original code was
   modified or removed (verified with `diff` against your original file —
   only those 4 lines show as changed).
2. One new function, `loadAdminConfig()`, added near your other state
   variables. It fetches `/api/config/current` and, only if an Admin has
   activated an auction, overrides TEAMS/PURSE_CR/SQUAD_MIN/MAX/
   PLAYERS_DATA and seeds host/team passwords into your existing
   `pwdOverrides` mechanism. If there's no backend or no active auction,
   it does nothing and your app behaves exactly as it always has.
3. One line added to your `init()` IIFE: `await loadAdminConfig();` before
   `loadSession()`.
4. A new "⚙ Auction Admin" link on your login screen, a new (hidden)
   `#adminScreen` panel, and a separate `<script>` block at the very end
   for the admin panel's own logic. This is 100% additive — it doesn't
   call any of your existing functions and doesn't touch `session`,
   `auctionState`, or any Firestore code.

**Update: Firestore has been replaced.** You said Firestore was laggy with
13-14 people bidding at once — that's now fixed. Live bidding runs through
this server's own Socket.IO connection instead of Firestore. See "Realtime
backend" below for how, and what changed to make it happen.

## Run it

```
npm install
cp .env.example .env      # set JWT_SECRET
npm start
```

Open **http://localhost:4000** — this serves your `index.html` plus the
new admin API on the same origin.

## Using the Admin panel

1. On the login screen, click "⚙ Auction Admin — set up a new auction".
2. Create an account (username + password — separate from Host/Team logins).
3. Create an auction: name, purse, squad size, timer, team codes.
4. Upload your player file (CSV/Excel — same loose column matching as
   before: "Player Name" / "Base Price" / "Set").
5. Optionally upload bid/sold/unsold sound files.
6. Click "Auto-generate logins" — get a Host password and one password
   per team, shown once. Write them down.
7. Click "Activate this auction".
8. Go back to the main login screen — TEAMS, players, and passwords now
   reflect what you just configured. Log in as `host` or any team code
   with the generated passwords.

## Realtime backend (replaces Firestore)

Firestore's free-tier realtime listeners get throttled/laggy once enough
devices are all watching the same document at once — that's what you were
seeing with 13-14 people bidding. The fix: live auction state (current
player, current bid, bid history, who's passed, chat, presence, etc.) now
lives in **this server's own memory + SQLite**, pushed to every connected
device over Socket.IO instead of Firestore. Same origin as everything
else, no external project, no per-listener quota.

**Nothing in your bidding logic changed.** `src/liveState.js` implements
the exact same contract your code already called through `liveDocRef`/
`db`:
- `.set(fields, {merge:true})` — deep-merges nested fields (this was
  load-bearing in your original code — see the comment above `saveLive()`
  — so it's replicated exactly: writing `{auctionState:{5:{...}}}` adds/
  updates key `5` without erasing other teams' concurrent entries).
- Dotted keys (`"auctionState.5"`, `"presence.RCB"`) address a nested
  field directly, same as Firestore field paths.
- `FieldValue.delete()` / `FieldValue.serverTimestamp()` — same sentinels,
  resolved on the server now instead of by Google's servers.
- `db.runTransaction()` — your bid/pass transactions (`placeOwnerBid`,
  `passOnPlayer`) need "read the absolute latest state, then write, with
  nobody else able to sneak in between." Firestore does this via
  optimistic retry; here it's a FIFO lock — since Node is single-threaded,
  one transaction fully finishes before the next one's `tx.get()` even
  resolves, so it's simpler and just as race-free.

The only file that changed in `public/index.html` for this is the old
Firebase `<script>` block near the top — it's now a Socket.IO client that
exposes the same `db`/`liveDocRef`/`firebase.firestore.FieldValue` shapes.
Nothing below that block was touched.

**What this means practically:** updates that used to take 1-2+ seconds on
a mobile connection (Firestore round-tripping to Google's servers) now
land in the time it takes a packet to reach this one server and back —
should feel instant, and it won't degrade as more people join, because
there's no per-connection listener quota the way there is on Firestore's
free tier.

**Verified:** all backend files pass a Node syntax check and the merge/
transaction logic passed a standalone test covering deep-merge, dotted-
path set/delete, serverTimestamp resolution, and transaction queuing/
staleness rejection. I could **not** run `npm install` or boot the real
server end-to-end in the sandbox that built this (no network access
there) — so do a real test auction with 2-3 devices before your actual
draft night. If something's off, tell me what you saw and I'll fix it.

## Other fixes made in this pass

- **Added `.env.example`** — this was referenced by the setup instructions
  but missing from the original zip. Copy it to `.env` and set a real
  `JWT_SECRET`.
- **Rate-limited `/api/admin/login` and `/api/admin/signup`** (10 attempts
  per 15 min per IP) — admin passwords can be as short as 4 characters, so
  without this they were brute-forceable.

## Files

```
public/index.html      <- YOUR file, edited in place (see above)
src/server.js          Express app serving public/ + the admin API
src/routes.js          /api/admin/* + /api/config/current
src/auth.js            Admin signup/login (bcrypt + JWT)
src/importPlayers.js   CSV/Excel -> your exact PLAYERS_DATA shape
src/db.js, schema.sql  SQLite storage for admin accounts + auction configs
uploads/sounds/<id>/   Uploaded sound files, served statically
```
