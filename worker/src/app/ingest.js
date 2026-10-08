// One ingest pipeline for forwarded emails and pasted SMS:
//   dedupe by source → parser / LLM per channel + parser.mode → validate →
//   merchant rules + kind → link to an existing transaction (same payment
//   from another source) or insert → card → telemetry + activity.
//
// Result: { status, transactionId? } where status is one of
//   saved | review | linked | duplicate | ignored | failed
import {
  parseTransactionText,
  validateExtraction,
  diffExtractions,
  guessCategory,
  PARSER_AUTO_SAVE_CONFIDENCE,
  PARSER_REVIEW_CONFIDENCE
} from "../parser/index.js";
import { getMerchantRules, resolveMerchant } from "../db/merchantRules.js";
import {
  insertTransaction,
  attachSource,
  findTransactionBySource,
  findLinkCandidate,
  updateTransaction,
  getSources
} from "../db/transactions.js";
import { groupsForMember, touchActivity } from "../db/tenants.js";
import { getParserMode, getDisabledTemplates, logParserEvent } from "../db/settings.js";
import { extractWithLlm } from "./extraction.js";
import { cardText, keyboardFor } from "./cards.js";
import { categoriesFor } from "./constants.js";
import { money, formatDayMonth } from "./format.js";
import { toMinor } from "../util/money.js";
import { defaultKind } from "../util/kind.js";

const PARSED_BY_LLM = "llm";

// input: { tenant, source: "email"|"sms", sourceRef, text, receivedAt, forwarder, silent }
export async function ingest(ctx, input) {
  const { db } = ctx;
  const tenantId = String(input.tenant.id);
  const channel = input.source;
  const receivedAt = input.receivedAt || ctx.now();

  if (await findTransactionBySource(db, tenantId, channel, input.sourceRef)) return { status: "duplicate" };

  const disabled = await getDisabledTemplates(db);
  const parsed = safeParse(input.text, channel, receivedAt);
  const mode = channel === "email" ? await getParserMode(db) : "on";
  const parserTxn = parsed && parsed.kind === "transaction" && !disabled.includes(parsed.templateId) ? parsed : null;

  if (channel === "sms" && parsed && parsed.kind === "ignored" && parsed.reason === "otp") return { status: "ignored" };

  const rules = await getMerchantRules(db, tenantId);
  let extracted = null;
  let parsedBy = PARSED_BY_LLM;
  let confidence = null;
  let lowConfidence = false;

  const parserWins =
    parserTxn &&
    (channel === "sms"
      ? parserTxn.confidence >= PARSER_REVIEW_CONFIDENCE
      : mode === "on" && parserTxn.confidence >= PARSER_AUTO_SAVE_CONFIDENCE);

  if (parserWins) {
    extracted = parserTxn;
    parsedBy = parserTxn.templateId;
    confidence = parserTxn.confidence;
    lowConfidence = parserTxn.confidence < PARSER_AUTO_SAVE_CONFIDENCE;
  } else {
    let llm;
    try {
      llm = await extractWithLlm(ctx.llm, input.text, channel, rules);
    } catch (e) {
      console.error("[ingest] LLM failed:", e && e.message);
      return { status: "failed" };
    }
    if (channel === "email" && mode === "shadow" && parsed) {
      await logShadow(ctx, tenantId, parsed, llm, input, receivedAt);
    }
    if (!llm) return { status: "failed" };
    if (llm.not_a_transaction) return { status: "ignored" };
    extracted = llm;
  }

  const check = validateExtraction(extracted, input.text, receivedAt);
  const d = check.data;
  const direction = d.transaction_type === "Credit" ? "credit" : "debit";
  const allowed = categoriesFor(direction);
  const resolved = resolveMerchant(d.merchant, rules);
  let category = String(extracted.category || "").trim();
  if (resolved.category && allowed.includes(resolved.category)) {
    if (resolved.personalCategory || !category || category === "Uncategorized") category = resolved.category;
  }
  if (!allowed.includes(category)) category = guessCategory(resolved.merchant, d.transaction_type) || null;

  // The LLM may omit account/reference; the parser's read of the same text
  // has them when it saw the same amount.
  const parserFallback = parserTxn && Math.abs(parserTxn.amount - d.amount) < 0.005 ? parserTxn : {};
  const txn = {
    occurredOn: d.transaction_date,
    amountMinor: toMinor(d.amount),
    currency: d.currency,
    direction,
    kind: resolved.kind || defaultKind(direction, category),
    merchantRaw: d.merchant || null,
    merchant: resolved.merchant || null,
    category,
    accountLast4:
      String(extracted.accountLast4 || extracted.account_last4 || parserFallback.accountLast4 || "").trim() || null,
    reference: String(extracted.reference || parserFallback.reference || "").trim() || null,
    forwarder: input.forwarder || null
  };
  const source = {
    source: channel,
    sourceRef: input.sourceRef,
    parsedBy,
    confidence,
    rawText: channel === "sms" ? input.text : null,
    receivedAt
  };

  const link = await findLinkCandidate(db, tenantId, { ...txn, channel });
  if (link && (link.strength !== "amount" || input.silent)) {
    await attachSource(db, tenantId, link.transaction.id, source, ctx.now());
    const fill = {};
    if (!link.transaction.account_last4 && txn.accountLast4) fill.accountLast4 = txn.accountLast4;
    if (!link.transaction.reference && txn.reference) fill.reference = txn.reference;
    if (Object.keys(fill).length) await updateTransaction(db, tenantId, link.transaction.id, fill, ctx.now());
    return { status: "linked", transactionId: link.transaction.id };
  }

  const noDate = check.issues.includes("date_fallback") && channel === "sms";
  let reviewNote = null;
  if (link) {
    const t = link.transaction;
    reviewNote =
      "looks like a duplicate of " +
      (t.merchant || "a transaction") +
      " " +
      money(t.amount_minor, t.currency) +
      " on " +
      formatDayMonth(t.occurred_on);
  } else if (noDate) {
    reviewNote = "no date in the SMS, used today's";
  }
  const needsReview = check.needsReview || lowConfidence || noDate || !!link;
  txn.status = needsReview && !input.silent ? "review" : "confirmed";
  txn.reviewNote = txn.status === "review" ? reviewNote : null;

  const id = await insertTransaction(db, tenantId, txn, source, ctx.now());

  if (parsedBy !== PARSED_BY_LLM) {
    await logParserEvent(
      db,
      { tenantId, channel, templateId: parsedBy, event: "saved", sourceRef: input.sourceRef },
      ctx.now()
    );
  }
  if (!input.silent) await sendCard(ctx, input.tenant, id);
  if (txn.status === "confirmed" && !input.silent) await touchActivity(db, tenantId, ctx.now());
  return { status: txn.status === "review" ? "review" : "saved", transactionId: id };
}

function safeParse(text, channel, receivedAt) {
  try {
    return parseTransactionText(text, { channel, receivedAt: new Date(receivedAt) });
  } catch (e) {
    console.error("[ingest] parser threw:", e && e.message);
    return null;
  }
}

// Shadow mode: the LLM read is saved; record whether the parser agreed.
async function logShadow(ctx, tenantId, parsed, llm, input, receivedAt) {
  const llmTxn = llm && !llm.not_a_transaction;
  const parserTxn = parsed.kind === "transaction";
  if (!llm || (!llmTxn && !parserTxn)) return;
  const evt = { tenantId, channel: "email", sourceRef: input.sourceRef };
  if (parserTxn && llmTxn) {
    const changed = diffExtractions(
      validateExtraction(parsed, null, receivedAt).data,
      validateExtraction(llm, input.text, receivedAt).data
    );
    Object.assign(evt, {
      templateId: parsed.templateId,
      event: changed.length ? "shadow_mismatch" : "shadow_match",
      fieldsChanged: changed
    });
  } else if (parserTxn) {
    Object.assign(evt, { templateId: parsed.templateId, event: "shadow_extra" });
  } else {
    Object.assign(evt, {
      templateId: parsed.kind === "ignored" ? "ignored:" + parsed.reason : "(none)",
      event: "shadow_nomatch"
    });
  }
  await logParserEvent(ctx.db, evt, ctx.now());
}

// Post the transaction card to the tenant's chat and remember its message id.
export async function sendCard(ctx, tenant, transactionId) {
  const { db } = ctx;
  const tenantId = String(tenant.id);
  const txn = await db
    .prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ?")
    .bind(transactionId, tenantId)
    .first();
  if (!txn) return null;
  const [sources, groups, emailCount] = await Promise.all([
    getSources(db, tenantId, transactionId),
    groupsForMember(db, tenantId),
    db.prepare("SELECT COUNT(*) AS n FROM tenant_emails WHERE tenant_id = ?").bind(tenantId).first("n")
  ]);
  // 👤 only helps tenants with more than one forwarder.
  const user = emailCount > 1 ? txn.forwarder : null;
  const sent = await ctx.tg.sendMessage(tenantId, cardText(txn, { user }), {
    reply_markup: keyboardFor(txn, { sources, groups, isSplit: false })
  });
  if (sent && sent.message_id) {
    await updateTransaction(db, tenantId, transactionId, { cardMessageId: sent.message_id }, ctx.now());
  }
  return sent;
}
