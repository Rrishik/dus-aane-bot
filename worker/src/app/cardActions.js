// Personal DM card actions: inline buttons (category, ⋯ menu, flip, delete,
// report, review Save/Discard), stateless self-heal for retired buttons, and
// deterministic 0-LLM swipe-reply actions on cards.
import { findTransactionByCardMessage, updateTransaction } from "../db/transactions.js";
import { getMerchantRules, resolveMerchant } from "../db/merchantRules.js";
import { touchActivity, groupsForMember, getGroupMembers } from "../db/tenants.js";
import { logParserEvent } from "../db/settings.js";
import { guessCategory, PARSER_MAX_AMOUNT } from "../parser/index.js";
import { loadCardState, defaultKeyboard, editCard } from "./cardState.js";
import { mutateTransaction, removeTransaction } from "./ledger.js";
import { splitTransaction, undoGroupLink } from "./groups.js";
import { reread, rereadAccept, rereadKeep } from "./reread.js";
import { cancelOpenConversation } from "./orchestrator.js";
import { refreshPersonalPin } from "./personalPin.js";
import { categoryKeyboard, helpMenuKeyboard, deleteConfirmKeyboard } from "./cards.js";
import { CATEGORY_EMOJIS, categoriesFor, TAG_MAX_LEN } from "./constants.js";
import { escapeMarkdown } from "./format.js";
import { toMinor, fromMinor } from "../util/money.js";

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

// "1,250.50", "₹1250", "Rs. 99" → minor units, or null.
export function parseAmountInput(text) {
  const s = String(text || "")
    .trim()
    .replace(/^(?:amt|amount)\s*:?\s*/i, "")
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
  // Stateless self-heal for retired buttons on older scrollback cards.
  async tag(ctx, { chatId, messageId, state, ack }) {
    await editCard(ctx, chatId, messageId, state);
    if (ack) await ack.toast("💡 Swipe-reply on this card with the merchant name");
  },

  async amt(ctx, { chatId, messageId, state, ack }) {
    await editCard(ctx, chatId, messageId, state);
    if (ack) await ack.toast("💡 Swipe-reply on this card with the right amount (e.g. 1250)");
  },

  async fix(ctx, { chatId, messageId, state, ack }) {
    if (await refuseIfSplit(ctx, chatId, messageId, state, ack)) return;
    await ctx.tg.editMessageReplyMarkup(
      chatId,
      messageId,
      helpMenuKeyboard(state.txn.id, {
        canReread: state.canReread,
        canEdit: !state.isSplit,
        direction: state.txn.direction
      })
    );
    if (ack) await ack.toast("💡 Swipe-reply ₹amount to edit amount, or tap Flip below");
  },

  async editcat(ctx, { chatId, messageId, state, ack }) {
    await ctx.tg.editMessageReplyMarkup(
      chatId,
      messageId,
      categoryKeyboard(state.txn.id, categoriesFor(state.txn.direction))
    );
    if (ack && !state.txn.merchant) await ack.toast('💡 Tip: Swipe-reply "Name, Food" to tag both');
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

  async help(ctx, { chatId, messageId, state, ack }) {
    await ctx.tg.editMessageReplyMarkup(
      chatId,
      messageId,
      helpMenuKeyboard(state.txn.id, {
        canReread: state.canReread,
        canEdit: !state.isSplit,
        direction: state.txn.direction
      })
    );
    if (ack) await ack.toast("💡 Tip: Swipe-reply name, ₹amt, flip, or del");
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
    if (ack) await ack.toast(direction === "credit" ? "🟢 Flipped to Credit" : "🔴 Flipped to Debit");
  },

  async back(ctx, { chatId, messageId, state }) {
    await editCard(ctx, chatId, messageId, state);
  },

  async del(ctx, { chatId, messageId, state }) {
    await ctx.tg.editMessageReplyMarkup(chatId, messageId, deleteConfirmKeyboard(state.txn.id));
  },

  async delyes(ctx, { chatId, messageId, state, ack }) {
    const res = await removeTransaction(ctx, chatId, state.txn.id, { cardMessageId: messageId });
    if (!res.ok) {
      await ack.toast("↩️ " + res.error, true);
      if (res.isSplit) await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
      return;
    }
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
    const res = await removeTransaction(ctx, chatId, state.txn.id, {
      cardMessageId: messageId,
      tombstone: "✖ *Discarded*"
    });
    if (!res.ok) {
      await ack.toast("❌ " + res.error, true);
      return;
    }
    if (ack) await ack.toast("✖ Discarded");
  }
};

export async function handleCancel(ctx, m) {
  const hadConversation = await cancelOpenConversation(ctx, m.chatId);
  await ctx.tg.sendMessage(m.chatId, hadConversation ? "↩️ Cancelled." : "Nothing to cancel.", {
    parse_mode: null
  });
}

// ─── Deterministic 0-LLM swipe-reply actions on cards ────────────────

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

const DELETE_REPLY_RE = /^(?:del|delete|remove|discard|🗑\uFE0F?)$/i;
const CONFIRM_REPLY_RE = /^(?:ok|save|confirm|yes|✓|✅)$/i;
const UNDO_REPLY_RE = /^(?:undo|unsplit|personal|make\s+personal)$/i;
const SPLIT_DEFAULT_RE = /^(?:50[-\/]50|split(?:\s+50[-\/]50)?)$/i;
const SPLIT_P100_RE = /^(?:100%|p100|split\s+100%?)$/i;
const SPLIT_ALL_RE = /^split\s+all$/i;
const FLIP_REPLY_RE = /^(?:flip|money\s+in|money\s+out|credit|debit)$/i;

const CONVERSATIONAL_REPLY_RE =
  /[?]|^(?:split|settle|undo|unsplit|flip|amt|amount|make|change|set|fix|how|what|why|when|where|who|show|list|export|cancel)\b/i;

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
  if (!s || s.length > 50 || /\n/.test(s)) return null;

  if (DELETE_REPLY_RE.test(s)) return { action: "delete" };
  if (CONFIRM_REPLY_RE.test(s)) return { action: "confirm" };
  if (UNDO_REPLY_RE.test(s)) return { action: "undo" };
  if (SPLIT_DEFAULT_RE.test(s)) return { action: "split", mode: "default" };
  if (SPLIT_P100_RE.test(s)) return { action: "split", mode: "p100" };
  if (SPLIT_ALL_RE.test(s)) return { action: "split", mode: "all" };
  if (FLIP_REPLY_RE.test(s)) {
    const lower = s.toLowerCase();
    const target = lower === "flip" ? null : lower === "credit" || lower === "money in" ? "credit" : "debit";
    return { action: "flip", direction: target };
  }

  const amountMinor = parseAmountInput(s);
  if (amountMinor !== null) return { action: "amount", amountMinor };

  if (CONVERSATIONAL_REPLY_RE.test(s)) return null;

  const catOnly = matchCategoryToken(s, direction);
  if (catOnly) return { merchant: null, category: catOnly };

  const parts = s.split(/\s*(?:,|·|\||\/|\s-\s)\s*/);
  if (parts.length === 2) {
    const m = parts[0].trim();
    const c = matchCategoryToken(parts[1], direction);
    if (m && m.length <= TAG_MAX_LEN && c) return { merchant: m, category: c };
  }

  if (s.length <= TAG_MAX_LEN && !/^(?:₹|\$|rs\.?|inr)?\s*[\d,.]+$/i.test(s)) {
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

// Execute a parsed quick-reply against `txn`. Returns { handled: boolean, updatedTxn? }.
// When `cardMessageId` is passed, edits that DM card in place; when null (e.g.
// from the untagged stepper), refreshes `txn.card_message_id` via ledger.js.
export async function applyCardQuickReply(ctx, chatId, txn, parsed, { cardMessageId = null } = {}) {
  const refreshInPlace = async () => {
    if (!cardMessageId) return;
    const freshState = await loadCardState(ctx, chatId, txn.id);
    if (freshState) await editCard(ctx, chatId, cardMessageId, freshState);
  };

  if (parsed.action === "delete") {
    const res = await removeTransaction(ctx, chatId, txn.id, { cardMessageId });
    if (!res.ok) {
      if (res.isSplit) {
        await ctx.tg.sendMessage(chatId, "↩️ *Make it personal again first, then delete.*");
        return { handled: true };
      }
      return { handled: false };
    }
    return { handled: true, deleted: true };
  }

  if (parsed.action === "confirm") {
    if (txn.status !== "review") return { handled: false };
    await updateTransaction(ctx.db, chatId, txn.id, { status: "confirmed", reviewNote: null }, ctx.now());
    await touchActivity(ctx.db, chatId, ctx.now());
    await refreshPersonalPin(ctx, chatId);
    await refreshInPlace();
    return { handled: true, updatedTxn: { ...txn, status: "confirmed", review_note: null } };
  }

  if (parsed.action === "undo") {
    const res = await undoGroupLink(ctx, { payerId: chatId, txnId: txn.id });
    if (!res.ok) {
      await ctx.tg.sendMessage(chatId, "⚠️ " + res.error, { parse_mode: null });
      return { handled: true };
    }
    await refreshInPlace();
    return { handled: true };
  }

  if (parsed.action === "split") {
    if (txn.direction !== "debit") {
      await ctx.tg.sendMessage(chatId, "❌ Only money-out expenses can be split.", { parse_mode: null });
      return { handled: true };
    }
    const groups = await groupsForMember(ctx.db, chatId);
    if (groups.length !== 1) return { handled: false }; // Let Groups agent disambiguate
    const members = await getGroupMembers(ctx.db, groups[0].id);
    const mode = parsed.mode === "default" ? (members.length === 2 ? "50" : "all") : parsed.mode;
    const res = await splitTransaction(ctx, { payerId: chatId, txnId: txn.id, groupId: groups[0].id, mode });
    if (!res.ok) {
      await ctx.tg.sendMessage(chatId, "❌ " + res.error, { parse_mode: null });
      return { handled: true };
    }
    await refreshInPlace();
    return { handled: true };
  }

  if (parsed.action === "flip") {
    const nextDir = parsed.direction || (txn.direction === "debit" ? "credit" : "debit");
    if (nextDir === txn.direction && txn.status === "confirmed") return { handled: true, updatedTxn: txn };
    const res = await mutateTransaction(
      ctx,
      chatId,
      txn.id,
      { direction: nextDir, confirmReview: true },
      { refreshCard: !cardMessageId, backfillUntagged: false }
    );
    if (!res.ok) {
      if (res.isSplit) {
        await ctx.tg.sendMessage(chatId, "↩️ *Make it personal again first, then fix it.*");
        return { handled: true };
      }
      return { handled: false };
    }
    if (txn.status === "review") await touchActivity(ctx.db, chatId, ctx.now());
    await refreshInPlace();
    return { handled: true, updatedTxn: res.txn };
  }

  if (parsed.action === "amount") {
    if (parsed.amountMinor === txn.amount_minor && txn.status === "confirmed") {
      return { handled: true, updatedTxn: txn };
    }
    const res = await mutateTransaction(
      ctx,
      chatId,
      txn.id,
      { amountMinor: parsed.amountMinor, confirmReview: true },
      { refreshCard: !cardMessageId, backfillUntagged: false }
    );
    if (!res.ok) {
      if (res.isSplit) {
        await ctx.tg.sendMessage(chatId, "↩️ *Make it personal again first, then fix it.*");
        return { handled: true };
      }
      return { handled: false };
    }
    if (txn.status === "review") await touchActivity(ctx.db, chatId, ctx.now());
    await refreshInPlace();
    return { handled: true, updatedTxn: res.txn };
  }

  if (!parsed.merchant && !parsed.category) return { handled: false };

  const res = await mutateTransaction(
    ctx,
    chatId,
    txn.id,
    {
      merchant: parsed.merchant || undefined,
      category: parsed.category || undefined,
      inferCategory: !!parsed.merchant,
      confirmReview: true
    },
    { refreshCard: !cardMessageId }
  );
  if (!res.ok) return { handled: false };
  if (txn.status === "review") await touchActivity(ctx.db, chatId, ctx.now());
  await refreshInPlace();
  return { handled: true, updatedTxn: res.txn };
}

export async function handleCardReply(ctx, m) {
  if (!m.replyTo || !m.replyTo.message_id) return false;
  const txn = await findTransactionByCardMessage(ctx.db, m.chatId, m.replyTo.message_id);
  if (!txn || txn.status === "deleted") return false;
  const rules = await getMerchantRules(ctx.db, m.chatId);
  const parsed = parseCardQuickReply(m.text, txn.direction, rules);
  if (!parsed) return false;

  const outcome = await applyCardQuickReply(ctx, m.chatId, txn, parsed, { cardMessageId: m.replyTo.message_id });
  if (!outcome.handled) return false;
  if (m.raw && m.raw.message_id && ctx.tg.setMessageReaction) {
    await ctx.tg.setMessageReaction(m.chatId, m.raw.message_id, "👍").catch(() => {});
  }
  return true;
}
