// AI-assisted batch confirmation + 1-by-1 untagged stepper (driven from the
// 21:00 IST Daily Recap and the pinned DM summary card).
//
// Default flow:
//   - Suggests categories (and precedent-backed merchant labels) for up to 8
//     untagged rows in one batched LLM call, letting the user confirm all
//     confident suggestions in 1 tap (`[✅ Accept N]`) or tweak exceptions via
//     a single swipe-reply (e.g. `2 Shopping, 4 Chai Food` or `4 Chai Food, ok`).
//   - Falls back seamlessly to 1-by-1 category pills (`[🎯 1-by-1]`) when no
//     confident suggestions exist or when the user prefers tapping one by one.
import { getTenant } from "../db/tenants.js";
import {
  getTransaction,
  countUntaggedTransactions,
  listUntaggedWithSignals,
  isUntaggedTransaction,
  isUnnamedTransaction
} from "../db/transactions.js";
import { getMerchantRules } from "../db/merchantRules.js";
import { getCardLabelsMap } from "../db/accountLabels.js";
import { putEphemeral, getEphemeral, deleteEphemeral } from "../db/ephemeral.js";
import { mutateTransaction, batchMutateTransactions } from "./ledger.js";
import { parseCardQuickReply, applyCardQuickReply, matchCategoryToken } from "./cardActions.js";
import { cardText } from "./cards.js";
import { quickMerchantChoices } from "./merchants.js";
import { refreshPersonalPin } from "./personalPin.js";
import { suggestTagsForBatch, extractIstTimeInfo, calendarInfo } from "./tagSuggester.js";
import { CATEGORIES, CREDIT_CATEGORIES, CATEGORY_EMOJIS, TAG_MAX_LEN, categoriesFor } from "./constants.js";
import { escapeMarkdown, money, formatDayMonth } from "./format.js";
import { istDate, shiftIsoDate } from "../util/dates.js";

const STEPPER_TTL_SEC = 86400;
export const BATCH_SIZE = 8;
export const stepperKey = (chatId, messageId) => "stepper:" + chatId + ":" + messageId;

const BATCH_ACCEPT_RE = /^(?:ok|okay|yes|accept|accept\s+all|save|confirm|all|✓|✅)$/i;
const BATCH_SKIP_TOKEN_RE = /^(?:skip|no|none|ignore|-)$/i;
const BATCH_CONVERSATIONAL_SEG_RE =
  /[?]|\b(?:delete|remove|discard|split|settle|undo|unsplit|not\s+sure|don'?t\s+know|maybe|probably|except|instead|was|were)\b/i;

function isPendingInStepper(txn, includeUnnamed = false) {
  return isUntaggedTransaction(txn) || (Boolean(includeUnnamed) && isUnnamedTransaction(txn));
}

function quickChipsForStepperRow(txn, rules = [], cardLabelsMap = {}) {
  if (!txn || !isUnnamedTransaction(txn) || !txn.category) return [];
  const learned = (rules || []).filter((r) => r.personal && r.name && r.category === txn.category).map((r) => r.name);
  return quickMerchantChoices({
    direction: txn.direction,
    category: txn.category,
    cardLabelsMap,
    recentMerchants: learned
  }).slice(0, 3);
}

function defaultWindow(nowMs) {
  const to = istDate(nowMs);
  return { windowFrom: shiftIsoDate(to, -30), windowTo: to };
}

async function isPinnedMessage(db, chatId, messageId) {
  const tenant = await getTenant(db, chatId);
  return Boolean(tenant && tenant.pin_message_id && String(tenant.pin_message_id) === String(messageId));
}

export async function saveStepperState(ctx, chatId, messageId, state) {
  await putEphemeral(ctx.db, stepperKey(chatId, messageId), state, STEPPER_TTL_SEC, ctx.now());
}

export function formatBatchSuggestionsSection(rows, items, totalLeft, doneCount = 0, { cardLabelsMap = {} } = {}) {
  const allHaveCategory = rows.length > 0 && rows.every((r) => !isUntaggedTransaction(r));
  const rangeLabel = rows.length < totalLeft ? rows.length + " of " + totalLeft + " left" : totalLeft + " left";
  const doneNote = doneCount > 0 ? " · ✓ " + doneCount + " done" : "";
  const title = allHaveCategory ? "🏷 *Name unknown transactions*" : "✨ *Suggested tags*";
  const lines = [title + " _(" + rangeLabel + doneNote + ")_", ""];

  rows.forEach((r, i) => {
    const it = items[i] || {};
    const dot = r.direction === "debit" ? "🔴" : "🟢";
    const amt = money(r.amount_minor, r.currency);
    const curName = r.merchant && String(r.merchant).trim().toLowerCase() !== "unknown" ? r.merchant : null;
    const baseLabel = curName ? "*" + escapeMarkdown(curName) + "* — " + amt : "*" + amt + "*";
    const whenParts = [];
    if (it.weekday) whenParts.push(it.weekday);
    whenParts.push(formatDayMonth(r.occurred_on));
    if (it.displayTime) whenParts.push(it.displayTime);
    const when = "_" + escapeMarkdown(whenParts.join(" ")) + "_";
    const acct = r.account_last4 ? " · " + escapeMarkdown(cardLabelsMap[r.account_last4] || "*" + r.account_last4) : "";

    if (it.confident && (it.category || it.merchant)) {
      const cat = it.category || r.category;
      const catEmoji = CATEGORY_EMOJIS[cat] || "📂";
      const proposedMerchant =
        it.merchant && (!curName || it.merchant.toLowerCase() !== curName.toLowerCase())
          ? "*" + escapeMarkdown(it.merchant) + "* · "
          : "";
      lines.push(
        i +
          1 +
          ". ✓ " +
          dot +
          " " +
          baseLabel +
          " · " +
          when +
          acct +
          " → " +
          proposedMerchant +
          catEmoji +
          " *" +
          escapeMarkdown(cat) +
          "*"
      );
    } else if (!isUntaggedTransaction(r) && r.category) {
      const catEmoji = CATEGORY_EMOJIS[r.category] || "📂";
      lines.push(
        i + 1 + ". " + dot + " " + baseLabel + " · " + when + acct + " · " + catEmoji + " " + escapeMarkdown(r.category)
      );
    } else {
      const exIdx = i + 1;
      const hint =
        r.direction === "credit"
          ? curName
            ? "`" + exIdx + " Refund`"
            : "`" + exIdx + " Dividend`"
          : curName
            ? "`" + exIdx + " Food`"
            : "`" + exIdx + " Chai Food`";
      lines.push(i + 1 + ". ❓ " + dot + " " + baseLabel + " · " + when + acct + " → _reply_ " + hint);
    }
  });

  lines.push(
    "",
    allHaveCategory
      ? "💡 *Swipe-reply* names (e.g. `1 MedPlus, 2 Lenskart`), or tap:"
      : "💡 *Swipe-reply* overrides (e.g. `1 Food, 2 CC Bill`), or tap:"
  );
  return lines.join("\n");
}

export function batchStepperKeyboard(items) {
  const confidentCount = (items || []).filter((it) => it.confident && (it.category || it.merchant)).length;
  const rows = [];
  if (confidentCount > 0) {
    rows.push([
      {
        text: "✅ Accept " + confidentCount + (confidentCount === 1 ? " suggestion" : " suggestions"),
        callback_data: "tagq_accept"
      }
    ]);
  }
  rows.push([
    { text: "🎯 1-by-1", callback_data: "tagq_msingle" },
    { text: "⏭ Skip", callback_data: "tagq_bskip" },
    { text: "✖ Done", callback_data: "tagq_done" }
  ]);
  return { inline_keyboard: rows };
}

function singleStepperKeyboard(txn, suggestion, totalLeft, { quickChips = [] } = {}) {
  const cats = txn.direction === "credit" ? CREDIT_CATEGORIES : CATEGORIES;
  const rows = [];
  if (suggestion && suggestion.confident && (suggestion.category || suggestion.merchant)) {
    const cat = suggestion.category || txn.category;
    const emoji = (cat && CATEGORY_EMOJIS[cat]) || "✨";
    const namePart = suggestion.merchant ? suggestion.merchant + (cat ? " · " : "") : "";
    rows.push([
      {
        text: "✅ " + namePart + (cat ? emoji + " " + cat : ""),
        callback_data: "tagq_saccept"
      }
    ]);
  }
  if (quickChips.length > 0) {
    rows.push(
      quickChips.map((chip, idx) => ({
        text: chip,
        callback_data: "tagqm_" + txn.id + "_" + idx
      }))
    );
  }
  for (let i = 0; i < cats.length; i += 3) {
    rows.push(
      cats.slice(i, i + 3).map((c, j) => ({
        text: (CATEGORY_EMOJIS[c] ? CATEGORY_EMOJIS[c] + " " : "") + c,
        callback_data: "tagqc_" + txn.id + "_" + (i + j)
      }))
    );
  }
  const nav = [];
  if (totalLeft > 1) nav.push({ text: "✨ Batch", callback_data: "tagq_mbatch" });
  nav.push({ text: "⏭ Skip", callback_data: "tagq_skip_" + txn.id });
  nav.push({ text: "✖ Done", callback_data: "tagq_done" });
  rows.push(nav);
  return { inline_keyboard: rows };
}

function singleStepBody(current, pos, totalLeft, doneCount, suggestion, { quickChips = [], cardLabelsMap = {} } = {}) {
  const doneNote = doneCount > 0 ? " · ✓ " + doneCount + " done" : "";
  const title = isUntaggedTransaction(current) ? "🏷 *Categorize*" : "🏷 *Name merchant*";
  const header = title + " _(" + pos + " of " + totalLeft + " left" + doneNote + ")_\n\n";
  const meta = [];
  const timeInfo = extractIstTimeInfo(current);
  if (timeInfo.display12h) meta.push("⏰ " + escapeMarkdown(timeInfo.display12h));
  if (current.account_last4) {
    meta.push("💳 " + escapeMarkdown(cardLabelsMap[current.account_last4] || "*" + current.account_last4));
  }
  let extraLine = current.merchant ? "_Tap a category or swipe-reply a new name_" : null;
  if (!current.merchant && (meta.length > 0 || quickChips.length > 0)) {
    const prefix = meta.length > 0 ? meta.join(" · ") + "\n" : "";
    extraLine =
      prefix +
      (quickChips.length > 0 ? "_Tap a merchant chip or swipe-reply any name_" : "_Swipe-reply a merchant name_");
  }
  if (suggestion && suggestion.confident && (suggestion.category || suggestion.merchant)) {
    const cat = suggestion.category || current.category;
    const emoji = (cat && CATEGORY_EMOJIS[cat]) || "📂";
    const namePart = suggestion.merchant ? "*" + escapeMarkdown(suggestion.merchant) + "* · " : "";
    extraLine = "✨ Suggested: " + namePart + (cat ? emoji + " *" + escapeMarkdown(cat) + "*" : "");
  }
  return header + cardText(current, { extraLine });
}

function exactCategoryOnly(raw, direction) {
  const token = String(raw || "").trim();
  if (!token) return null;
  const valid = categoriesFor(direction);
  const lower = token.toLowerCase();
  return valid.find((c) => c.toLowerCase() === lower || CATEGORY_EMOJIS[c] === token) || null;
}

// Parse one segment like "Chai, Food" or "Chai Food" or "Shopping" or "cc bill" against `row`.
function parseItemOverride(expr, row, rules) {
  const s = String(expr || "").trim();
  if (!s) return null;
  if (BATCH_SKIP_TOKEN_RE.test(s)) return { skip: true };
  if (BATCH_CONVERSATIONAL_SEG_RE.test(s)) return null;
  const hasMerchant = Boolean(row.merchant && String(row.merchant).trim().toLowerCase() !== "unknown");

  // Single category/alias token ("Shopping", "cc bill", "dividend") or explicit separator ("Chai, Food").
  if (matchCategoryToken(s, row.direction) || /[,·|/]|(?:\s-\s)/.test(s)) {
    const direct = parseCardQuickReply(s, row.direction, rules, { hasMerchant });
    if (direct && !direct.action && (direct.merchant || direct.category)) {
      return { merchant: direct.merchant || null, category: direct.category || null };
    }
  }

  // Space-separated `<merchant words> <exact category>` (e.g. "Chai Food" or "Auto Travel").
  const words = s.split(/\s+/);
  if (words.length >= 2 && words.length <= 5) {
    const tailCat = exactCategoryOnly(words[words.length - 1], row.direction);
    const headMerchant = words.slice(0, -1).join(" ").trim();
    if (tailCat && headMerchant && headMerchant.length <= TAG_MAX_LEN) {
      return { merchant: headMerchant, category: tailCat };
    }
  }

  if (words.length > 4) return null;
  const fallback = parseCardQuickReply(s, row.direction, rules, { hasMerchant });
  if (fallback && !fallback.action && (fallback.merchant || fallback.category)) {
    return { merchant: fallback.merchant || null, category: fallback.category || null };
  }
  return null;
}

// Parse numbered batch swipe-replies:
//   "ok" / "accept" -> { acceptNow: true, edits: [] }
//   "2 Shopping, 4 Chai Food" -> { acceptNow: false, edits: [...] }
//   "1-3 Food, 4 skip, ok" -> { acceptNow: true, edits: [...] }
export function parseBatchStepperReply(text, items, rowsById, rules = []) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 240) return null;
  if (BATCH_ACCEPT_RE.test(raw)) return { acceptNow: true, edits: [] };

  const segments = raw
    .split(/\s*(?:;|\n|,)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!segments.length) return null;

  // Re-join `<idx> <merchant>, <category>` segments where `, <category>` had no leading index.
  const merged = [];
  for (const seg of segments) {
    if (
      merged.length > 0 &&
      !/^(?:\d+|ok|okay|yes|accept|accept\s+all|save|confirm|all|✓|✅)\b/i.test(seg) &&
      /^\d/.test(merged[merged.length - 1])
    ) {
      merged[merged.length - 1] += ", " + seg;
    } else {
      merged.push(seg);
    }
  }

  // Single-item batch convenience: allow bare "Chai, Food" without leading "1 ".
  if (merged.length === 1 && items.length === 1 && !/^\d/.test(merged[0])) {
    const row = rowsById.get(items[0].id);
    if (!row) return null;
    const ov = parseItemOverride(merged[0], row, rules);
    if (!ov) return null;
    return { acceptNow: true, edits: [{ index: 0, ...ov }] };
  }

  let acceptNow = false;
  const edits = [];
  for (const seg of merged) {
    if (BATCH_ACCEPT_RE.test(seg)) {
      acceptNow = true;
      continue;
    }
    const m = seg.match(/^(\d+(?:\s*[-–]\s*\d+)?)\s*[:.)\-]?\s+(.+)$/);
    if (!m) return null;
    const rangeStr = m[1];
    const expr = m[2].trim();
    const indices = [];
    if (/[-–]/.test(rangeStr)) {
      const [a, b] = rangeStr.split(/\s*[-–]\s*/).map(Number);
      if (!a || !b || a > b || b - a > BATCH_SIZE) return null;
      for (let k = a; k <= b; k++) indices.push(k - 1);
    } else {
      indices.push(Number(rangeStr) - 1);
    }
    for (const idx of indices) {
      if (idx < 0 || idx >= items.length) return null;
      const row = rowsById.get(items[idx].id);
      if (!row) return null;
      const ov = parseItemOverride(expr, row, rules);
      if (!ov) return null;
      edits.push({ index: idx, ...ov });
    }
  }
  return edits.length > 0 ? { acceptNow, edits } : null;
}

async function commitBatchItems(ctx, chatId, items) {
  const confident = (items || []).filter((it) => it.confident && (it.category || it.merchant));
  if (!confident.length) return { accepted: 0, autoFilled: 0 };
  const payload = confident.map((it) => ({
    transaction_id: it.id,
    merchant: it.merchant || undefined,
    category: it.category || undefined
  }));
  const res = await batchMutateTransactions(ctx, chatId, payload);
  return {
    accepted: (res.results || []).filter((r) => r.ok).length,
    autoFilled: res.auto_categorized_count || res.auto_filled || 0
  };
}

async function loadWindowBatch(
  ctx,
  chatId,
  { windowFrom, windowTo, includeUnnamed = false, spendOnly = false, skippedIds = [], limit = BATCH_SIZE }
) {
  const totalLeft = await countUntaggedTransactions(ctx.db, chatId, {
    from: windowFrom,
    to: windowTo,
    includeUnnamed,
    spendOnly
  });
  if (totalLeft === 0) return { totalLeft: 0, rows: [], wrappedSkips: [] };

  let activeSkips = skippedIds.slice();
  let rows = await listUntaggedWithSignals(ctx.db, chatId, {
    from: windowFrom,
    to: windowTo,
    includeUnnamed,
    spendOnly,
    excludeIds: activeSkips,
    limit
  });
  // If every remaining untagged item was previously skipped, wrap around cleanly.
  if (rows.length === 0) {
    activeSkips = [];
    rows = await listUntaggedWithSignals(ctx.db, chatId, {
      from: windowFrom,
      to: windowTo,
      includeUnnamed,
      spendOnly,
      limit
    });
  }
  return { totalLeft, rows, wrappedSkips: activeSkips };
}

async function renderUntaggedView(ctx, chatId, messageId, prevState = {}, { sendAsNew = false, stayId = null } = {}) {
  const def = defaultWindow(ctx.now());
  const windowFrom = prevState.windowFrom !== undefined ? prevState.windowFrom : def.windowFrom;
  const windowTo = prevState.windowTo !== undefined ? prevState.windowTo : def.windowTo;
  const includeUnnamed = Boolean(prevState.includeUnnamed);
  const spendOnly = Boolean(prevState.spendOnly);
  const doneCount = prevState.doneCount || 0;
  const requestedMode = prevState.mode || "auto";

  const { totalLeft, rows, wrappedSkips } = await loadWindowBatch(ctx, chatId, {
    windowFrom,
    windowTo,
    includeUnnamed,
    spendOnly,
    skippedIds: prevState.skippedIds || [],
    limit: BATCH_SIZE
  });

  if (totalLeft === 0 || rows.length === 0) {
    if (messageId) await deleteEphemeral(ctx.db, stepperKey(chatId, messageId));
    if (!sendAsNew && messageId && (await isPinnedMessage(ctx.db, chatId, messageId))) {
      await refreshPersonalPin(ctx, chatId);
      return { empty: true };
    }
    const doneSummary =
      doneCount > 0
        ? "✅ *All caught up!* Tagged " + doneCount + " transaction" + (doneCount === 1 ? "" : "s") + "."
        : "✅ *All caught up!*\nEvery recent transaction has a category.";
    if (sendAsNew || !messageId) {
      await ctx.tg.sendMessage(chatId, doneSummary);
    } else {
      await ctx.tg.editMessageText(chatId, messageId, doneSummary, { reply_markup: { inline_keyboard: [] } });
    }
    return { empty: true };
  }

  const [rules, cardLabelsMap] = await Promise.all([
    getMerchantRules(ctx.db, chatId),
    getCardLabelsMap(ctx.db, chatId)
  ]);

  // Reuse cached suggestions if switching modes on the exact same row set;
  // skip the LLM suggester entirely when every row already has a category (0ms!).
  let items = null;
  if (
    Array.isArray(prevState.items) &&
    prevState.items.length === rows.length &&
    prevState.items.every((it, idx) => it.id === rows[idx].id)
  ) {
    items = prevState.items;
  } else if (rows.every((r) => !isUntaggedTransaction(r))) {
    items = rows.map((r) => {
      const t = extractIstTimeInfo(r);
      const cal = calendarInfo(r.occurred_on);
      return {
        id: r.id,
        merchant: null,
        category: r.category,
        confident: false,
        displayTime: t.display12h,
        weekday: cal.weekday
      };
    });
  } else {
    const rawItems = await suggestTagsForBatch(ctx, chatId, rows);
    items = rawItems.map((it, idx) => {
      const r = rows[idx];
      if (!isUntaggedTransaction(r) && !it.merchant) {
        return { ...it, category: r.category, confident: false };
      }
      return it;
    });
  }

  const hasConfident = items.some((it) => it.confident && (it.category || it.merchant));
  const effectiveMode =
    requestedMode === "single"
      ? "single"
      : requestedMode === "batch"
        ? hasConfident || rows.length > 1 || includeUnnamed
          ? "batch"
          : "single"
        : hasConfident || (includeUnnamed && rows.length > 1)
          ? "batch"
          : "single";

  if (effectiveMode === "batch") {
    const text = formatBatchSuggestionsSection(rows, items, totalLeft, doneCount, { cardLabelsMap });
    const replyMarkup = batchStepperKeyboard(items);
    let targetMsgId = messageId;
    if (sendAsNew || !messageId) {
      const posted = await ctx.tg.sendMessage(chatId, text, { reply_markup: replyMarkup });
      targetMsgId = posted && posted.message_id;
    } else {
      await ctx.tg.editMessageText(chatId, messageId, text, { reply_markup: replyMarkup });
    }
    if (targetMsgId) {
      await saveStepperState(ctx, chatId, targetMsgId, {
        mode: "batch",
        windowFrom,
        windowTo,
        includeUnnamed,
        spendOnly,
        skippedIds: wrappedSkips,
        doneCount,
        items
      });
    }
    return { empty: false, mode: "batch", messageId: targetMsgId, count: totalLeft };
  }

  // Single (1-by-1) mode.
  let idx = 0;
  if (stayId) {
    const found = rows.findIndex((r) => r.id === stayId);
    if (found >= 0) idx = found;
  }
  const current = rows[idx];
  const suggestion = items[idx] || null;
  const quickChips = quickChipsForStepperRow(current, rules, cardLabelsMap);
  const pos = Math.min(wrappedSkips.length + idx + 1, totalLeft);
  const text = singleStepBody(current, pos, totalLeft, doneCount, suggestion, { quickChips, cardLabelsMap });
  const replyMarkup = singleStepperKeyboard(current, suggestion, totalLeft, { quickChips });

  let targetMsgId = messageId;
  if (sendAsNew || !messageId) {
    const posted = await ctx.tg.sendMessage(chatId, text, { reply_markup: replyMarkup });
    targetMsgId = posted && posted.message_id;
  } else {
    await ctx.tg.editMessageText(chatId, messageId, text, { reply_markup: replyMarkup });
  }
  if (targetMsgId) {
    await saveStepperState(ctx, chatId, targetMsgId, {
      mode: "single",
      txnId: current.id,
      suggestion,
      windowFrom,
      windowTo,
      includeUnnamed,
      spendOnly,
      skippedIds: wrappedSkips,
      doneCount,
      items
    });
  }
  return { empty: false, mode: "single", messageId: targetMsgId, count: totalLeft };
}

// Open an interactive tagging card directly from conversational requests.
export async function openUntaggedCard(
  ctx,
  chatId,
  { windowFrom, windowTo, includeUnnamed = false, spendOnly = false } = {}
) {
  let effectiveIncludeUnnamed = Boolean(includeUnnamed);
  let effectiveSpendOnly = Boolean(spendOnly);
  let total = await countUntaggedTransactions(ctx.db, chatId, {
    from: windowFrom,
    to: windowTo,
    includeUnnamed: effectiveIncludeUnnamed,
    spendOnly: effectiveSpendOnly
  });
  if (total === 0 && !effectiveIncludeUnnamed) {
    const unnamedSpends = await countUntaggedTransactions(ctx.db, chatId, {
      from: windowFrom,
      to: windowTo,
      includeUnnamed: true,
      spendOnly: true
    });
    if (unnamedSpends > 0) {
      effectiveIncludeUnnamed = true;
      effectiveSpendOnly = true;
      total = unnamedSpends;
    }
  }
  if (total === 0) return { count: 0, sent: false };
  const view = await renderUntaggedView(
    ctx,
    chatId,
    null,
    {
      windowFrom,
      windowTo,
      includeUnnamed: effectiveIncludeUnnamed,
      spendOnly: effectiveSpendOnly,
      mode: "batch"
    },
    { sendAsNew: true }
  );
  return {
    count: total,
    sent: !view.empty,
    include_unnamed: effectiveIncludeUnnamed,
    message_id: view.messageId || null
  };
}

// Refresh an active stepper card in-place after an LLM fallback mutation/delete.
export async function refreshStepperMessage(ctx, chatId, messageId, deltaDone = 0) {
  if (!messageId) return;
  const active = await getEphemeral(ctx.db, stepperKey(chatId, messageId), ctx.now());
  if (!active) return;
  await renderUntaggedView(ctx, chatId, messageId, {
    ...active,
    items: null,
    doneCount: (active.doneCount || 0) + Math.max(0, deltaDone)
  }).catch(() => {});
}

export async function handleTagQueueCallback(ctx, { chatId, messageId, action, payload, ack }) {
  if (action === "tagq" && payload === "done") {
    await deleteEphemeral(ctx.db, stepperKey(chatId, messageId));
    if (await isPinnedMessage(ctx.db, chatId, messageId)) {
      await refreshPersonalPin(ctx, chatId);
    } else {
      let deleted = false;
      try {
        await ctx.tg.deleteMessage(chatId, messageId);
        deleted = true;
      } catch (_) {}
      if (!deleted) {
        await ctx.tg.editMessageText(
          chatId,
          messageId,
          "👍 *Paused tagging.* Tap the pinned summary anytime to resume.",
          { reply_markup: { inline_keyboard: [] } }
        );
      }
    }
    if (ack) await ack.toast("👍 Done");
    return;
  }

  const active = (await getEphemeral(ctx.db, stepperKey(chatId, messageId), ctx.now())) || {};

  if (action === "tagq" && payload === "next") {
    const fromPin = await isPinnedMessage(ctx.db, chatId, messageId);
    if (ack) await ack.toast("✨ Checking suggestions…");
    if (fromPin) {
      const def = defaultWindow(ctx.now());
      const total = await countUntaggedTransactions(ctx.db, chatId, { from: def.windowFrom, to: def.windowTo });
      if (total === 0) {
        await refreshPersonalPin(ctx, chatId);
        return;
      }
      await renderUntaggedView(ctx, chatId, messageId, def, { sendAsNew: true });
      return;
    }
    const today = istDate(ctx.now());
    const initWindow = active.windowFrom ? active : { windowFrom: shiftIsoDate(today, -7), windowTo: today };
    await renderUntaggedView(ctx, chatId, messageId, initWindow);
    return;
  }

  if (action === "tagq" && payload === "accept") {
    const items = Array.isArray(active.items) ? active.items : [];
    const { accepted, autoFilled } = await commitBatchItems(ctx, chatId, items);
    if (ack) {
      const extra = autoFilled > 0 ? " · +" + autoFilled + " auto-tagged" : "";
      await ack.toast(accepted > 0 ? "✅ Tagged " + accepted + extra : "Nothing selected");
    }
    const unacceptedIds = items.filter((it) => !(it.confident && it.category)).map((it) => it.id);
    const nextSkips = Array.from(new Set([...(active.skippedIds || []), ...unacceptedIds]));
    await renderUntaggedView(ctx, chatId, messageId, {
      ...active,
      items: null,
      skippedIds: nextSkips,
      doneCount: (active.doneCount || 0) + accepted,
      mode: "auto"
    });
    return;
  }

  if (action === "tagq" && payload === "bskip") {
    if (ack) await ack.toast("⏭ Skipped batch");
    const batchIds = (active.items || []).map((it) => it.id);
    const nextSkips = Array.from(new Set([...(active.skippedIds || []), ...batchIds]));
    await renderUntaggedView(ctx, chatId, messageId, {
      ...active,
      items: null,
      skippedIds: nextSkips
    });
    return;
  }

  if (action === "tagq" && payload === "msingle") {
    if (ack) await ack.toast("🎯 1-by-1 mode");
    await renderUntaggedView(ctx, chatId, messageId, { ...active, mode: "single" });
    return;
  }

  if (action === "tagq" && payload === "mbatch") {
    if (ack) await ack.toast("✨ Batch view");
    await renderUntaggedView(ctx, chatId, messageId, { ...active, mode: "batch" });
    return;
  }

  if (action === "tagq" && payload === "saccept") {
    const sug = active.suggestion;
    const txn = active.txnId && (await getTransaction(ctx.db, chatId, active.txnId));
    let added = 0;
    if (txn && txn.status === "confirmed" && sug && sug.category) {
      const res = await mutateTransaction(ctx, chatId, txn.id, {
        merchant: sug.merchant || undefined,
        category: sug.category
      });
      if (res.ok) {
        added = 1;
        if (ack) {
          const emoji = CATEGORY_EMOJIS[sug.category] ? CATEGORY_EMOJIS[sug.category] + " " : "";
          const extra = res.autoFilled > 0 ? " · +" + res.autoFilled + " auto-tagged" : "";
          await ack.toast("✅ " + emoji + sug.category + extra);
        }
      }
    }
    await renderUntaggedView(ctx, chatId, messageId, {
      ...active,
      items: null,
      doneCount: (active.doneCount || 0) + added,
      mode: "single"
    });
    return;
  }

  if (action === "tagqm") {
    const sep = payload.lastIndexOf("_");
    const maybeIdx = sep > 0 ? parseInt(payload.slice(sep + 1), 10) : NaN;
    const hasChipIdx = !isNaN(maybeIdx) && String(maybeIdx) === payload.slice(sep + 1);
    const txnId = hasChipIdx ? payload.slice(0, sep) : payload;
    const txn = await getTransaction(ctx.db, chatId, txnId);
    let added = 0;
    if (txn && txn.status === "confirmed" && isUnnamedTransaction(txn)) {
      let chosen = null;
      if (hasChipIdx) {
        const [rules, cardLabelsMap] = await Promise.all([
          getMerchantRules(ctx.db, chatId),
          getCardLabelsMap(ctx.db, chatId)
        ]);
        const chips = quickChipsForStepperRow(txn, rules, cardLabelsMap);
        chosen = chips[maybeIdx] || null;
      } else {
        chosen = txn.category || (txn.direction === "credit" ? "Credit" : "Expense");
      }
      if (chosen) {
        const res = await mutateTransaction(ctx, chatId, txn.id, { merchant: chosen });
        if (res.ok) {
          added = 1;
          if (ack) await ack.toast("✓ " + chosen);
        }
      }
    }
    await renderUntaggedView(ctx, chatId, messageId, {
      ...active,
      items: null,
      doneCount: (active.doneCount || 0) + added,
      mode: "single"
    });
    return;
  }

  if (action === "tagqc") {
    const sep = payload.lastIndexOf("_");
    const txnId = payload.slice(0, sep);
    const idx = parseInt(payload.slice(sep + 1), 10);
    const txn = await getTransaction(ctx.db, chatId, txnId);
    let stayId = null;
    let added = 0;
    if (txn && txn.status === "confirmed") {
      const list = categoriesFor(txn.direction);
      if (!isNaN(idx) && idx >= 0 && idx < list.length) {
        const category = list[idx];
        const res = await mutateTransaction(ctx, chatId, txn.id, { category });
        if (res.ok) {
          const stillPending = isPendingInStepper(res.txn, active.includeUnnamed);
          if (stillPending) stayId = txnId;
          else added = 1;
          if (ack) {
            const emoji = CATEGORY_EMOJIS[category] ? CATEGORY_EMOJIS[category] + " " : "";
            const extra = res.autoFilled > 0 ? " · +" + res.autoFilled + " auto-tagged" : "";
            await ack.toast(emoji + category + extra);
          }
        }
      }
    }
    await renderUntaggedView(
      ctx,
      chatId,
      messageId,
      { ...active, items: null, doneCount: (active.doneCount || 0) + added, mode: "single" },
      { stayId }
    );
    return;
  }

  const skipId = payload.startsWith("skip_") ? payload.slice(5) : null;
  const nextSkips = skipId ? Array.from(new Set([...(active.skippedIds || []), skipId])) : active.skippedIds || [];
  await renderUntaggedView(ctx, chatId, messageId, {
    ...active,
    items: null,
    skippedIds: nextSkips,
    mode: "single"
  });
}

export async function handleStepperReply(ctx, m) {
  if (!m.replyTo || !m.replyTo.message_id) return false;
  const messageId = m.replyTo.message_id;
  const active = await getEphemeral(ctx.db, stepperKey(m.chatId, messageId), ctx.now());
  if (!active) return false;

  const reactThumbsUp = async () => {
    if (m.raw && m.raw.message_id && ctx.tg.setMessageReaction) {
      await ctx.tg.setMessageReaction(m.chatId, m.raw.message_id, "👍").catch(() => {});
    }
  };

  if (active.mode === "batch" && Array.isArray(active.items) && active.items.length > 0) {
    const rows = await Promise.all(active.items.map((it) => getTransaction(ctx.db, m.chatId, it.id)));
    const validPairs = [];
    const rowsById = new Map();
    active.items.forEach((it, idx) => {
      const r = rows[idx];
      if (r && r.status === "confirmed") {
        validPairs.push({ item: { ...it }, row: r });
        rowsById.set(it.id, r);
      }
    });
    if (!validPairs.length) return false;

    const rules = await getMerchantRules(ctx.db, m.chatId);
    const itemsCopy = validPairs.map((p) => p.item);
    const preConfidentIndices = new Set();
    itemsCopy.forEach((it, idx) => {
      if (it.confident && (it.category || it.merchant)) preConfidentIndices.add(idx);
    });

    const batchParsed = parseBatchStepperReply(m.text, itemsCopy, rowsById, rules);
    if (!batchParsed) return false;

    const editedIndices = new Set();
    for (const edit of batchParsed.edits) {
      editedIndices.add(edit.index);
      const cur = itemsCopy[edit.index];
      const row = validPairs[edit.index].row;
      if (edit.skip) {
        itemsCopy[edit.index] = { ...cur, confident: false };
      } else {
        const nextCat = edit.category || cur.category || row.category || null;
        const nextMerchant = edit.merchant || cur.merchant || null;
        itemsCopy[edit.index] = {
          ...cur,
          merchant: nextMerchant,
          category: nextCat,
          confident: Boolean(nextCat || nextMerchant)
        };
      }
    }

    await reactThumbsUp();

    const hasUntouchedPreConfident = Array.from(preConfidentIndices).some((idx) => !editedIndices.has(idx));
    if (batchParsed.acceptNow || !hasUntouchedPreConfident) {
      const { accepted } = await commitBatchItems(ctx, m.chatId, itemsCopy);
      const unacceptedIds = itemsCopy
        .filter((it, idx) => editedIndices.has(idx) && !(it.confident && (it.category || it.merchant)))
        .map((it) => it.id);
      const nextSkips = Array.from(new Set([...(active.skippedIds || []), ...unacceptedIds]));
      await renderUntaggedView(ctx, m.chatId, messageId, {
        ...active,
        items: null,
        skippedIds: nextSkips,
        doneCount: (active.doneCount || 0) + accepted,
        mode: active.includeUnnamed ? "batch" : "auto"
      });
      return true;
    }

    // In-place preview update when untouched AI suggestions remain on the card.
    const def = defaultWindow(ctx.now());
    const windowFrom = active.windowFrom !== undefined ? active.windowFrom : def.windowFrom;
    const windowTo = active.windowTo !== undefined ? active.windowTo : def.windowTo;
    const [totalLeft, cardLabelsMap] = await Promise.all([
      countUntaggedTransactions(ctx.db, m.chatId, {
        from: windowFrom,
        to: windowTo,
        includeUnnamed: Boolean(active.includeUnnamed),
        spendOnly: Boolean(active.spendOnly)
      }),
      getCardLabelsMap(ctx.db, m.chatId)
    ]);
    const rowList = validPairs.map((p) => p.row);
    const text = formatBatchSuggestionsSection(rowList, itemsCopy, totalLeft || rowList.length, active.doneCount || 0, {
      cardLabelsMap
    });
    await ctx.tg.editMessageText(m.chatId, messageId, text, {
      reply_markup: batchStepperKeyboard(itemsCopy)
    });
    await saveStepperState(ctx, m.chatId, messageId, { ...active, items: itemsCopy });
    return true;
  }

  if (!active.txnId) return false;
  const txn = await getTransaction(ctx.db, m.chatId, active.txnId);
  if (!txn || txn.status === "deleted") return false;

  const rules = await getMerchantRules(ctx.db, m.chatId);
  const hasMerchant = Boolean(txn.merchant && String(txn.merchant).trim().toLowerCase() !== "unknown");
  const parsed = parseCardQuickReply(m.text, txn.direction, rules, { hasMerchant });
  if (!parsed) return false;

  const outcome = await applyCardQuickReply(ctx, m.chatId, txn, parsed, { cardMessageId: null });
  if (!outcome.handled) return false;

  await reactThumbsUp();
  const stillPending = outcome.updatedTxn ? isPendingInStepper(outcome.updatedTxn, active.includeUnnamed) : false;
  await renderUntaggedView(
    ctx,
    m.chatId,
    messageId,
    {
      ...active,
      items: null,
      doneCount: (active.doneCount || 0) + (stillPending ? 0 : 1),
      mode: "single"
    },
    { stayId: stillPending ? txn.id : null }
  );
  return true;
}
