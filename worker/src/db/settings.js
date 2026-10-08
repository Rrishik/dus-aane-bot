// Runtime settings and parser telemetry.

export async function getSetting(db, key, fallback = null) {
  const value = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  return value == null ? fallback : value;
}

export async function setSetting(db, key, value, now = Date.now()) {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .bind(key, String(value), now)
    .run();
}

const PARSER_MODES = ["off", "shadow", "on"];

export async function getParserMode(db) {
  const mode = await getSetting(db, "parser.mode", "shadow");
  return PARSER_MODES.includes(mode) ? mode : "shadow";
}

export async function getDisabledTemplates(db) {
  const raw = await getSetting(db, "parser.disabledTemplates", "");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function disableTemplate(db, templateId, now = Date.now()) {
  const list = await getDisabledTemplates(db);
  if (!templateId || list.includes(templateId)) return false;
  list.push(templateId);
  await setSetting(db, "parser.disabledTemplates", list.join(","), now);
  return true;
}

// evt: { tenantId, channel, templateId, event, fieldsChanged: string[], sourceRef }
// Field names only — never amounts, merchants or message text.
export async function logParserEvent(db, evt, now = Date.now()) {
  await db
    .prepare(
      "INSERT INTO parser_events (ts, tenant_id, channel, template_id, event, fields_changed, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      now,
      evt.tenantId == null ? null : String(evt.tenantId),
      evt.channel || null,
      evt.templateId || null,
      evt.event,
      (evt.fieldsChanged || []).join(",") || null,
      evt.sourceRef == null ? null : String(evt.sourceRef)
    )
    .run();
}

export async function countParserEvents(db, { templateId, event, sinceMs }) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM parser_events WHERE template_id = ? AND event = ? AND ts >= ?")
    .bind(templateId, event, sinceMs)
    .first("n");
}

// Per-template event counts since sinceMs: { [templateId]: { [event]: n } }.
export async function parserEventSummary(db, sinceMs) {
  const rows = await db
    .prepare(
      "SELECT template_id, event, COUNT(*) AS n FROM parser_events WHERE ts >= ? AND template_id IS NOT NULL GROUP BY 1, 2"
    )
    .bind(sinceMs)
    .all();
  const out = {};
  rows.results.forEach((r) => {
    out[r.template_id] = out[r.template_id] || {};
    out[r.template_id][r.event] = r.n;
  });
  return out;
}
