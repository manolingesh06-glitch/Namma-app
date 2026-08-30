// src/validate.js
// -----------------------------------------------------------------------
// Small, dependency-free validation helpers. Used server-side wherever
// a number or string arrives from a client — NEVER trust that a client
// (browser, curl, a modified frontend) sent a well-formed value.

// Username rules: 3-20 chars, letters/numbers/underscore only. Simple and
// predictable — no email format confusion, no "must already have an
// account" email lookups for team owner / host assignment.
export function isValidUsername(username) {
  return typeof username === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

export function isNonEmptyString(value, maxLength = 200) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

// Rejects NaN, Infinity, strings, null, undefined, booleans — anything
// that isn't a genuine finite number. This matters more than it looks:
// `NaN < x` and `NaN > x` are BOTH always false, so a naive
// `if (amount < minimum) reject()` check silently lets NaN through.
export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

export function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}
