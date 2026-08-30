// src/rateLimit.js
// -----------------------------------------------------------------------
// Minimal in-memory rate limiter — no extra npm dependency needed.
// Good enough for a self-hosted, friend-scale auction; NOT a substitute
// for a real distributed rate limiter (e.g. Redis-backed) if this ever
// runs behind a load balancer with multiple server processes.

const buckets = new Map(); // key -> { count, windowStart }

export function rateLimit({ windowMs = 60_000, max = 20, keyFn = (req) => req.ip } = {}) {
  return (req, res, next) => {
    // Explicit opt-out ONLY, for local load-testing (see scripts/load-test.js
    // and package.json's "load-test" script) — the test script legitimately
    // needs to register many accounts rapidly from one machine, which looks
    // identical to a brute-force attack to this limiter. Never set this in
    // a real deployment.
    if (process.env.DISABLE_RATE_LIMIT === "true") return next();

    const key = keyFn(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart > windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      return next();
    }

    bucket.count++;
    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((windowMs - (now - bucket.windowStart)) / 1000);
      res.setHeader("Retry-After", retryAfterSec);
      return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    }
    next();
  };
}

// Periodically clear old buckets so this Map doesn't grow unbounded over
// a long-running server (a low-priority hygiene task, not on any
// critical path).
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 10 * 60_000) buckets.delete(key);
  }
}, 5 * 60_000).unref();
