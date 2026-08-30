// src/auth.js
// -----------------------------------------------------------------------
// Username + password auth only (no email, no Google/OTP, per spec).
// Passwords hashed with bcrypt. Sessions are JWTs. Role checks happen
// HERE, server-side — never trust a role sent from the client.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { db } from "./db.js";
import { isValidUsername } from "./validate.js";

export const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me"; // set a real env var in production
const TOKEN_EXPIRY = "12h";

// SECURITY: a hardcoded fallback JWT secret means anyone who reads this
// source (or knows it's the default) can forge valid tokens for ANY
// user/role. This is fine for local testing, never for a real deployment.
if (!process.env.JWT_SECRET) {
  console.warn(
    "\n⚠️  WARNING: JWT_SECRET is not set — using an insecure default.\n" +
    "   Anyone who knows this default can forge login tokens.\n" +
    "   Set a real secret before exposing this server beyond your own machine:\n" +
    "   e.g. JWT_SECRET=$(openssl rand -hex 32) npm run dev\n"
  );
}

export function registerUser(username, password, displayName) {
  if (!isValidUsername(username)) {
    throw new Error("Username must be 3-20 characters: letters, numbers, underscore only.");
  }
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) throw new Error("Username already taken.");

  const id = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(
    "INSERT INTO users (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)"
  ).run(id, username, passwordHash, displayName || null);

  return { id, username, displayName };
}

export function loginUser(username, password) {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) throw new Error("Invalid username or password.");

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) throw new Error("Invalid username or password.");

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });
  return { token, user: { id: user.id, username: user.username, displayName: user.display_name } };
}

// Express middleware: verifies JWT, attaches req.userId
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token." });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// Looks up the caller's role WITHIN a specific auction. This is the
// server-side source of truth for permissions — the frontend never
// decides this.
export function getRoleInAuction(auctionId, userId) {
  const row = db
    .prepare("SELECT role, team_id FROM auction_memberships WHERE auction_id = ? AND user_id = ?")
    .get(auctionId, userId);
  return row || null; // null = not a member at all (treat as no access / viewer-only if public)
}

// Used by chat/typing/notifications so people see a real name instead of
// a raw user id. Falls back to username, then the id itself.
export function getUserDisplayName(userId) {
  const user = db.prepare("SELECT display_name, username FROM users WHERE id = ?").get(userId);
  if (!user) return userId;
  return user.display_name || user.username || userId;
}

// Express middleware factory: requireRole('OWNER'), requireRole('HOST', 'OWNER'), etc.
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const auctionId = req.params.auctionId || req.body.auctionId;
    const membership = getRoleInAuction(auctionId, req.userId);
    if (!membership || !allowedRoles.includes(membership.role)) {
      return res.status(403).json({ error: "You do not have permission for this action." });
    }
    req.membership = membership;
    next();
  };
}
