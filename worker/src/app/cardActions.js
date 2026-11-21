// Personal DM card actions: inline buttons (tag, category, ⋯ menu, fix,
// delete, report, review Save/Discard), pending tag/amount replies, and the
// deterministic 0-LLM swipe-reply-to-card shortcut.
import { findTransactionByCardMessage, updateTransaction, softDeleteTransaction } from "../db/transactions.js";
import { getMerchantRules, resolveMerchant } from "../db/merchantRules.js";
import { touchActivity } from "../db/tenants.js";
import { logParserEvent } from "../db/settings.js";
import { guessCategory, PARSER_MAX_AMOUNT } from "../parser/index.js";
import { loadCardState, defaultKeyboard, editCard } from "./cardState.js";
import { mutateTransaction, shortenMerchantPattern } from "./ledger.js";
import { reread, rereadAccept, rereadKeep } from "./reread.js";
import { cancelOpenConversation } from "./orchestrator.js";
import { refreshPersonalPin } from "./personalPin.js";
import { categoryKeyboard, helpMenuKeyboard, deleteConfirmKeyboard, fixMenuKeyboard } from "./cards.js";
import { CATEGORY_EMOJIS, categoriesFor, TAG_MAX_LEN } from "./constants.js";
import { escapeMarkdown, money } from "./format.js";
import { setPending, getPending, takePending, clearPending } from "./pending.js";
import { toMinor, fromMinor } from "../util/money.js";

export { shortenMerchantPattern };

async function notFound(ctx, chatId, ack) {
  if (ack) await ack.toast("❌ Transaction not found", true);
  else await ctx.tg.sendMessage(chatId, "❌ *Transaction not found.*");
}

async function refuseIfSplit(ctx, chatId, messageId, state, ack) {
  if (!state.isSplit) return false;
  await ack.toast("↩️ Make it personal again first, then fix it.", true);
  await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
  return true;
}

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

export async function handleCardAction(ctx, { chatId, userId, messageId, action, payload, from, ack }) {
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
    await notFound(ctx, chatId, ack);
    return true;
  }
  await handler(ctx, { chatId, userId, messageId, state, arg, from, ack });
  return true;
}

const ACTIONS = {
  async tag(ctx, { chatId, userId, messageId, state }) {
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
    const sent = await ctx.tg.sendMessage(chatId, prompt, {
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: "e.g. Swiggy" }
    });
    await setPending(ctx, "tag", userId, {
      txnId: state.txn.id,
      messageId,
      promptMessageId: sent && sent.message_id ? sent.message_id : null
    });
  },

  async editcat(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(
      chatId,
      messageId,
      categoryKeyboard(state.txn.id, categoriesFor(state.txn.direction))
    );
  },

  async cat(ctx, { chatId, messageId, state, arg, ack }) {
    const list = categoriesFor(state.txn.direction);
    const idx = parseInt(arg, 10);
    if (isNaN(idx) || idx < 0 || idx >= list.length) {
      await ack.toast("❌ Invalid category", true);
      return;
    }
    const category = list[idx];
    const res = await mutateTransaction(ctx, chatId, state.txn.id, { category }, { refreshCard: false });
    if (!res.ok) return;
    Object.assign(state.txn, res.txn);
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    const emoji = CATEGORY_EMOJIS[category] ? CATEGORY_EMOJIS[category] + " " : "";
    const extra = res.autoFilled > 0 ? " · +" + res.autoFilled + " auto-tagged" : "";
    await ack.toast(emoji + category + extra);
  },

  async help(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(
      chatId,
      messageId,
      helpMenuKeyboard(state.txn.id, { canReread: state.canReread, canEdit: !state.isSplit })
    );
  },

  async fix(ctx, { chatId, messageId, state, ack }) {
    if (await refuseIfSplit(ctx, chatId, messageId, state, ack)) return;
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, fixMenuKeyboard(state.txn));
  },

  async flip(ctx, { chatId, messageId, state, ack }) {
    if (await refuseIfSplit(ctx, chatId, messageId, state, ack)) return;
    const direction = state.txn.direction === "debit" ? "credit" : "debit";
    const res = await mutateTransaction(
      ctx,
      chatId,
      state.txn.id,
      { direction },
      { refreshCard: false, backfillUntagged: false }
    );
    if (!res.ok) return;
    Object.assign(state.txn, res.txn);
    await editCard(ctx, chatId, messageId, state);
    await logUserFix(ctx, chatId, state, ["transaction_type"]);
    if (ack) await ack.toast(direction === "credit" ? "🟢 Flipped to Credit" : "🔴 Flipped to Debit");
  },

  async amt(ctx, { chatId, userId, messageId, state, ack }) {
    if (await refuseIfSplit(ctx, chatId, messageId, state, ack)) return;
    const sent = await ctx.tg.sendMessage(
      chatId,
      "💰 *Correct amount*\nCurrently " +
        money(state.txn.amount_minor, state.txn.currency) +
        ". Reply with the right amount, or /cancel.",
      { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "e.g. 1250.50" } }
    );
    await setPending(ctx, "amount", userId, {
      txnId: state.txn.id,
      messageId,
      promptMessageId: sent && sent.message_id ? sent.message_id : null
    });
  },

  async back(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
  },

  async del(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, deleteConfirmKeyboard(state.txn.id));
  },

  async delyes(ctx, { chatId, messageId, state, ack }) {
    if (state.isSplit) {
      await ack.toast("↩️ Make it personal again first, then delete.", true);
      await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
      return;
    }
    await softDeleteTransaction(ctx.db, chatId, state.txn.id, ctx.now());
    await ctx.tg.editMessageText(chatId, messageId, "🗑️ *Transaction deleted*");
    await refreshPersonalPin(ctx, chatId);
    await ack.toast("🗑️ Transaction deleted");
  },

  async report(ctx, { chatId, messageId, state, from, ack }) {
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
    if (ack) await ack.toast("📩 Reported — thanks!");
  },

  rr: reread,
  rra: rereadAccept,
  rrk: rereadKeep,

  async rvok(ctx, { chatId, messageId, state, ack }) {
    if (state.txn.status === "review") {
      await updateTransaction(ctx.db, chatId, state.txn.id, { status: "confirmed", reviewNote: null }, ctx.now());
      state.txn.status = "confirmed";
      await touchActivity(ctx.db, chatId, ctx.now());
      await refreshPersonalPin(ctx, chatId);
    }
    await editCard(ctx, chatId, messageId, state);
    if (ack) await ack.toast("✅ Saved");
  },

  async rvno(ctx, { chatId, messageId, state, ack }) {
    await softDeleteTransaction(ctx.db, chatId, state.txn.id, ctx.now());
    await ctx.tg.editMessageText(chatId, messageId, "✖ *Discarded*");
    if (ack) await ack.toast("✖ Discarded");
  }
};

// ─── Pending replies & /cancel ───────────────────────────────────────

export async function handleCancel(ctx, m) {
  const pendingTag = await takePending(ctx, "tag", m.userId);
  if (pendingTag) {
    if (pendingTag.promptMessageId) await ctx.tg.deleteMessage(m.chatId, pendingTag.promptMessageId).catch(() => {});
    await ctx.tg.sendMessage(m.chatId, "↩️ *Tag unchanged.*");
    return;
  }
  const pendingAmt = await takePending(ctx, "amount", m.userId);
  if (pendingAmt) {
    if (pendingAmt.promptMessageId) await ctx.tg.deleteMessage(m.chatId, pendingAmt.promptMessageId).catch(() => {});
    await ctx.tg.sendMessage(m.chatId, "↩️ *Amount unchanged.*");
    return;
  }
  const hadConversation = await cancelOpenConversation(ctx, m.chatId);
  await ctx.tg.sendMessage(m.chatId, hadConversation ? "↩️ Cancelled." : "Nothing to cancel.", {
    parse_mode: null
  });
}

export async function handleAmountReply(ctx, m) {
  const pending = await getPending(ctx, "amount", m.userId);
  if (!pending) return false;
  const amountMinor = parseAmountInput(m.text);
  if (amountMinor === null) {
    await ctx.tg.sendMessage(m.chatId, "❌ *That's not an amount.* Try `1250` or `1250.50`, or /cancel.");
    return true;
  }
  await clearPending(ctx, "amount", m.userId);
  if (pending.promptMessageId) await ctx.tg.deleteMessage(m.chatId, pending.promptMessageId).catch(() => {});
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
  if (m.raw && m.raw.message_id && ctx.tg.setMessageReaction) {
    await ctx.tg.setMessageReaction(m.chatId, m.raw.message_id, "👍").catch(() => {});
  }
  return true;
}

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
  if (pending.promptMessageId) await ctx.tg.deleteMessage(m.chatId, pending.promptMessageId).catch(() => {});
  const state = await loadCardState(ctx, m.chatId, pending.txnId);
  if (!state || state.txn.status === "deleted") {
    await notFound(ctx, m.chatId);
    return true;
  }
  const res = await mutateTransaction(
    ctx,
    m.chatId,
    state.txn.id,
    { merchant: text, inferCategory: true },
    { refreshCard: false }
  );
  if (res.ok) {
    Object.assign(state.txn, res.txn);
    if (pending.messageId) await editCard(ctx, m.chatId, pending.messageId, state);
  }
  if (m.raw && m.raw.message_id && ctx.tg.setMessageReaction) {
    await ctx.tg.setMessageReaction(m.chatId, m.raw.message_id, "👍").catch(() => {});
  }
  return true;
}

// ─── Deterministic swipe-reply-to-card tagging shortcut ──────────────

const CATEGORY_ALIASES = {
  food: "Food",
  dining: "Food",
  "food & dining": "Food",
  grocery: "Groceries",
  groceries: "Groceries",
  shopping: "Shopping",
  shop: "Shopping",
  education: "Shopping",
  health: "Health",
  healthcare: "Health",
  medical: "Health",
  medicine: "Health",
  pharmacy: "Health",
  travel: "Travel",
  cab: "Travel",
  flight: "Travel",
  fuel: "Travel",
  petrol: "Travel",
  transport: "Travel",
  bills: "Bills",
  utilities: "Bills",
  "bills & utilities": "Bills",
  rent: "Bills",
  maintenance: "Bills",
  subscriptions: "Bills",
  subs: "Bills",
  subscription: "Bills",
  fun: "Fun",
  entertainment: "Fun",
  movies: "Fun",
  invest: "Invest",
  investment: "Invest",
  transfer: "Transfer",
  trf: "Transfer",
  "transfer out": "Transfer",
  "transfer in": "Transfer",
  "cc bill": "Transfer",
  "card bill": "Transfer",
  "cc bill payment": "Transfer",
  income: "Income",
  salary: "Income",
  interest: "Income",
  dividend: "Income",
  refund: "Refund",
  cashback: "Refund",
  reimburse: "Refund",
  reimbursement: "Refund"
};

const CONVERSATIONAL_REPLY_RE =
  /[?]|^(?:split|settle|undo|delete|remove|discard|how|what|why|when|where|who|show|list|export|cancel|make\s+it|change\s+amount|fix)\b/i;

export function matchCategoryToken(raw, direction) {
  const token = String(raw || "").trim();
  if (!token) return null;
  const valid = categoriesFor(direction);
  const lower = token.toLowerCase();
  const exact = valid.find((c) => c.toLowerCase() === lower || CATEGORY_EMOJIS[c] === token);
  if (exact) return exact;
  const alias = CATEGORY_ALIASES[lower];
  return alias && valid.includes(alias) ? alias : null;
}

export function parseCardQuickReply(text, direction, rules = []) {
  const s = String(text || "").trim();
  if (!s || s.length > 50 || /\n/.test(s) || CONVERSATIONAL_REPLY_RE.test(s)) return null;

  const catOnly = matchCategoryToken(s, direction);
  if (catOnly) return { merchant: null, category: catOnly };

  const parts = s.split(/\s*(?:,|·|\||\/|\s-\s)\s*/);
  if (parts.length === 2) {
    const m = parts[0].trim();
    const c = matchCategoryToken(parts[1], direction);
    if (m && m.length <= TAG_MAX_LEN && c) return { merchant: m, category: c };
  }

  if (s.length <= TAG_MAX_LEN && !/^(?:₹|\$|rs\.?|inr)?\s*\d+(?:\.\d+)?$/i.test(s)) {
    const valid = categoriesFor(direction);
    const resolved = resolveMerchant(s, rules);
    const guessed =
      (resolved.category && valid.includes(resolved.category) && resolved.category) ||
      guessCategory(s, direction === "credit" ? "Credit" : "Debit") ||
      null;
    return { merchant: s, category: guessed && valid.includes(guessed) ? guessed : null };
  }
  return null;
}

export async function handleCardReply(ctx, m) {
  if (!m.replyTo || !m.replyTo.message_id) return false;
  const txn = await findTransactionByCardMessage(ctx.db, m.chatId, m.replyTo.message_id);
  if (!txn || txn.status === "deleted") return false;
  const rules = await getMerchantRules(ctx.db, m.chatId);
  const parsed = parseCardQuickReply(m.text, txn.direction, rules);
  if (!parsed || (!parsed.merchant && !parsed.category)) return false;

  const res = await mutateTransaction(
    ctx,
    m.chatId,
    txn.id,
    { merchant: parsed.merchant || undefined, category: parsed.category || undefined },
    { refreshCard: false }
  );
  if (!res.ok) return false;

  const freshState = await loadCardState(ctx, m.chatId, txn.id);
  if (freshState) await editCard(ctx, m.chatId, m.replyTo.message_id, freshState);
  if (m.raw && m.raw.message_id && ctx.tg.setMessageReaction) {
    await ctx.tg.setMessageReaction(m.chatId, m.raw.message_id, "👍").catch(() => {});
  }
  return true;
}
