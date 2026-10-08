// Inline-button callbacks. Card actions land here in task 7b; this file
// starts with the /stats views and "Resend setup".
import { getTenant, getTenantEmails } from "../db/tenants.js";
import { recentMessage, statsMenuKeyboard, sendSetupEmail } from "./commands.js";
import { monthlyTrends, weeklyTrends, formatTrendsMessage } from "./analytics.js";
import { isUsable, gateText } from "./onboarding.js";

const statsBackRow = [{ text: "🔙 Back", callback_data: "stats_back" }];

export async function handleStatsCallback(ctx, chatId, messageId, view) {
  if (view === "back") {
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

export async function handleCallback(ctx, cb) {
  const chatId = String(cb.message.chat.id);
  const messageId = cb.message.message_id;
  const data = cb.data || "";
  const tenant = await getTenant(ctx.db, chatId);

  // Resend setup must work for pending tenants — they need it most.
  if (data === "resend_setup") {
    if (!tenant) {
      await ctx.tg.answerCallbackQuery(cb.id, "Please /start to set up your account.", true);
      return;
    }
    await ctx.tg.answerCallbackQuery(cb.id, "📬 Sending...");
    await sendSetupEmail(ctx, chatId, await getTenantEmails(ctx.db, chatId));
    return;
  }
  if (!isUsable(tenant)) {
    await ctx.tg.answerCallbackQuery(
      cb.id,
      tenant ? gateText(tenant).replace(/`/g, "") : "Please /start to set up your account.",
      true
    );
    return;
  }

  // Ack first so the spinner clears; later errors go out as messages.
  await ctx.tg.answerCallbackQuery(cb.id, "");
  const sep = data.indexOf("_");
  const action = sep < 0 ? data : data.slice(0, sep);
  const payload = sep < 0 ? "" : data.slice(sep + 1);

  if (action === "stats") return handleStatsCallback(ctx, chatId, messageId, payload);
  if (data === "premium_info") {
    await ctx.tg.sendMessage(chatId, "💎 *Premium coming soon* — we'll let you know when it's ready.");
    return;
  }
  await ctx.tg.sendMessage(chatId, "❌ *Unknown action*");
}
