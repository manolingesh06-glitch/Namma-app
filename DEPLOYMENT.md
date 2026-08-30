DEPLOYMENT GUIDE — Cricket Auction Platform (Free Tier)
============================================================

RECOMMENDED: Render.com (free web service)
------------------------------------------------------------
Free, no credit card required, easiest for a Node.js app like this.

STEP 1 — Put your code on GitHub
  1. Create a free GitHub account if you don't have one.
  2. Create a new repository (e.g. "cricket-auction-backend").
  3. Upload the entire `cricket-auction-backend` folder to it
     (drag-and-drop on github.com works, or use `git push` if you're
     comfortable with git).

STEP 2 — Create the Render service
  1. Go to render.com, sign up (can use your GitHub account to sign in).
  2. Click "New +" -> "Web Service".
  3. Connect your GitHub repo (the one from Step 1).
  4. Fill in:
       Name:            cricket-auction (or anything)
       Region:          closest to you/your players
       Branch:          main
       Build Command:   npm install
       Start Command:   npm start
       Instance Type:   Free
  5. Under "Environment Variables", add:
       JWT_SECRET = (click "Generate" if Render offers it, or paste a
                     long random string — this is important, see below)
  6. Click "Create Web Service".

STEP 3 — Wait for it to build
  Render will run `npm install` and `npm start` automatically. Takes
  a few minutes the first time. When it says "Live", you're done.

STEP 4 — Open your auction
  Render gives you a URL like: https://cricket-auction-xxxx.onrender.com
  - Host opens:        https://cricket-auction-xxxx.onrender.com/host.html
  - Team Owners open:  https://cricket-auction-xxxx.onrender.com/team-owner.html
  Share that team-owner.html link with your 12 team owners.

------------------------------------------------------------
IMPORTANT CAVEAT — SQLite on Render's free tier
------------------------------------------------------------
Render's FREE web services do not have persistent disk storage.
This means:
  - Your database file (auction.db) is fine WHILE the server is running
    continuously during your auction.
  - If the free service "spins down" from inactivity (Render free tier
    sleeps after ~15 minutes with no traffic) and then restarts, OR if
    you redeploy, the database resets to empty.

For a single auction night where the server stays active the whole
time, this is generally fine — just don't let it sit idle for 15+
minutes before your auction starts, and avoid redeploying mid-auction.

If you want your data to survive restarts/redeploys reliably, the
next options below solve that.

------------------------------------------------------------
ALTERNATIVE — Fly.io (free allowance, persistent storage)
------------------------------------------------------------
Fly.io's free allowance includes persistent volumes, so your SQLite
file survives restarts. More setup steps than Render (requires
installing the `flyctl` command-line tool), but worth it if you want
real durability.
  1. Install flyctl (instructions at fly.io/docs/flyctl/install/).
  2. In your project folder, run: fly launch
     (follow the prompts; say yes to creating a volume for persistence)
  3. Set your secret:  fly secrets set JWT_SECRET=your-random-string
  4. Deploy:           fly deploy
Ask me for a mounted-volume config for db.js if you go this route —
the DB_PATH environment variable (already supported) makes this easy.

------------------------------------------------------------
WHY JWT_SECRET MATTERS
------------------------------------------------------------
This is the key that signs everyone's login sessions. If you leave it
at the insecure default, anyone who knows that default could forge a
valid login token for any role (including Owner). Always set a real
random value as an environment variable in production — never commit
it into your code or GitHub repo.

Generate one locally with:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

------------------------------------------------------------
BEFORE YOUR REAL AUCTION NIGHT
------------------------------------------------------------
1. Deploy a day or two early and actually test it — register accounts,
   create a test/practice-style auction, have a friend join from their
   phone, place a few bids.
2. Confirm JWT_SECRET is set (not the default).
3. Keep the service "warm" (visit the URL a few times) before your
   auction starts, especially on Render's free tier which sleeps when
   idle.
4. Have a backup plan (e.g. running it locally on your laptop as a
   hotspot server) in case hosting has issues on the night — this has
   NOT been battle-tested in a real deployment yet.
