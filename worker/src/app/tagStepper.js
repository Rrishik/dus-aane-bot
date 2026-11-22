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
  isUntaggedTransaction
} from "../db/transactions.js";
import { getMerchantRules } from "../db/merchantRules.js";
import { putEphemeral, getEphemeral, deleteEphemeral } from "../db/ephemeral.js";
import { mutateTransaction, batchMutateTransactions } from "./ledger.js";
import { parseCardQuickReply, applyCardQuickReply, matchCategoryToken } from "./cardActions.js";
import { cardText } from "./cards.js";
import { refreshPersonalPin } from "./personalPin.js";
import { suggestTagsForBatch } from "./tagSuggester.js";
import { CATEGORIES, CREDIT_CATEGORIES, CATEGORY_EMOJIS, TAG_MAX_LEN, categoriesFor } from "./constants.js";
import { escapeMarkdown, money, formatDayMonth } from "./format.js";
import { istDate, shiftIsoDate } from "../util/dates.js";

const STEPPER_TTL_SEC = 86400;
export const BATCH_SIZE = 8;
export const stepperKey = (chatId, messageId) => "stepper:" + chatId + ":" + messageId;

const BATCH_ACCEPT_RE = /^(?:ok|okay|yes|accept|accept\s+all|save|confirm|all|✓|✅)$/i;
const BATCH_SKIP_TOKEN_RE = /^(?:skip|no|none|ignore|-)$/i;

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

export function formatBatchSuggestionsSection(rows, items, totalLeft, doneCount = 0) {
  const rangeLabel = rows.length < totalLeft ? rows.length + " of " + totalLeft + " left" : totalLeft + " left";
  const doneNote = doneCount > 0 ? " · ✓ " + doneCount + " done" : "";
  const lines = ["✨ *Suggested tags* _(" + rangeLabel + doneNote + ")_", ""];

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

    if (it.confident && it.category) {
      const catEmoji = CATEGORY_EMOJIS[it.category] || "📂";
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
          " → " +
          proposedMerchant +
          catEmoji +
          " *" +
          escapeMarkdown(it.category) +
          "*"
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
      lines.push(i + 1 + ". ❓ " + dot + " " + baseLabel + " · " + when + " → _reply_ " + hint);
    }
  });

  lines.push("", "💡 *Swipe-reply* overrides (e.g. `1 Food, 2 CC Bill`), or tap:");
  return lines.join("\n");
}

export function batchStepperKeyboard(items) {
  const confidentCount = (items || []).filter((it) => it.confident && it.category).length;
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

function singleStepperKeyboard(txn, suggestion, totalLeft) {
  const cats = txn.direction === "credit" ? CREDIT_CATEGORIES : CATEGORIES;
  const rows = [];
  if (suggestion && suggestion.confident && suggestion.category) {
    const emoji = CATEGORY_EMOJIS[suggestion.category] || "✨";
    const namePart = suggestion.merchant ? suggestion.merchant + " · " : "";
    rows.push([
      {
        text: "✅ " + namePart + emoji + " " + suggestion.category,
        callback_data: "tagq_saccept"
      }
    ]);
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

function singleStepBody(current, pos, totalLeft, doneCount, suggestion) {
  const doneNote = doneCount > 0 ? " · ✓ " + doneCount + " done" : "";
  const header = "🏷 *Categorize* _(" + pos + " of " + totalLeft + " left" + doneNote + ")_\n\n";
  let extraLine = current.merchant ? "_Tap a category or swipe-reply a new name_" : null;
  if (suggestion && suggestion.confident && suggestion.category) {
    const emoji = CATEGORY_EMOJIS[suggestion.category] || "📂";
    const namePart = suggestion.merchant ? "*" + escapeMarkdown(suggestion.merchant) + "* · " : "";
    extraLine = "✨ Suggested: " + namePart + emoji + " *" + escapeMarkdown(suggestion.category) + "*";
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
  if (words.length >= 2) {
    const tailCat = exactCategoryOnly(words[words.length - 1], row.direction);
    const headMerchant = words.slice(0, -1).join(" ").trim();
    if (tailCat && headMerchant && headMerchant.length <= TAG_MAX_LEN) {
      return { merchant: headMerchant, category: tailCat };
    }
  }

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
  const confident = (items || []).filter((it) => it.confident && it.category);
  if (!confident.length) return { accepted: 0, autoFilled: 0 };
  const payload = confident.map((it) => ({
    transaction_id: it.id,
    merchant: it.merchant || undefined,
    category: it.category
  }));
  const res = await batchMutateTransactions(ctx, chatId, payload);
  return {
    accepted: (res.results || []).filter((r) => r.ok).length,
    autoFilled: res.auto_categorized_count || 0
  };
}

async function loadWindowBatch(ctx, chatId, { windowFrom, windowTo, skippedIds = [], limit = BATCH_SIZE }) {
  const totalLeft = await countUntaggedTransactions(ctx.db, chatId, { from: windowFrom, to: windowTo });
  if (totalLeft === 0) return { totalLeft: 0, rows: [], wrappedSkips: [] };

  let activeSkips = skippedIds.slice();
  let rows = await listUntaggedWithSignals(ctx.db, chatId, {
    from: windowFrom,
    to: windowTo,
    excludeIds: activeSkips,
    limit
  });
  // If every remaining untagged item was previously skipped, wrap around cleanly.
  if (rows.length === 0) {
    activeSkips = [];
    rows = await listUntaggedWithSignals(ctx.db, chatId, {
      from: windowFrom,
      to: windowTo,
      limit
    });
  }
  return { totalLeft, rows, wrappedSkips: activeSkips };
}

async function renderUntaggedView(ctx, chatId, messageId, prevState = {}, { sendAsNew = false, stayId = null } = {}) {
  const def = defaultWindow(ctx.now());
  const windowFrom = prevState.windowFrom || def.windowFrom;
  const windowTo = prevState.windowTo || def.windowTo;
  const doneCount = prevState.doneCount || 0;
  const requestedMode = prevState.mode || "auto";

  const { totalLeft, rows, wrappedSkips } = await loadWindowBatch(ctx, chatId, {
    windowFrom,
    windowTo,
    skippedIds: prevState.skippedIds || [],
    limit: BATCH_SIZE
  });

  if (totalLeft === 0 || rows.length === 0) {
    await deleteEphemeral(ctx.db, stepperKey(chatId, messageId));
    if (!sendAsNew && (await isPinnedMessage(ctx.db, chatId, messageId))) {
      await refreshPersonalPin(ctx, chatId);
      return { empty: true };
    }
    const doneSummary =
      doneCount > 0
        ? "✅ *All caught up!* Tagged " + doneCount + " transaction" + (doneCount === 1 ? "" : "s") + "."
        : "✅ *All caught up!*\nEvery recent transaction has a category.";
    if (sendAsNew) {
      await ctx.tg.sendMessage(chatId, doneSummary);
    } else {
      await ctx.tg.editMessageText(chatId, messageId, doneSummary, { reply_markup: { inline_keyboard: [] } });
    }
    return { empty: true };
  }

  // Reuse cached suggestions if switching modes on the exact same row set; otherwise query suggester.
  let items = null;
  if (
    Array.isArray(prevState.items) &&
    prevState.items.length === rows.length &&
    prevState.items.every((it, idx) => it.id === rows[idx].id)
  ) {
    items = prevState.items;
  } else {
    items = await suggestTagsForBatch(ctx, chatId, rows);
  }

  const hasConfident = items.some((it) => it.confident && it.category);
  const effectiveMode =
    requestedMode === "single"
      ? "single"
      : requestedMode === "batch"
        ? hasConfident || rows.length > 1
          ? "batch"
          : "single"
        : hasConfident
          ? "batch"
          : "single";

  if (effectiveMode === "batch") {
    const text = formatBatchSuggestionsSection(rows, items, totalLeft, doneCount);
    const replyMarkup = batchStepperKeyboard(items);
    let targetMsgId = messageId;
    if (sendAsNew) {
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
        skippedIds: wrappedSkips,
        doneCount,
        items
      });
    }
    return { empty: false, mode: "batch", messageId: targetMsgId };
  }

  // Single (1-by-1) mode.
  let idx = 0;
  if (stayId) {
    const found = rows.findIndex((r) => r.id === stayId);
    if (found >= 0) idx = found;
  }
  const current = rows[idx];
  const suggestion = items[idx] || null;
  const pos = Math.min(wrappedSkips.length + idx + 1, totalLeft);
  const text = singleStepBody(current, pos, totalLeft, doneCount, suggestion);
  const replyMarkup = singleStepperKeyboard(current, suggestion, totalLeft);

  let targetMsgId = messageId;
  if (sendAsNew) {
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
      skippedIds: wrappedSkips,
      doneCount,
      items
    });
  }
  return { empty: false, mode: "single", messageId: targetMsgId };
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
    const txn = await getTransaction(ctx.db, chatId, payload);
    if (txn && txn.status === "confirmed" && !txn.merchant) {
      const fallbackName = txn.category || (txn.direction === "credit" ? "Credit" : "Expense");
      await mutateTransaction(ctx, chatId, txn.id, { merchant: fallbackName });
      if (ack) await ack.toast("✓ Kept as " + fallbackName);
    }
    await renderUntaggedView(ctx, chatId, messageId, { ...active, items: null, mode: "single" });
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
          added = 1;
          if (isUntaggedTransaction(res.txn)) stayId = txnId;
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
    const batchParsed = parseBatchStepperReply(m.text, itemsCopy, rowsById, rules);
    if (!batchParsed) return false;

    for (const edit of batchParsed.edits) {
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
          confident: Boolean(nextCat)
        };
      }
    }

    await reactThumbsUp();

    if (batchParsed.acceptNow) {
      const { accepted } = await commitBatchItems(ctx, m.chatId, itemsCopy);
      const unacceptedIds = itemsCopy.filter((it) => !(it.confident && it.category)).map((it) => it.id);
      const nextSkips = Array.from(new Set([...(active.skippedIds || []), ...unacceptedIds]));
      await renderUntaggedView(ctx, m.chatId, messageId, {
        ...active,
        items: null,
        skippedIds: nextSkips,
        doneCount: (active.doneCount || 0) + accepted,
        mode: "auto"
      });
      return true;
    }

    // In-place preview update so the user can review their overrides and tap [✅ Accept].
    const def = defaultWindow(ctx.now());
    const windowFrom = active.windowFrom || def.windowFrom;
    const windowTo = active.windowTo || def.windowTo;
    const totalLeft = await countUntaggedTransactions(ctx.db, m.chatId, { from: windowFrom, to: windowTo });
    const rowList = validPairs.map((p) => p.row);
    const text = formatBatchSuggestionsSection(rowList, itemsCopy, totalLeft || rowList.length, active.doneCount || 0);
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
  const stillUntagged = outcome.updatedTxn ? isUntaggedTransaction(outcome.updatedTxn) : false;
  await renderUntaggedView(
    ctx,
    m.chatId,
    messageId,
    {
      ...active,
      items: null,
      doneCount: (active.doneCount || 0) + (stillUntagged ? 0 : 1),
      mode: "single"
    },
    { stayId: stillUntagged ? txn.id : null }
  );
  return true;
}
