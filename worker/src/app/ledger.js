// Unified transaction-mutation & merchant-rule learning service.
//
// Used by inline card buttons, swipe-replies, the untagged stepper, the LLM
// orchestrator tools, and (in Stage 2) the Telegram Mini App REST API so
// validation, rule learning, untagged backfilling, card edits, group split
// posts, and personal DM pins stay consistent everywhere.
import {
  getTransaction,
  getSources,
  updateTransaction,
  softDeleteTransaction,
  listUntaggedTransactions
} from "../db/transactions.js";
import { getSplitForTransaction, getSettlementForTransaction } from "../db/splits.js";
import { getMerchantRules, resolveMerchant, upsertMerchantRule } from "../db/merchantRules.js";
import { logParserEvent } from "../db/settings.js";
import { guessCategory, PARSER_MAX_AMOUNT } from "../parser/index.js";
import { refreshCardMessage } from "./cardState.js";
import { refreshSplitGroupMessage } from "./groups.js";
import { refreshPersonalPin } from "./personalPin.js";
import { categoriesFor, TAG_MAX_LEN } from "./constants.js";
import { defaultKind } from "../util/kind.js";
import { toMinor, fromMinor } from "../util/money.js";

// "bundl tech 12345" → "bundl tech": one rule covers numbered payee variants.
export function shortenMerchantPattern(raw) {
  if (!raw) return raw;
  const trimmed = String(raw)
    .replace(/[\s_\-#.]+\d[\d\s_\-#.]*$/, "")
    .trim();
  return trimmed || raw;
}

export async function teachCategoryRules(db, tenantId, txn, category, now) {
  const seen = new Set();
  for (const raw of [txn.merchant, shortenMerchantPattern(txn.merchant), shortenMerchantPattern(txn.merchant_raw)]) {
    const key = raw && String(raw).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await upsertMerchantRule(db, tenantId, key, { category }, now);
  }
}

export async function teachMerchantNameRules(db, tenantId, previousRaw, newName, category, now) {
  if (!previousRaw || !newName) return;
  const fields = category ? { name: newName, category } : { name: newName };
  const short = shortenMerchantPattern(previousRaw);
  if (short && short !== previousRaw) await upsertMerchantRule(db, tenantId, short, fields, now);
  await upsertMerchantRule(db, tenantId, previousRaw, fields, now);
}

// Backfill newly taught personal merchant rules onto any other uncategorized
// transactions from the same payee so repeat merchants categorize in one tap.
export async function applyLearnedCategoryToUntagged(ctx, tenantId) {
  const untagged = await listUntaggedTransactions(ctx.db, tenantId, { onlyMissingCategory: true, limit: 50 });
  if (!untagged.length) return 0;
  const rules = await getMerchantRules(ctx.db, tenantId);
  let filled = 0;
  for (const row of untagged) {
    const raw = row.merchant || row.merchant_raw;
    if (!raw) continue;
    const resolved = resolveMerchant(raw, rules);
    const valid = categoriesFor(row.direction);
    if (!resolved.category || !valid.includes(resolved.category)) continue;
    const patch = {
      category: resolved.category,
      kind: defaultKind(row.direction, resolved.category)
    };
    if (!row.merchant && resolved.merchant) patch.merchant = resolved.merchant;
    await updateTransaction(ctx.db, tenantId, row.id, patch, ctx.now());
    await refreshCardMessage(ctx, tenantId, row.id);
    await refreshSplitGroupMessage(ctx, tenantId, row.id);
    filled++;
  }
  return filled;
}

const txnLabel = (r) => r.merchant || r.merchant_raw || "Unknown";

// input: { merchant?, category?, direction?, transactionType?, amount?, amountMinor?, confirmReview?: boolean, inferCategory?: boolean }
// opts:  { refreshCard?: boolean, backfillUntagged?: boolean, refreshPin?: boolean }
export async function mutateTransaction(ctx, tenantId, txnId, input = {}, opts = {}) {
  const tid = String(tenantId);
  const txn = txnId && (await getTransaction(ctx.db, tid, txnId));
  const allowedStatuses = input.confirmReview ? ["confirmed", "review"] : ["confirmed"];
  if (!txn || !allowedStatuses.includes(txn.status)) {
    return { ok: false, error: "Transaction not found for transaction_id: " + txnId };
  }

  const patch = {};
  const changes = [];
  const fixedFields = [];
  let direction = txn.direction;

  const wantsFinancialFix =
    input.direction !== undefined ||
    input.transactionType !== undefined ||
    input.amount !== undefined ||
    input.amountMinor !== undefined;
  if (wantsFinancialFix) {
    const [split, settlement] = await Promise.all([
      getSplitForTransaction(ctx.db, txn.id),
      getSettlementForTransaction(ctx.db, txn.id)
    ]);
    if (split || settlement) {
      return { ok: false, isSplit: true, error: "Make it personal again first, then fix it." };
    }
  }

  if (input.amount !== undefined || input.amountMinor !== undefined) {
    let minor = input.amountMinor;
    if (minor === undefined && input.amount !== null) {
      const num = Number(input.amount);
      minor = Number.isFinite(num) ? toMinor(num) : -1;
    }
    if (!Number.isInteger(minor) || minor <= 0 || minor > toMinor(PARSER_MAX_AMOUNT)) {
      return { ok: false, error: "amount must be a positive number" };
    }
    if (minor !== txn.amount_minor) {
      patch.amountMinor = minor;
      changes.push({ field: "amount", from: fromMinor(txn.amount_minor), to: fromMinor(minor) });
      fixedFields.push("amount");
    }
  }

  if (input.direction || input.transactionType) {
    const rawDir = input.direction || String(input.transactionType || "");
    const normalized = rawDir.toLowerCase();
    if (normalized !== "debit" && normalized !== "credit") {
      return { ok: false, error: "transaction_type must be 'Debit' or 'Credit'" };
    }
    direction = normalized;
    if (direction !== txn.direction) {
      patch.direction = direction;
      changes.push({
        field: "transaction_type",
        from: txn.direction === "debit" ? "Debit" : "Credit",
        to: direction === "debit" ? "Debit" : "Credit"
      });
      fixedFields.push("transaction_type");
    }
  }

  let merchant = txn.merchant;
  if (input.merchant !== undefined && input.merchant !== null) {
    const tag = String(input.merchant).trim();
    if (!tag || tag.length > TAG_MAX_LEN) {
      return { ok: false, error: "merchant must be 1–" + TAG_MAX_LEN + " characters" };
    }
    merchant = tag;
    if (tag !== (txn.merchant || "")) {
      patch.merchant = tag;
      changes.push({ field: "merchant", from: txnLabel(txn), to: tag });
    }
  }

  let category = txn.category;
  if (input.category !== undefined && input.category !== null) {
    const valid = categoriesFor(direction);
    if (!valid.includes(input.category)) {
      return {
        ok: false,
        error: "Invalid category for a " + direction + " transaction. Valid: " + valid.join(", ")
      };
    }
    category = input.category;
    if (category !== (txn.category || "")) {
      patch.category = category;
      changes.push({ field: "category", from: txn.category, to: category });
    }
  } else if (patch.direction && category && !categoriesFor(direction).includes(category)) {
    category = guessCategory(merchant, direction === "credit" ? "Credit" : "Debit") || null;
    patch.category = category;
  } else if (input.inferCategory && patch.merchant && !category) {
    const rules = await getMerchantRules(ctx.db, tid);
    const resolved = resolveMerchant(patch.merchant, rules);
    const valid = categoriesFor(direction);
    const guessed =
      (resolved.category && valid.includes(resolved.category) && resolved.category) ||
      guessCategory(patch.merchant, direction === "credit" ? "Credit" : "Debit") ||
      null;
    if (guessed && valid.includes(guessed)) {
      category = guessed;
      patch.category = guessed;
      changes.push({ field: "category", from: txn.category, to: guessed });
    }
  }

  if (input.confirmReview && txn.status === "review") {
    patch.status = "confirmed";
    patch.reviewNote = null;
  }

  if (!changes.length && !Object.keys(patch).length) {
    return {
      ok: false,
      error: "Nothing to update — pass at least one of: category, merchant, amount, transaction_type"
    };
  }
  if (patch.direction || patch.category !== undefined) {
    patch.kind = defaultKind(direction, category);
  }

  const now = ctx.now();
  await updateTransaction(ctx.db, tid, txn.id, patch, now);
  const updated = { ...txn, ...patch };

  if (fixedFields.length) {
    const src = (await getSources(ctx.db, tid, txn.id))[0] || {};
    await logParserEvent(
      ctx.db,
      {
        tenantId: tid,
        channel: src.source,
        templateId: src.parsed_by || "llm",
        event: "user_fix",
        fieldsChanged: fixedFields,
        sourceRef: src.source_ref
      },
      now
    );
  }

  const previousRaw = txn.merchant || txn.merchant_raw;
  if (patch.merchant && previousRaw) {
    await teachMerchantNameRules(ctx.db, tid, previousRaw, patch.merchant, patch.category || null, now);
  }
  if (patch.category) {
    await teachCategoryRules(ctx.db, tid, updated, patch.category, now);
  }

  let autoFilled = 0;
  if (patch.category && opts.backfillUntagged !== false) {
    autoFilled = await applyLearnedCategoryToUntagged(ctx, tid);
  }
  if (opts.refreshCard !== false) {
    await refreshCardMessage(ctx, tid, txn.id);
  }
  await refreshSplitGroupMessage(ctx, tid, txn.id);
  if (opts.refreshPin !== false) {
    await refreshPersonalPin(ctx, tid);
  }

  return { ok: true, transaction_id: txn.id, txn: updated, changes, autoFilled };
}

// Batch mutation that coalesces rule backfilling and pinned-summary edits to
// run once at the end instead of N times.
export async function batchMutateTransactions(ctx, tenantId, items = []) {
  const tid = String(tenantId);
  const slice = Array.isArray(items) ? items.slice(0, 20) : [];
  if (!slice.length) return { ok: false, error: "items array is required" };

  const results = [];
  let anyCategoryChanged = false;
  let anySucceeded = false;

  for (const item of slice) {
    const r = await mutateTransaction(
      ctx,
      tid,
      item && item.transaction_id,
      {
        merchant: item && item.merchant,
        category: item && item.category,
        amount: item && item.amount,
        transactionType: item && item.transaction_type
      },
      { backfillUntagged: false, refreshPin: false }
    );
    if (r.ok) {
      anySucceeded = true;
      if (item && item.category) anyCategoryChanged = true;
      results.push({ ok: true, transaction_id: r.transaction_id, changes: r.changes });
    } else {
      results.push(r);
    }
  }

  let autoFilled = 0;
  if (anyCategoryChanged) autoFilled = await applyLearnedCategoryToUntagged(ctx, tid);
  if (anySucceeded) await refreshPersonalPin(ctx, tid);

  return {
    ok: results.every((r) => r.ok),
    updated: results.filter((r) => r.ok).length,
    auto_filled: autoFilled,
    results
  };
}

// Soft-delete a personal transaction in D1 and remove its DM card bubble from
// Telegram (falling back to a tombstone edit if older than Telegram's 48h
// delete window). Refuses while split/settled in a group.
export async function removeTransaction(ctx, tenantId, txnId, { cardMessageId = null, tombstone = null } = {}) {
  const tid = String(tenantId);
  const txn = txnId && (await getTransaction(ctx.db, tid, txnId));
  if (!txn || txn.status === "deleted") {
    return { ok: false, error: "Transaction not found for transaction_id: " + txnId };
  }
  const [split, settlement] = await Promise.all([
    getSplitForTransaction(ctx.db, txn.id),
    getSettlementForTransaction(ctx.db, txn.id)
  ]);
  if (split || settlement) {
    return { ok: false, isSplit: true, error: "Make it personal again first, then delete." };
  }

  const wasConfirmed = txn.status === "confirmed";
  await softDeleteTransaction(ctx.db, tid, txn.id, ctx.now());
  if (wasConfirmed) await refreshPersonalPin(ctx, tid);

  const msgId = Number(cardMessageId || txn.card_message_id || 0);
  let cardRemoved = false;
  if (msgId) {
    try {
      await ctx.tg.deleteMessage(tid, msgId);
      cardRemoved = true;
    } catch (_) {
      const fallback = tombstone || (wasConfirmed ? "🗑️ *Transaction deleted*" : "✖ *Discarded*");
      await ctx.tg.editMessageText(tid, msgId, fallback).catch(() => {});
    }
  }
  return { ok: true, transaction_id: txn.id, cardRemoved };
}
