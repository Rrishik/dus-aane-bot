// Inline-button callbacks: /stats views, "Resend setup", group split/settle
// (":"-separated) and transaction card actions ("_"-separated).
import { getTenant, getTenantEmails } from "../db/tenants.js";
import { recentMessage, statsMenuKeyboard, sendSetupEmail } from "./commands.js";
import { monthlyTrends, weeklyTrends, formatTrendsMessage } from "./analytics.js";
import { isUsable, gateText } from "./onboarding.js";
import { handleCardAction } from "./cardActions.js";
import { handleTagQueueCallback } from "./tagStepper.js";
import { isGroupCallback, handleGroupCallback } from "./groups.js";
import { handleAskFollowUp } from "./orchestrator.js";
import { handleExportSheet, handleWipeCallback } from "./data.js";
import { personalPinData, formatPersonalPin, personalPinKeyboard } from "./personalPin.js";

const statsBackRow = [{ text: "🔙 Back", callback_data: "stats_back" }];

export async function handleStatsCallback(ctx, chatId, messageId, view, tenant) {
  if (view === "back") {
    if (tenant && tenant.pin_message_id && Number(tenant.pin_message_id) === Number(messageId)) {
      const data = await personalPinData(ctx, chatId);
      await ctx.tg.editMessageText(chatId, messageId, formatPersonalPin(data), {
        disable_web_page_preview: true,
        reply_markup: personalPinKeyboard(data.untaggedCount)
      });
      return;
    }
    await ctx.tg.editMessageText(chatId, messageId, "📊 *Stats* — pick a view:", { reply_markup: statsMenuKeyboard() });
    return;
  }
  if (view === "recent") {
    await ctx.tg.editMessageText(chatId, messageId, await recentMessage(ctx, chatId), {
      reply_markup: { inline_keyboard: [statsBackRow] }
    });
    return;
  }
  if (view === "trends" || view === "trendsweekly" || view === "trendsmonthly") {
    const monthly = view === "trendsmonthly";
    const buckets = monthly
      ? await monthlyTrends(ctx.db, chatId, ctx.now())
      : await weeklyTrends(ctx.db, chatId, ctx.now());
    const text = formatTrendsMessage(buckets, {
      title: "📉 *Spending Trends* — " + (monthly ? "Monthly" : "Weekly"),
      comparisonLabel: monthly ? "vs Last Month" : "vs Last Week"
    });
    const toggle = monthly
      ? { text: "📅 Weekly", callback_data: "stats_trendsweekly" }
      : { text: "📊 Monthly", callback_data: "stats_trendsmonthly" };
    await ctx.tg.editMessageText(chatId, messageId, text, {
      reply_markup: { inline_keyboard: [[toggle], statsBackRow] }
    });
  }
}

function callbackResponder(ctx, cbId) {
  let answered = false;
  return {
    async toast(text = "", showAlert = false) {
      if (answered) return;
      answered = true;
      await ctx.tg.answerCallbackQuery(cbId, text, showAlert).catch(() => {});
    },
    get answered() {
      return answered;
    }
  };
}

export async function handleCallback(ctx, cb) {
  const chatId = String(cb.message.chat.id);
  const messageId = cb.message.message_id;
  const data = cb.data || "";
  const ack = callbackResponder(ctx, cb.id);

  try {
    if (data.startsWith("gstats:")) {
      return await handleGroupCallback(ctx, cb, ack);
    }
    const tenant = await getTenant(ctx.db, chatId);

    // Resend setup must work for pending tenants — they need it most.
    if (data === "resend_setup") {
      if (!tenant) {
        await ack.toast("Please /start to set up your account.", true);
        return;
      }
      await ack.toast("📬 Sending setup email…");
      await sendSetupEmail(ctx, chatId, await getTenantEmails(ctx.db, chatId));
      return;
    }
    // Data wipe confirmation works for pending tenants too.
    if (data === "wipe_yes" || data === "wipe_no") {
      const yes = data === "wipe_yes";
      await ack.toast(yes ? "🗑 Deleting your data…" : "👍 Kept your data");
      if (tenant) await handleWipeCallback(ctx, chatId, messageId, data.slice(5));
      return;
    }
    if (!isUsable(tenant)) {
      await ack.toast(tenant ? gateText(tenant).replace(/`/g, "") : "Please /start to set up your account.", true);
      return;
    }

    if (isGroupCallback(data)) return await handleGroupCallback(ctx, cb, ack);
    const sep = data.indexOf("_");
    const action = sep < 0 ? data : data.slice(0, sep);
    const payload = sep < 0 ? "" : data.slice(sep + 1);

    if (action === "stats") return await handleStatsCallback(ctx, chatId, messageId, payload, tenant);
    if (action === "tagq" || action === "tagqc" || action === "tagqm") {
      return await handleTagQueueCallback(ctx, { chatId, messageId, action, payload, ack });
    }
    if (action === "askfu") return await handleAskFollowUp(ctx, chatId, messageId, ack);
    if (action === "export" && payload.startsWith("sheet_")) {
      await ack.toast("📊 Building Google Sheet…");
      return await handleExportSheet(ctx, chatId, payload.slice(6));
    }
    if (data === "premium_info") {
      await ack.toast("💎 Premium coming soon — we'll let you know when it's ready!", true);
      return;
    }
    const handled = await handleCardAction(ctx, {
      chatId,
      userId: String(cb.from && cb.from.id ? cb.from.id : chatId),
      messageId,
      action,
      payload,
      from: cb.from,
      ack
    });
    if (!handled) await ack.toast("❌ Unknown action", true);
  } finally {
    if (!ack.answered) await ack.toast("");
  }
}
