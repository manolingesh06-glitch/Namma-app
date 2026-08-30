// src/soundSettings.js
// -----------------------------------------------------------------------
// The actual audio is synthesized client-side (Web Audio API oscillators)
// so no binary sound files need to ship with the project — see
// frontend/soundEngine.js for the matching SOUND_CATALOG ids. This file
// is the backend source of truth for: which sound ids exist, and what
// each auction's owner has configured (enabled/disabled + chosen id +
// volume) per event type.
//
// IMPORTANT: this is read on page load / settings-change only — never
// inside placeBid/sellPlayer/markUnsold. A slow client fetching this
// has zero effect on bidding.

import { db } from "./db.js";

// Keep ids in sync with frontend/soundEngine.js's SOUND_CATALOG map.
export const SOUND_CATALOG = [
  { id: "chime", label: "Chime" },
  { id: "beep", label: "Beep" },
  { id: "ding", label: "Ding" },
  { id: "buzz", label: "Buzz" },
  { id: "alert", label: "Alert" },
  { id: "horn", label: "Horn" },
  { id: "pop", label: "Pop" },
  { id: "none", label: "Silent" },
];

const EVENT_KEYS = [
  "bid", "intenseBid", "timerWarning", "sold", "unsold",
  "auctionStart", "pause", "resume", "newPlayer", "outbid",
];

function defaultSettings() {
  const events = {};
  const defaultIdByEvent = {
    bid: "beep", intenseBid: "alert", timerWarning: "buzz", sold: "chime",
    unsold: "pop", auctionStart: "horn", pause: "buzz", resume: "ding",
    newPlayer: "ding", outbid: "alert",
  };
  for (const key of EVENT_KEYS) {
    events[key] = { enabled: true, soundId: defaultIdByEvent[key] || "beep" };
  }
  return { masterEnabled: true, masterVolume: 0.8, events };
}

// Exposed for Phase 17 templates — a template needs sound defaults to
// seed its own editor before any real auction (and its sound_settings
// row) exists yet.
export function getDefaultSoundSettings() {
  return defaultSettings();
}

export function getSoundSettings(auctionId) {
  const row = db.prepare("SELECT settings_json FROM auction_sound_settings WHERE auction_id = ?").get(auctionId);
  if (!row) return defaultSettings();
  try {
    // Merge onto defaults so newly-added event keys always have a value
    // even for auctions configured before that event existed.
    const stored = JSON.parse(row.settings_json);
    const base = defaultSettings();
    return {
      masterEnabled: stored.masterEnabled ?? base.masterEnabled,
      masterVolume: stored.masterVolume ?? base.masterVolume,
      events: { ...base.events, ...(stored.events || {}) },
    };
  } catch {
    return defaultSettings();
  }
}

export function updateSoundSettings(auctionId, partial) {
  const current = getSoundSettings(auctionId);
  const merged = {
    masterEnabled: partial.masterEnabled ?? current.masterEnabled,
    masterVolume: partial.masterVolume ?? current.masterVolume,
    events: { ...current.events, ...(partial.events || {}) },
  };

  // Validate every referenced soundId is real, and every event key is known —
  // never trust the client to only send valid ids.
  const validIds = new Set(SOUND_CATALOG.map((s) => s.id));
  for (const key of Object.keys(merged.events)) {
    if (!EVENT_KEYS.includes(key)) delete merged.events[key];
    else if (!validIds.has(merged.events[key].soundId)) merged.events[key].soundId = "beep";
  }
  merged.masterVolume = Math.max(0, Math.min(1, Number(merged.masterVolume) || 0));

  db.prepare(
    `INSERT INTO auction_sound_settings (auction_id, settings_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(auction_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = datetime('now')`
  ).run(auctionId, JSON.stringify(merged));

  return merged;
}

export function resetSoundSettings(auctionId) {
  db.prepare("DELETE FROM auction_sound_settings WHERE auction_id = ?").run(auctionId);
  return defaultSettings();
}
