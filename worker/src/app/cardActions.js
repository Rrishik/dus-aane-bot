// Card button actions (personal chats): tag, category, ⋯ menu, fix
// (direction / amount), back, delete, report, Re-read and review Save/Discard.
import {
  getTransaction,
  updateTransaction,
  softDeleteTransaction,
  updateSource,
  listUntaggedTransactions,
  isUntaggedTransaction
} from "../db/transactions.js";
import { getMerchantRules, resolveMerchant, upsertMerchantRule } from "../db/merchantRules.js";
import { touchActivity } from "../db/tenants.js";
import { logParserEvent, countParserEvents, disableTemplate } from "../db/settings.js";
import { putEphemeral, takeEphemeral } from "../db/ephemeral.js";
import { validateExtraction, diffExtractions, guessCategory, PARSER_MAX_AMOUNT } from "../parser/index.js";
import { loadCardState, renderCard, defaultKeyboard, refreshCardMessage } from "./cardState.js";
import { refreshPersonalPin } from "./personalPin.js";
import { cardText, categoryKeyboard, helpMenuKeyboard, deleteConfirmKeyboard, fixMenuKeyboard } from "./cards.js";
import { CATEGORIES, CREDIT_CATEGORIES, CATEGORY_EMOJIS, categoriesFor, TAG_MAX_LEN } from "./constants.js";
import { escapeMarkdown, money, formatDayMonth, shortCategoryName } from "./format.js";
import { extractWithLlm } from "./extraction.js";
import { callAppsScript } from "./appsScript.js";
import { setPending, getPending, takePending, clearPending } from "./pending.js";
import { toMinor, fromMinor } from "../util/money.js";
import { defaultKind } from "../util/kind.js";

const REREAD_TTL_SEC = 3600;
const AUTO_DISABLE_ACCEPTED = 3;
const AUTO_DISABLE_WINDOW_MS = 7 * 86400000;

// "bundl tech 12345" → "bundl tech": one rule covers numbered payee variants.
export function shortenMerchantPattern(raw) {
  if (!raw) return raw;
  const trimmed = String(raw)
    .replace(/[\s_\-#.]+\d[\d\s_\-#.]*$/, "")
    .trim();
  return trimmed || raw;
}

async function notFound(ctx, chatId) {
  await ctx.tg.sendMessage(chatId, "❌ *Transaction not found.*");
}

// Changing a split transaction would move other people's balances.
async function refuseIfSplit(ctx, chatId, messageId, state) {
  if (!state.isSplit) return false;
  await ctx.tg.sendMessage(chatId, "↩️ *Make it personal again first, then fix it.*");
  await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
  return true;
}

// A user's correction is the strongest accuracy signal for whoever read the
// message (a parser template or the LLM). Field names only.
async function logUserFix(ctx, chatId, state, fields) {
  const src = state.sources[0] || {};
  await logParserEvent(
    ctx.db,
    {
      tenantId: chatId,
      channel: src.source,
      templateId: src.parsed_by || "llm",
      event: "user_fix",
      fieldsChanged: fields,
      sourceRef: src.source_ref
    },
    ctx.now()
  );
}

// "1,250.50", "₹1250", "Rs. 99" → minor units, or null.
export function parseAmountInput(text) {
  const s = String(text || "")
    .trim()
    .replace(/^(?:₹|rs\.?|inr)\s*/i, "")
    .replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const minor = toMinor(Number(s));
  return minor > 0 && minor <= toMinor(PARSER_MAX_AMOUNT) ? minor : null;
}

async function editCard(ctx, chatId, messageId, state, extraLine, keyboard) {
  await ctx.tg.editMessageText(chatId, messageId, renderCard(state, extraLine), {
    reply_markup: keyboard || defaultKeyboard(state)
  });
}

// Dispatch for "<action>_<txnId>[_<arg>]" card callbacks. Returns false for
// actions this module doesn't own.
export async function handleCardAction(ctx, { chatId, userId, messageId, action, payload, from }) {
  const handler = ACTIONS[action];
  if (!handler) return false;
  let txnId = payload;
  let arg = null;
  if (action === "cat") {
    const i = payload.lastIndexOf("_");
    txnId = payload.slice(0, i);
    arg = payload.slice(i + 1);
  }
  const state = await loadCardState(ctx, chatId, txnId);
  if (!state || state.txn.status === "deleted") {
    await notFound(ctx, chatId);
    return true;
  }
  await handler(ctx, { chatId, userId, messageId, state, arg, from });
  return true;
}

const ACTIONS = {
  async tag(ctx, { chatId, userId, messageId, state }) {
    await setPending(ctx, "tag", userId, { txnId: state.txn.id, messageId });
    const current = state.txn.merchant;
    const prompt = current
      ? "🏷 *Tag merchant*\nCurrently tagged as *" +
        escapeMarkdown(current) +
        "*.\n\nReply with a new brand name (up to " +
        TAG_MAX_LEN +
        " chars), or /cancel to keep " +
        escapeMarkdown(current) +
        "."
      : "🏷 *Tag merchant*\nReply with the brand name (up to " + TAG_MAX_LEN + " chars), or /cancel.";
    await ctx.tg.sendMessage(chatId, prompt, {
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: "e.g. Swiggy" }
    });
  },

  async editcat(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(
      chatId,
      messageId,
      categoryKeyboard(state.txn.id, categoriesFor(state.txn.direction))
    );
  },

  async cat(ctx, { chatId, messageId, state, arg }) {
    const list = categoriesFor(state.txn.direction);
    const idx = parseInt(arg, 10);
    if (isNaN(idx) || idx < 0 || idx >= list.length) {
      await ctx.tg.sendMessage(chatId, "❌ *Invalid category*");
      return;
    }
    const category = list[idx];
    const kind = defaultKind(state.txn.direction, category);
    await updateTransaction(ctx.db, chatId, state.txn.id, { category, kind }, ctx.now());
    Object.assign(state.txn, { category, kind });
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    // Teach this user's future transactions from the same merchant / VPA pattern.
    await teachCategoryRules(ctx.db, chatId, state.txn, category, ctx.now());
    await applyLearnedCategoryToUntagged(ctx, chatId);
    await refreshPersonalPin(ctx, chatId);
  },

  async help(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(
      chatId,
      messageId,
      helpMenuKeyboard(state.txn.id, { canReread: state.canReread, canEdit: !state.isSplit })
    );
  },

  async fix(ctx, { chatId, messageId, state }) {
    if (await refuseIfSplit(ctx, chatId, messageId, state)) return;
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, fixMenuKeyboard(state.txn));
  },

  // Money in ↔ money out. The category is kept when it fits the new
  // direction, otherwise re-guessed.
  async flip(ctx, { chatId, messageId, state }) {
    if (await refuseIfSplit(ctx, chatId, messageId, state)) return;
    const t = state.txn;
    const direction = t.direction === "debit" ? "credit" : "debit";
    const category = categoriesFor(direction).includes(t.category)
      ? t.category
      : guessCategory(t.merchant, direction === "credit" ? "Credit" : "Debit") || null;
    const kind = defaultKind(direction, category);
    await updateTransaction(ctx.db, chatId, t.id, { direction, category, kind }, ctx.now());
    Object.assign(t, { direction, category, kind });
    await editCard(ctx, chatId, messageId, state);
    await logUserFix(ctx, chatId, state, ["transaction_type"]);
    await refreshPersonalPin(ctx, chatId);
  },

  async amt(ctx, { chatId, userId, messageId, state }) {
    if (await refuseIfSplit(ctx, chatId, messageId, state)) return;
    await setPending(ctx, "amount", userId, { txnId: state.txn.id, messageId });
    await ctx.tg.sendMessage(
      chatId,
      "💰 *Correct amount*\nCurrently " +
        money(state.txn.amount_minor, state.txn.currency) +
        ". Reply with the right amount, or /cancel.",
      { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "e.g. 1250.50" } }
    );
  },

  async back(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
  },

  async del(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, deleteConfirmKeyboard(state.txn.id));
  },

  async delyes(ctx, { chatId, messageId, state }) {
    if (state.isSplit) {
      await ctx.tg.sendMessage(chatId, "↩️ *Make it personal again first, then delete.*");
      await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
      return;
    }
    await softDeleteTransaction(ctx.db, chatId, state.txn.id, ctx.now());
    await ctx.tg.editMessageText(chatId, messageId, "🗑️ *Transaction deleted*");
    await refreshPersonalPin(ctx, chatId);
  },

  async report(ctx, { chatId, messageId, state, from }) {
    const t = state.txn;
    const src = state.sources[0] || {};
    const name = (from && (from.first_name || from.username)) || chatId;
    const lines = [
      "⚠️ *Reported txn*",
      "from: " + escapeMarkdown(String(name)) + " (chat " + chatId + ")",
      "merchant: " + escapeMarkdown(String(t.merchant || t.merchant_raw || "(unknown)")),
      "amount: " + t.currency + " " + fromMinor(t.amount_minor),
      "parsed by: " + escapeMarkdown(String(src.parsed_by || "llm")),
      "source: " + escapeMarkdown(String(src.source || "?") + " " + (src.source_ref || ""))
    ];
    if (src.source === "email") lines.push("https://mail.google.com/mail/u/0/#all/" + src.source_ref);
    try {
      if (ctx.adminChatId) {
        await ctx.tg.sendMessage(ctx.adminChatId, lines.join("\n"), { disable_web_page_preview: true });
      }
    } catch (e) {
      console.error("[report] admin DM failed:", e && e.message);
    }
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, {
      inline_keyboard: [[{ text: "📩 Reported — thanks!", callback_data: "back_" + t.id }]]
    });
    await logParserEvent(
      ctx.db,
      {
        tenantId: chatId,
        channel: src.source,
        templateId: src.parsed_by || "llm",
        event: "report",
        sourceRef: src.source_ref
      },
      ctx.now()
    );
  },

  rr: reread,
  rra: rereadAccept,
  rrk: rereadKeep,

  async rvok(ctx, { chatId, messageId, state }) {
    if (state.txn.status === "review") {
      await updateTransaction(ctx.db, chatId, state.txn.id, { status: "confirmed", reviewNote: null }, ctx.now());
      state.txn.status = "confirmed";
      await touchActivity(ctx.db, chatId, ctx.now());
      await refreshPersonalPin(ctx, chatId);
    }
    await editCard(ctx, chatId, messageId, state);
  },

  async rvno(ctx, { chatId, messageId, state }) {
    await softDeleteTransaction(ctx.db, chatId, state.txn.id, ctx.now());
    await ctx.tg.editMessageText(chatId, messageId, "✖ *Discarded*");
  }
};

// ─── Re-read ─────────────────────────────────────────────────────────

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
  if (changed.includes("amount") || changed.includes("currency"))
    parts.push(money(toMinor(fresh.amount), fresh.currency));
  if (changed.includes("transaction_date"))
    parts.push(formatDayMonth(fresh.transaction_date) + " " + fresh.transaction_date.slice(0, 4));
  if (changed.includes("transaction_type")) parts.push(fresh.transaction_type);
  return parts.join(" · ");
}

async function reread(ctx, { chatId, messageId, state }) {
  const src = state.sources[0];
  if (!state.canReread) {
    await ctx.tg.sendMessage(
      chatId,
      state.isSplit
        ? "↩️ *Make it personal again first, then re-read.*"
        : "ℹ️ *Already re-read.* Use ⚠️ Report error if it's still wrong."
    );
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    return;
  }
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

async function rereadAccept(ctx, { chatId, messageId, state }) {
  const pending = await takeEphemeral(ctx.db, rereadKey(chatId, state.txn.id), ctx.now());
  if (!pending || !pending.fields) {
    await ctx.tg.sendMessage(chatId, "⌛ *That re-read expired.* Tap ⋯ → 🔄 Re-read to try again.");
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

async function rereadKeep(ctx, { chatId, messageId, state }) {
  await takeEphemeral(ctx.db, rereadKey(chatId, state.txn.id), ctx.now());
  const src = state.sources[0];
  if (src && !src.reread) {
    await updateSource(ctx.db, chatId, src.source, src.source_ref, { reread: 1 });
    src.reread = 1;
    state.canReread = false;
  }
  await editCard(ctx, chatId, messageId, state);
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

// ─── Tag reply ───────────────────────────────────────────────────────

// /cancel: drop whatever reply the bot is waiting for (tag, amount, open question, register).
export async function handleCancel(ctx, m) {
  if (await takePending(ctx, "tag", m.userId)) {
    await ctx.tg.sendMessage(m.chatId, "↩️ *Tag unchanged.*");
    return;
  }
  if (await takePending(ctx, "amount", m.userId)) {
    await ctx.tg.sendMessage(m.chatId, "↩️ *Amount unchanged.*");
    return;
  }
  const openAsk = await takeEphemeral(ctx.db, "ask_open:" + m.chatId, ctx.now());
  if (openAsk && openAsk.messageId) {
    await takeEphemeral(ctx.db, "ask:" + m.chatId + ":" + openAsk.messageId, ctx.now());
  }
  const pendingAsk = await takePending(ctx, "ask", m.chatId);
  await ctx.tg.sendMessage(m.chatId, openAsk || pendingAsk ? "↩️ Cancelled." : "Nothing to cancel.", {
    parse_mode: null
  });
}

// Plain-text reply after ⋯ → ✏️ Fix → 💰 Amount. Returns true if consumed.
export async function handleAmountReply(ctx, m) {
  const pending = await getPending(ctx, "amount", m.userId);
  if (!pending) return false;
  const amountMinor = parseAmountInput(m.text);
  if (amountMinor === null) {
    await ctx.tg.sendMessage(m.chatId, "❌ *That's not an amount.* Try `1250` or `1250.50`, or /cancel.");
    return true;
  }
  await clearPending(ctx, "amount", m.userId);
  const state = await loadCardState(ctx, m.chatId, pending.txnId);
  if (!state || state.txn.status === "deleted") {
    await notFound(ctx, m.chatId);
    return true;
  }
  if (state.isSplit) {
    await ctx.tg.sendMessage(m.chatId, "↩️ *Make it personal again first, then fix it.*");
    return true;
  }
  if (amountMinor !== state.txn.amount_minor) {
    await updateTransaction(ctx.db, m.chatId, state.txn.id, { amountMinor }, ctx.now());
    state.txn.amount_minor = amountMinor;
    await logUserFix(ctx, m.chatId, state, ["amount"]);
    await refreshPersonalPin(ctx, m.chatId);
  }
  if (pending.messageId) await editCard(ctx, m.chatId, pending.messageId, state);
  return true;
}

// Plain-text reply after a 🏷 tap. Returns true if consumed.
export async function handleTagReply(ctx, m) {
  const pending = await getPending(ctx, "tag", m.userId);
  if (!pending) return false;
  const text = m.text.trim();
  if (!text || text.length > TAG_MAX_LEN) {
    await ctx.tg.sendMessage(
      m.chatId,
      "❌ *Tag must be 1–" + TAG_MAX_LEN + " characters.* Try a shorter name, or /cancel to keep the current tag."
    );
    return true;
  }
  await clearPending(ctx, "tag", m.userId);
  const state = await loadCardState(ctx, m.chatId, pending.txnId);
  if (!state) {
    await notFound(ctx, m.chatId);
    return true;
  }
  const previous = state.txn.merchant || state.txn.merchant_raw;
  const patch = { merchant: text };
  if (!state.txn.category) {
    const rules = await getMerchantRules(ctx.db, m.chatId);
    const resolved = resolveMerchant(text, rules);
    const valid = categoriesFor(state.txn.direction);
    const guessed =
      (resolved.category && valid.includes(resolved.category) && resolved.category) ||
      guessCategory(text, state.txn.direction === "credit" ? "Credit" : "Debit") ||
      null;
    if (guessed && valid.includes(guessed)) {
      patch.category = guessed;
      patch.kind = defaultKind(state.txn.direction, guessed);
    }
  }
  await updateTransaction(ctx.db, m.chatId, state.txn.id, patch, ctx.now());
  Object.assign(state.txn, patch);
  if (pending.messageId) await editCard(ctx, m.chatId, pending.messageId, state);
  if (previous) {
    const fields = patch.category ? { name: text, category: patch.category } : { name: text };
    const short = shortenMerchantPattern(previous);
    if (short && short !== previous) await upsertMerchantRule(ctx.db, m.chatId, short, fields, ctx.now());
    await upsertMerchantRule(ctx.db, m.chatId, previous, fields, ctx.now());
  }
  if (patch.category) await applyLearnedCategoryToUntagged(ctx, m.chatId);
  await refreshPersonalPin(ctx, m.chatId);
  return true;
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
    filled++;
  }
  return filled;
}

// ─── 1-tap untagged stepper (from Daily Recap / pinned dashboard) ────

function tagStepperKeyboard(txn) {
  const cats = txn.direction === "credit" ? CREDIT_CATEGORIES : CATEGORIES;
  const rows = [];
  const missingMerchant = !txn.merchant || String(txn.merchant).trim().toLowerCase() === "unknown";
  if (missingMerchant && txn.category) {
    rows.push([
      { text: "🏷 Name merchant", callback_data: "tag_" + txn.id },
      { text: "✓ Keep as " + shortCategoryName(txn.category), callback_data: "tagqm_" + txn.id }
    ]);
  }
  for (let i = 0; i < cats.length; i += 3) {
    rows.push(
      cats.slice(i, i + 3).map((c, j) => ({
        text: (CATEGORY_EMOJIS[c] ? CATEGORY_EMOJIS[c] + " " : "") + shortCategoryName(c),
        callback_data: "tagqc_" + txn.id + "_" + (i + j)
      }))
    );
  }
  const footer = [];
  if (!(missingMerchant && txn.category)) footer.push({ text: "🏷 Name merchant", callback_data: "tag_" + txn.id });
  footer.push({ text: "⏭ Skip", callback_data: "tagq_skip_" + txn.id });
  rows.push(footer);
  return { inline_keyboard: rows };
}

export async function handleTagQueueCallback(ctx, { chatId, messageId, action, payload }) {
  if (action === "tagqm") {
    const txn = await getTransaction(ctx.db, chatId, payload);
    if (txn && txn.status === "confirmed" && !txn.merchant) {
      const fallbackName = shortCategoryName(txn.category) || (txn.direction === "credit" ? "Credit" : "Expense");
      await updateTransaction(ctx.db, chatId, txn.id, { merchant: fallbackName }, ctx.now());
      await refreshCardMessage(ctx, chatId, txn.id);
      await refreshPersonalPin(ctx, chatId);
    }
    return renderNextUntaggedStep(ctx, chatId, messageId, null);
  }

  if (action === "tagqc") {
    const sep = payload.lastIndexOf("_");
    const txnId = payload.slice(0, sep);
    const idx = parseInt(payload.slice(sep + 1), 10);
    const txn = await getTransaction(ctx.db, chatId, txnId);
    let stillUntagged = false;
    if (txn && txn.status === "confirmed") {
      const list = categoriesFor(txn.direction);
      if (!isNaN(idx) && idx >= 0 && idx < list.length) {
        const category = list[idx];
        const kind = defaultKind(txn.direction, category);
        await updateTransaction(ctx.db, chatId, txn.id, { category, kind }, ctx.now());
        Object.assign(txn, { category, kind });
        await teachCategoryRules(ctx.db, chatId, txn, category, ctx.now());
        await applyLearnedCategoryToUntagged(ctx, chatId);
        await refreshCardMessage(ctx, chatId, txn.id);
        await refreshPersonalPin(ctx, chatId);
        stillUntagged = isUntaggedTransaction(txn);
      }
    }
    return renderNextUntaggedStep(ctx, chatId, messageId, stillUntagged ? txnId : null);
  }

  const skipId = payload.startsWith("skip_") ? payload.slice(5) : null;
  return renderNextUntaggedStep(ctx, chatId, messageId, skipId);
}

async function renderNextUntaggedStep(ctx, chatId, messageId, skipId) {
  const list = await listUntaggedTransactions(ctx.db, chatId, { limit: 25 });
  if (list.length === 0) {
    await ctx.tg.editMessageText(chatId, messageId, "✅ *All caught up!*\nEvery recent transaction has a category.", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🕒 Recent", callback_data: "stats_recent" },
            { text: "📉 Trends", callback_data: "stats_trends" }
          ]
        ]
      }
    });
    return;
  }

  let idx = 0;
  if (skipId) {
    const found = list.findIndex((t) => t.id === skipId);
    if (found >= 0) idx = (found + 1) % list.length;
  }
  const current = list[idx];
  const header = "🏷 *Categorize* _(" + (idx + 1) + " of " + list.length + " left)_\n\n";
  await ctx.tg.editMessageText(chatId, messageId, header + cardText(current), {
    reply_markup: tagStepperKeyboard(current)
  });
}
