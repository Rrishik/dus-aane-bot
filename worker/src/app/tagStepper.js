// 1-tap in-place untagged stepper (driven from the 21:00 IST Daily Recap and
// the pinned DM summary card). Also accepts direct 0-LLM swipe-replies (e.g.
// "Kirana, Groceries" or "Starbucks") on the stepper message to name & advance.
import { getTenant } from "../db/tenants.js";
import { getTransaction, listUntaggedTransactions, isUntaggedTransaction } from "../db/transactions.js";
import { getMerchantRules } from "../db/merchantRules.js";
import { putEphemeral, getEphemeral, deleteEphemeral } from "../db/ephemeral.js";
import { mutateTransaction } from "./ledger.js";
import { parseCardQuickReply, applyCardQuickReply } from "./cardActions.js";
import { cardText } from "./cards.js";
import { refreshPersonalPin } from "./personalPin.js";
import { CATEGORIES, CREDIT_CATEGORIES, CATEGORY_EMOJIS, categoriesFor } from "./constants.js";

const STEPPER_TTL_SEC = 86400;
export const stepperKey = (chatId, messageId) => "stepper:" + chatId + ":" + messageId;

function tagStepperKeyboard(txn) {
  const cats = txn.direction === "credit" ? CREDIT_CATEGORIES : CATEGORIES;
  const rows = [];
  const missingMerchant = !txn.merchant || String(txn.merchant).trim().toLowerCase() === "unknown";
  if (missingMerchant && txn.category) {
    rows.push([{ text: "✓ Keep as " + txn.category, callback_data: "tagqm_" + txn.id }]);
  }
  for (let i = 0; i < cats.length; i += 3) {
    rows.push(
      cats.slice(i, i + 3).map((c, j) => ({
        text: (CATEGORY_EMOJIS[c] ? CATEGORY_EMOJIS[c] + " " : "") + c,
        callback_data: "tagqc_" + txn.id + "_" + (i + j)
      }))
    );
  }
  rows.push([
    { text: "⏭ Skip", callback_data: "tagq_skip_" + txn.id },
    { text: "✖ Done", callback_data: "tagq_done" }
  ]);
  return { inline_keyboard: rows };
}

function stepBody(current, idx, total) {
  const header = "🏷 *Categorize* _(" + (idx + 1) + " of " + total + " left)_\n\n";
  return (
    header + cardText(current, { extraLine: current.merchant ? "_Tap a category or swipe-reply a new name_" : null })
  );
}

async function isPinnedMessage(db, chatId, messageId) {
  const tenant = await getTenant(db, chatId);
  return Boolean(tenant && tenant.pin_message_id && String(tenant.pin_message_id) === String(messageId));
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
          {
            reply_markup: { inline_keyboard: [] }
          }
        );
      }
    }
    if (ack) await ack.toast("👍 Done");
    return;
  }

  if (action === "tagq" && payload === "next" && (await isPinnedMessage(ctx.db, chatId, messageId))) {
    const list = await listUntaggedTransactions(ctx.db, chatId, { limit: 25 });
    if (list.length === 0) {
      await refreshPersonalPin(ctx, chatId);
      if (ack) await ack.toast("✅ All caught up!");
      return;
    }
    const current = list[0];
    const posted = await ctx.tg.sendMessage(chatId, stepBody(current, 0, list.length), {
      reply_markup: tagStepperKeyboard(current)
    });
    if (posted && posted.message_id) {
      await putEphemeral(
        ctx.db,
        stepperKey(chatId, posted.message_id),
        { txnId: current.id },
        STEPPER_TTL_SEC,
        ctx.now()
      );
    }
    if (ack) await ack.toast("🏷 Let's categorize");
    return;
  }

  if (action === "tagqm") {
    const txn = await getTransaction(ctx.db, chatId, payload);
    if (txn && txn.status === "confirmed" && !txn.merchant) {
      const fallbackName = txn.category || (txn.direction === "credit" ? "Credit" : "Expense");
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

export async function handleStepperReply(ctx, m) {
  if (!m.replyTo || !m.replyTo.message_id) return false;
  const active = await getEphemeral(ctx.db, stepperKey(m.chatId, m.replyTo.message_id), ctx.now());
  if (!active || !active.txnId) return false;
  const txn = await getTransaction(ctx.db, m.chatId, active.txnId);
  if (!txn || txn.status === "deleted") return false;

  const rules = await getMerchantRules(ctx.db, m.chatId);
  const parsed = parseCardQuickReply(m.text, txn.direction, rules);
  if (!parsed) return false;

  const outcome = await applyCardQuickReply(ctx, m.chatId, txn, parsed, { cardMessageId: null });
  if (!outcome.handled) return false;

  if (m.raw && m.raw.message_id && ctx.tg.setMessageReaction) {
    await ctx.tg.setMessageReaction(m.chatId, m.raw.message_id, "👍").catch(() => {});
  }
  const stillUntagged = outcome.updatedTxn ? isUntaggedTransaction(outcome.updatedTxn) : false;
  await renderNextUntaggedStep(ctx, m.chatId, m.replyTo.message_id, stillUntagged ? txn.id : null);
  return true;
}

async function renderNextUntaggedStep(ctx, chatId, messageId, skipId) {
  const list = await listUntaggedTransactions(ctx.db, chatId, { limit: 25 });
  if (list.length === 0) {
    await deleteEphemeral(ctx.db, stepperKey(chatId, messageId));
    if (await isPinnedMessage(ctx.db, chatId, messageId)) {
      await refreshPersonalPin(ctx, chatId);
      return;
    }
    await ctx.tg.editMessageText(chatId, messageId, "✅ *All caught up!*\nEvery recent transaction has a category.", {
      reply_markup: { inline_keyboard: [] }
    });
    return;
  }

  let idx = 0;
  if (skipId) {
    const found = list.findIndex((t) => t.id === skipId);
    if (found >= 0) idx = (found + 1) % list.length;
  }
  const current = list[idx];
  await putEphemeral(ctx.db, stepperKey(chatId, messageId), { txnId: current.id }, STEPPER_TTL_SEC, ctx.now());
  await ctx.tg.editMessageText(chatId, messageId, stepBody(current, idx, list.length), {
    reply_markup: tagStepperKeyboard(current)
  });
}
