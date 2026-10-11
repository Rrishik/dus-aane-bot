// One parser case in full: the message, what was saved, and what the parser
// reads from the same message with today's templates.
import { parseTransactionText, validateExtraction, diffExtractions } from "../parser/index.js";
import { fromMinor } from "../util/money.js";
import { maskId } from "./queries.js";

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
    fields: evt.fields_changed ? evt.fields_changed.split(",") : [],
    saved: null,
    parser: null,
    changed: [],
    text: null,
    textError: null
  };
  if (!evt.tenant_id || !evt.channel || !evt.source_ref) {
    out.textError = "No message is linked to this event.";
    return out;
  }

  const row = await db
    .prepare(
      "SELECT s.raw_text, s.received_at, t.occurred_on, t.amount_minor, t.currency, t.direction, t.kind, " +
        "t.merchant_raw, t.merchant, t.category, t.account_last4, t.reference, t.status " +
        "FROM transaction_sources s JOIN transactions t ON t.id = s.transaction_id " +
        "WHERE s.tenant_id = ? AND s.source = ? AND s.source_ref = ?"
    )
    .bind(evt.tenant_id, evt.channel, evt.source_ref)
    .first();
  let receivedAt = (row && row.received_at) || evt.ts;
  if (row) {
    out.saved = {
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

  if (evt.channel === "sms") {
    out.text = (row && row.raw_text) || null;
    if (!out.text) out.textError = "The SMS text is no longer stored.";
  } else if (evt.channel === "email") {
    try {
      const r = await fetchEmail(evt.source_ref);
      out.text = r.text || "";
      if (r.receivedAt) receivedAt = r.receivedAt;
    } catch (e) {
      out.textError = "Couldn't fetch the email: " + ((e && e.message) || "unknown error");
    }
  }

  if (out.text) {
    let parsed = null;
    try {
      parsed = parseTransactionText(out.text, { channel: evt.channel, receivedAt: new Date(receivedAt) });
    } catch (_) {}
    if (parsed && parsed.kind === "transaction") {
      const d = validateExtraction(parsed, null, receivedAt).data;
      out.parser = {
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
      if (out.saved) out.changed = diffExtractions(out.parser.values, out.saved);
    } else {
      out.parser = {
        read: false,
        reason: parsed ? parsed.kind + (parsed.reason ? ": " + parsed.reason : "") : "parser error"
      };
    }
  }
  return out;
}
