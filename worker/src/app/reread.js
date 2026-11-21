// 🔄 Re-read workflow for parser-read transaction cards + automatic parser
// template circuit-breaker after repeated user-confirmed mistakes.
import { updateTransaction, updateSource } from "../db/transactions.js";
import { getMerchantRules } from "../db/merchantRules.js";
import { logParserEvent, countParserEvents, disableTemplate } from "../db/settings.js";
import { putEphemeral, takeEphemeral } from "../db/ephemeral.js";
import { validateExtraction, diffExtractions, guessCategory } from "../parser/index.js";
import { loadCardState, defaultKeyboard, editCard } from "./cardState.js";
import { refreshPersonalPin } from "./personalPin.js";
import { extractWithLlm } from "./extraction.js";
import { callAppsScript } from "./appsScript.js";
import { categoriesFor } from "./constants.js";
import { escapeMarkdown, money, formatDayMonth } from "./format.js";
import { toMinor, fromMinor } from "../util/money.js";
import { defaultKind } from "../util/kind.js";

const REREAD_TTL_SEC = 3600;
const AUTO_DISABLE_ACCEPTED = 3;
const AUTO_DISABLE_WINDOW_MS = 7 * 86400000;

const rereadKey = (chatId, txnId) => "rr:" + chatId + ":" + txnId;

async function sourceText(ctx, src) {
  if (src.source === "sms") return src.raw_text || "";
  if (src.source !== "email") return "";
  try {
    const res = await callAppsScript(ctx, "get_email_body", { messageId: src.source_ref });
    return res.text || "";
  } catch (e) {
    console.error("[reread] email fetch failed:", e && e.message);
    return "";
  }
}

function describeChanges(fresh, changed) {
  const parts = [];
  if (changed.includes("amount") || changed.includes("currency")) {
    parts.push(money(toMinor(fresh.amount), fresh.currency));
  }
  if (changed.includes("transaction_date")) {
    parts.push(formatDayMonth(fresh.transaction_date) + " " + fresh.transaction_date.slice(0, 4));
  }
  if (changed.includes("transaction_type")) parts.push(fresh.transaction_type);
  return parts.join(" · ");
}

export async function reread(ctx, { chatId, messageId, state, ack }) {
  const src = state.sources[0];
  if (!state.canReread) {
    const msg = state.isSplit
      ? "↩️ Make it personal again first, then re-read."
      : "ℹ️ Already re-read. Use ⚠️ Report error if it's still wrong.";
    await ack.toast(msg, true);
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    return;
  }
  await ack.toast("🔄 Re-reading message…");
  await ctx.tg.editMessageReplyMarkup(chatId, messageId, {
    inline_keyboard: [[{ text: "⏳ Re-reading…", callback_data: "back_" + state.txn.id }]]
  });
  const evt = { tenantId: chatId, channel: src.source, templateId: src.parsed_by, sourceRef: src.source_ref };
  await logParserEvent(ctx.db, { ...evt, event: "reparse_requested" }, ctx.now());

  const text = await sourceText(ctx, src);
  if (!text) {
    await ctx.tg.sendMessage(chatId, "❌ *The original message isn't available any more.*");
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    return;
  }
  let llm = null;
  try {
    llm = await extractWithLlm(ctx.llm, text, src.source, await getMerchantRules(ctx.db, chatId));
  } catch (e) {
    console.error("[reread] LLM failed:", e && e.message);
  }
  if (!llm) {
    await ctx.tg.sendMessage(chatId, "❌ *Couldn't re-read right now.* Try again in a bit.");
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    return;
  }
  const key = rereadKey(chatId, state.txn.id);
  if (llm.not_a_transaction) {
    await putEphemeral(ctx.db, key, { notTransaction: true }, REREAD_TTL_SEC, ctx.now());
    await editCard(ctx, chatId, messageId, state, "🔄 Re-read: not a transaction", {
      inline_keyboard: [
        [
          { text: "🗑️ Delete", callback_data: "del_" + state.txn.id },
          { text: "↩ Keep original", callback_data: "rrk_" + state.txn.id }
        ]
      ]
    });
    return;
  }
  const fresh = validateExtraction(llm, text, src.received_at).data;
  const current = {
    amount: fromMinor(state.txn.amount_minor),
    currency: state.txn.currency,
    transaction_type: state.txn.direction === "debit" ? "Debit" : "Credit",
    transaction_date: state.txn.occurred_on
  };
  const changed = diffExtractions(current, fresh);
  if (changed.length === 0) {
    await updateSource(ctx.db, chatId, src.source, src.source_ref, { reread: 1 });
    state.sources[0].reread = 1;
    state.canReread = false;
    await logParserEvent(ctx.db, { ...evt, event: "reparse_same" }, ctx.now());
    await editCard(ctx, chatId, messageId, state, "🔄 _Re-read: same result_", {
      inline_keyboard: [
        [{ text: "⚠️ Still wrong? Report", callback_data: "report_" + state.txn.id }],
        [{ text: "← Back", callback_data: "back_" + state.txn.id }]
      ]
    });
    return;
  }
  const fields = {};
  changed.forEach((f) => (fields[f] = fresh[f]));
  await putEphemeral(ctx.db, key, { fields, changed }, REREAD_TTL_SEC, ctx.now());
  await editCard(ctx, chatId, messageId, state, "🔄 Re-read: " + escapeMarkdown(describeChanges(fresh, changed)), {
    inline_keyboard: [
      [
        { text: "✅ Use this", callback_data: "rra_" + state.txn.id },
        { text: "↩ Keep original", callback_data: "rrk_" + state.txn.id }
      ]
    ]
  });
}

export async function rereadAccept(ctx, { chatId, messageId, state, ack }) {
  const pending = await takeEphemeral(ctx.db, rereadKey(chatId, state.txn.id), ctx.now());
  if (!pending || !pending.fields) {
    await ack.toast("⌛ That re-read expired — tap ⋯ → 🔄 Re-read to try again.", true);
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    return;
  }
  const f = pending.fields;
  const patch = { status: "confirmed", reviewNote: null };
  if (f.amount !== undefined) patch.amountMinor = toMinor(f.amount);
  if (f.currency) patch.currency = f.currency;
  if (f.transaction_date) patch.occurredOn = f.transaction_date;
  if (f.transaction_type) {
    patch.direction = f.transaction_type === "Credit" ? "credit" : "debit";
    if (!categoriesFor(patch.direction).includes(state.txn.category)) {
      patch.category = guessCategory(state.txn.merchant, f.transaction_type) || null;
    }
    patch.kind = defaultKind(patch.direction, patch.category !== undefined ? patch.category : state.txn.category);
  }
  await updateTransaction(ctx.db, chatId, state.txn.id, patch, ctx.now());
  const src = state.sources[0];
  const templateId = src.parsed_by;
  await updateSource(ctx.db, chatId, src.source, src.source_ref, { parsedBy: "llm", reread: 1 });

  const fresh = await loadCardState(ctx, chatId, state.txn.id);
  await editCard(ctx, chatId, messageId, fresh);
  await refreshPersonalPin(ctx, chatId);
  if (ack) await ack.toast("✅ Updated from re-read");
  await logParserEvent(
    ctx.db,
    {
      tenantId: chatId,
      channel: src.source,
      templateId,
      event: "reparse_accepted",
      fieldsChanged: pending.changed,
      sourceRef: src.source_ref
    },
    ctx.now()
  );
  await autoDisableIfNeeded(ctx, templateId);
}

export async function rereadKeep(ctx, { chatId, messageId, state, ack }) {
  await takeEphemeral(ctx.db, rereadKey(chatId, state.txn.id), ctx.now());
  const src = state.sources[0];
  if (src && !src.reread) {
    await updateSource(ctx.db, chatId, src.source, src.source_ref, { reread: 1 });
    src.reread = 1;
    state.canReread = false;
  }
  await editCard(ctx, chatId, messageId, state);
  if (ack) await ack.toast("↩ Kept original");
  if (src) {
    await logParserEvent(
      ctx.db,
      {
        tenantId: chatId,
        channel: src.source,
        templateId: src.parsed_by,
        event: "reparse_kept_original",
        sourceRef: src.source_ref
      },
      ctx.now()
    );
  }
}

// A template with 3 confirmed mistakes in 7 days goes back to the LLM.
export async function autoDisableIfNeeded(ctx, templateId) {
  if (!templateId || templateId === "llm") return false;
  const n = await countParserEvents(ctx.db, {
    templateId,
    event: "reparse_accepted",
    sinceMs: ctx.now() - AUTO_DISABLE_WINDOW_MS
  });
  if (n < AUTO_DISABLE_ACCEPTED || !(await disableTemplate(ctx.db, templateId, ctx.now()))) return false;
  await logParserEvent(ctx.db, { templateId, event: "auto_disabled" }, ctx.now());
  if (ctx.adminChatId) {
    await ctx.tg.sendMessage(
      ctx.adminChatId,
      "⚠️ Parser template `" +
        templateId +
        "` auto-disabled after " +
        n +
        " accepted Re-reads in 7 days. Its messages now go to the LLM."
    );
  }
  return true;
}
