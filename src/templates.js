// src/templates.js
// -----------------------------------------------------------------------
// Owner-scoped auction templates. A template is pure configuration —
// auction settings, team defaults, sound settings — never a live
// auction, never teams, never players. Ownership is checked server-side
// on every read/write; the frontend never decides access here.

import { db } from "./db.js";
import { v4 as uuid } from "uuid";

function assertOwnership(template, userId) {
  if (!template) throw new Error("Template not found.");
  if (template.owner_id !== userId) throw new Error("Not authorized to access this template.");
}

function serialize(row) {
  return { id: row.id, ownerId: row.owner_id, name: row.name, config: JSON.parse(row.config_json), createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * config shape:
 * {
 *   baseBid, minIncrement, timerSeconds, autoExtendSeconds,
 *   teamDefaults: { purse, squadLimit, overseasLimit },
 *   soundSettings: { masterEnabled, masterVolume, events: {...} }
 * }
 */
export function createTemplate(ownerId, name, config) {
  if (!name || !name.trim()) throw new Error("Template name is required.");
  if (!config || typeof config !== "object") throw new Error("Template configuration is required.");

  const id = uuid();
  db.prepare(
    "INSERT INTO auction_templates (id, owner_id, name, config_json) VALUES (?, ?, ?, ?)"
  ).run(id, ownerId, name.trim(), JSON.stringify(config));

  return serialize(db.prepare("SELECT * FROM auction_templates WHERE id = ?").get(id));
}

export function listTemplates(ownerId) {
  return db
    .prepare("SELECT * FROM auction_templates WHERE owner_id = ? ORDER BY updated_at DESC")
    .all(ownerId)
    .map(serialize);
}

export function getTemplate(templateId, ownerId) {
  const row = db.prepare("SELECT * FROM auction_templates WHERE id = ?").get(templateId);
  assertOwnership(row, ownerId);
  return serialize(row);
}

export function updateTemplate(templateId, ownerId, { name, config }) {
  const row = db.prepare("SELECT * FROM auction_templates WHERE id = ?").get(templateId);
  assertOwnership(row, ownerId);

  const newName = name && name.trim() ? name.trim() : row.name;
  const newConfig = config ? JSON.stringify(config) : row.config_json;

  db.prepare(
    "UPDATE auction_templates SET name = ?, config_json = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newName, newConfig, templateId);

  return serialize(db.prepare("SELECT * FROM auction_templates WHERE id = ?").get(templateId));
}

export function deleteTemplate(templateId, ownerId) {
  const row = db.prepare("SELECT * FROM auction_templates WHERE id = ?").get(templateId);
  assertOwnership(row, ownerId);
  db.prepare("DELETE FROM auction_templates WHERE id = ?").run(templateId);
}
