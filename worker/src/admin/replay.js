// Parser replay: today's parser over stored email transactions, compared
// with what was saved (the LLM's read plus any user fixes). Read-only; the
// dashboard pages through it and keeps the results in the browser.
import { diffExtractions } from "../parser/index.js";
import { SAVED_SQL, savedValues, parserRead } from "./cases.js";
import { maskId } from "./queries.js";

export const REPLAY_BATCH_MAX = 25;

// fetchBodies(messageIds) → { [id]: { text, receivedAt, sender, subject } | { error } }
export async function replayBatch(db, { offset = 0, limit = 15 } = {}, fetchBodies) {
  limit = Math.min(Math.max(1, limit), REPLAY_BATCH_MAX);
  const total =
    (await db.prepare("SELECT COUNT(*) AS n FROM transaction_sources WHERE source = 'email'").first("n")) || 0;
  const rows = (
    await db
      .prepare(SAVED_SQL + "WHERE s.source = 'email' ORDER BY s.received_at DESC, s.rowid LIMIT ? OFFSET ?")
      .bind(limit, offset)
      .all()
  ).results;
  const bodies = rows.length ? await fetchBodies(rows.map((r) => r.source_ref)) : {};
  const masks = {};
  const items = [];
  for (const row of rows) {
    masks[row.tenant_id] = masks[row.tenant_id] || (await maskId("u", row.tenant_id));
    const saved = savedValues(row);
    const item = {
      sourceId: row.source_id,
      user: masks[row.tenant_id],
      receivedAt: row.received_at,
      savedBy: row.parsed_by || "imported",
      status: row.status,
      saved: pick(saved),
      sender: "",
      subject: ""
    };
    const body = bodies[row.source_ref];
    if (!body || body.error) {
      items.push({ ...item, outcome: "unavailable", reason: (body && body.error) || "not returned" });
      continue;
    }
    const read = parserRead(body.text || "", "email", body.receivedAt || row.received_at);
    Object.assign(item, { sender: body.sender || "", subject: body.subject || "" });
    if (!read.read) {
      items.push({ ...item, outcome: "missed", reason: read.reason });
      continue;
    }
    const changed = diffExtractions(read.values, saved);
    items.push({
      ...item,
      outcome: changed.length ? "disagree" : "agree",
      template: read.template,
      confidence: read.confidence,
      changed,
      parser: pick(read.values)
    });
  }
  return { total, offset, items };
}

const pick = (v) => ({
  transaction_date: v.transaction_date,
  amount: v.amount,
  currency: v.currency,
  transaction_type: v.transaction_type,
  merchant: v.merchant
});
