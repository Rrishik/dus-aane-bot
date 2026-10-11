// One parser case in full: the message, what was saved, and what the parser
// reads from the same message with today's templates. Opened from a parser
// event (dashboard cases) or a stored source (parser replay).
import { parseTransactionText, validateExtraction, diffExtractions } from "../parser/index.js";
import { fromMinor } from "../util/money.js";
import { maskId } from "./queries.js";

export const SAVED_SQL =
  "SELECT s.rowid AS source_id, s.tenant_id, s.source, s.source_ref, s.parsed_by, s.raw_text, s.received_at, " +
  "t.occurred_on, t.amount_minor, t.currency, t.direction, t.kind, t.merchant_raw, t.merchant, t.category, " +
  "t.account_last4, t.reference, t.status, n.name AS tenant_name " +
  "FROM transaction_sources s JOIN transactions t ON t.id = s.transaction_id " +
  "LEFT JOIN tenants n ON n.id = s.tenant_id ";

// fetchEmail(messageId) → { text, receivedAt }
export async function loadCase(db, id, fetchEmail) {
  const evt = await db
    .prepare(
      "SELECT rowid AS id, ts, tenant_id, channel, template_id, event, fields_changed, source_ref FROM parser_events WHERE rowid = ?"
    )
    .bind(id)
    .first();
  if (!evt) return null;
  const out = {
    id: evt.id,
    ts: evt.ts,
    event: evt.event,
    template: evt.template_id || "(none)",
    channel: evt.channel,
    user: evt.tenant_id ? await maskId("u", evt.tenant_id) : null,
    fields: evt.fields_changed ? evt.fields_changed.split(",") : []
  };
  if (!evt.tenant_id || !evt.channel || !evt.source_ref) {
    return { ...out, ...empty(), textError: "No message is linked to this event." };
  }
  const row = await db
    .prepare(SAVED_SQL + "WHERE s.tenant_id = ? AND s.source = ? AND s.source_ref = ?")
    .bind(evt.tenant_id, evt.channel, evt.source_ref)
    .first();
  return {
    ...out,
    ...(await fill(row, { channel: evt.channel, sourceRef: evt.source_ref, receivedAt: evt.ts }, fetchEmail))
  };
}

export async function loadSourceCase(db, sourceId, fetchEmail) {
  const row = await db
    .prepare(SAVED_SQL + "WHERE s.rowid = ?")
    .bind(sourceId)
    .first();
  if (!row) return null;
  return {
    id: null,
    ts: row.received_at,
    event: "replay",
    template: null,
    channel: row.source,
    user: await maskId("u", row.tenant_id),
    fields: [],
    ...(await fill(row, { channel: row.source, sourceRef: row.source_ref, receivedAt: row.received_at }, fetchEmail))
  };
}

const empty = () => ({ saved: null, parser: null, changed: [], text: null, sample: null, textError: null });

async function fill(row, { channel, sourceRef, receivedAt }, fetchEmail) {
  const out = empty();
  if (row) {
    out.saved = savedValues(row);
    receivedAt = row.received_at || receivedAt;
  }
  if (channel === "sms") {
    out.text = (row && row.raw_text) || null;
    if (!out.text) out.textError = "The SMS text is no longer stored.";
  } else if (channel === "email") {
    try {
      const r = await fetchEmail(sourceRef);
      out.text = r.text || "";
      if (r.receivedAt) receivedAt = r.receivedAt;
    } catch (e) {
      out.textError = "Couldn't fetch the email: " + ((e && e.message) || "unknown error");
    }
  }
  if (out.text) {
    out.sample = maskSample(out.text, row && row.tenant_name);
    out.parser = parserRead(out.text, channel, receivedAt);
    if (out.saved && out.parser.read) out.changed = diffExtractions(out.parser.values, out.saved);
  }
  return out;
}

export function savedValues(row) {
  return {
    transaction_date: row.occurred_on,
    amount: fromMinor(row.amount_minor),
    currency: row.currency,
    transaction_type: row.direction === "credit" ? "Credit" : "Debit",
    merchant: row.merchant_raw || row.merchant || "",
    merchant_clean: row.merchant || "",
    category: row.category || "",
    kind: row.kind,
    account_last4: row.account_last4 || "",
    reference: row.reference || "",
    status: row.status
  };
}

export function parserRead(text, channel, receivedAt) {
  let parsed = null;
  try {
    parsed = parseTransactionText(text, { channel, receivedAt: new Date(receivedAt) });
  } catch (_) {}
  if (!parsed || parsed.kind !== "transaction") {
    return { read: false, reason: parsed ? parsed.kind + (parsed.reason ? ": " + parsed.reason : "") : "no read" };
  }
  const d = validateExtraction(parsed, null, receivedAt).data;
  return {
    read: true,
    template: parsed.templateId,
    confidence: parsed.confidence,
    values: {
      transaction_date: d.transaction_date,
      amount: d.amount,
      currency: d.currency,
      transaction_type: d.transaction_type,
      merchant: d.merchant,
      account_last4: parsed.accountLast4 || "",
      reference: parsed.reference || ""
    }
  };
}

// For sharing a message's structure (e.g. to write a template): digits,
// links, email local parts, greetings and the user's name are masked.
export function maskSample(text, name) {
  let t = String(text || "")
    .replace(/https?:\/\/\S+/gi, "<link>")
    .replace(/[\w.%+-]+@([\w-]+(?:\.[\w-]+)+)/g, "x@$1")
    .replace(/^(\s*(?:dear|hi|hello)\s+)[^\n,!]+/gim, "$1Customer")
    .replace(/^(\s*to:\s*).*$/gim, "$1x");
  for (const part of String(name || "").split(/\s+/)) {
    if (part.length >= 3) t = t.replace(new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "NAME");
  }
  return t.replace(/\d/g, "9");
}
