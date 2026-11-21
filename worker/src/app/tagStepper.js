// 1-tap in-place untagged stepper (driven from the 21:00 IST Daily Recap and
// the pinned DM summary card).
import { getTransaction, listUntaggedTransactions, isUntaggedTransaction } from "../db/transactions.js";
import { mutateTransaction } from "./ledger.js";
import { cardText } from "./cards.js";
import { CATEGORIES, CREDIT_CATEGORIES, CATEGORY_EMOJIS, categoriesFor } from "./constants.js";
import { shortCategoryName } from "./format.js";

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

export async function handleTagQueueCallback(ctx, { chatId, messageId, action, payload, ack }) {
  if (action === "tagqm") {
    const txn = await getTransaction(ctx.db, chatId, payload);
    if (txn && txn.status === "confirmed" && !txn.merchant) {
      const fallbackName = shortCategoryName(txn.category) || (txn.direction === "credit" ? "Credit" : "Expense");
      await mutateTransaction(ctx, chatId, txn.id, { merchant: fallbackName });
      if (ack) await ack.toast("✓ Kept as " + fallbackName);
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
        const res = await mutateTransaction(ctx, chatId, txn.id, { category });
        if (res.ok) {
          stillUntagged = isUntaggedTransaction(res.txn);
          if (ack) {
            const emoji = CATEGORY_EMOJIS[category] ? CATEGORY_EMOJIS[category] + " " : "";
            const extra = res.autoFilled > 0 ? " · +" + res.autoFilled + " auto-tagged" : "";
            await ack.toast(emoji + category + extra);
          }
        }
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
