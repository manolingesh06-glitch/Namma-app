// frontend/soundEngine.js
// -----------------------------------------------------------------------
// Synthesizes distinct short tones per sound id using the Web Audio API —
// no .mp3/.wav files to ship or host. IDs here MUST match
// src/soundSettings.js's SOUND_CATALOG on the backend.
//
// ARCHITECTURE (per spec): backend event -> state update -> realtime
// event -> client UI update -> client plays sound. This file is ONLY
// ever called AFTER a UI update, never before or during a bid request.
// Playing a sound is fire-and-forget and can never block anything.

const SOUND_SYNTH = {
  chime:  { type: "sine",     freqs: [880, 1320],      duration: 0.35 },
  beep:   { type: "square",   freqs: [660],             duration: 0.12 },
  ding:   { type: "triangle", freqs: [1046],            duration: 0.25 },
  buzz:   { type: "sawtooth", freqs: [220],             duration: 0.3 },
  alert:  { type: "square",   freqs: [523, 659, 784],   duration: 0.5 },
  horn:   { type: "sawtooth", freqs: [196, 246],        duration: 0.6 },
  pop:    { type: "sine",     freqs: [300, 150],        duration: 0.15 },
  none:   null,
};

let audioCtx = null;

// Browser autoplay policies block audio until a real user gesture.
// Call this from a click handler (e.g. the login button) before any
// sound is expected to play.
function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {}); // best-effort; never throws into caller
  }
  return audioCtx;
}

function synthesize(soundId, volume) {
  const spec = SOUND_SYNTH[soundId];
  if (!spec) return; // "none"/silent or unknown id — no-op, never an error
  try {
    const ctx = ensureAudioContext();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)) * 0.3, now); // 0.3 ceiling so tones aren't harsh
    gain.connect(ctx.destination);

    let t = now;
    const stepDuration = spec.duration / spec.freqs.length;
    for (const freq of spec.freqs) {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(freq, t);
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + stepDuration);
      t += stepDuration;
    }
    // Let the gain node decay naturally then disconnect (avoids leaking nodes over a long auction).
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration + 0.05);
    setTimeout(() => { try { gain.disconnect(); } catch {} }, (spec.duration + 0.2) * 1000);
  } catch (e) {
    console.warn("Sound playback skipped (non-critical):", e.message);
  }
}

// ---------------- Public API ----------------

const LOCAL_MUTE_KEY = "auctionSounds:localMute";
const LOCAL_VOLUME_KEY = "auctionSounds:localVolume";

export const AuctionSounds = {
  catalog: Object.keys(SOUND_SYNTH),

  unlock() {
    ensureAudioContext(); // call this from a click handler once, e.g. the login button
  },

  getLocalMute() {
    return localStorage.getItem(LOCAL_MUTE_KEY) === "true";
  },
  setLocalMute(muted) {
    localStorage.setItem(LOCAL_MUTE_KEY, muted ? "true" : "false");
  },
  getLocalVolume() {
    const v = parseFloat(localStorage.getItem(LOCAL_VOLUME_KEY));
    return isNaN(v) ? 1 : v;
  },
  setLocalVolume(v) {
    localStorage.setItem(LOCAL_VOLUME_KEY, String(v));
  },

  /**
   * Play the sound configured for a given event key, respecting:
   * auction-wide master on/off + volume, per-event on/off + chosen sound,
   * AND this device's local mute/volume (local mute always wins).
   */
  playEvent(eventKey, auctionSoundSettings) {
    if (this.getLocalMute()) return; // local mute always wins, never touches auction-wide settings
    if (!auctionSoundSettings || !auctionSoundSettings.masterEnabled) return;

    const eventCfg = auctionSoundSettings.events?.[eventKey];
    if (!eventCfg || !eventCfg.enabled) return;

    const effectiveVolume = (auctionSoundSettings.masterVolume ?? 0.8) * this.getLocalVolume();
    synthesize(eventCfg.soundId, effectiveVolume);
  },

  /** Preview a specific sound id directly, e.g. from the settings UI. */
  preview(soundId, volume = 0.8) {
    synthesize(soundId, volume);
  },
};

window.AuctionSounds = AuctionSounds; // also expose globally for plain <script> usage
