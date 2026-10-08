// Native Telegram update dispatcher (MODE=native).
import { getTenant } from "../db/tenants.js";
import {
  handleStart,
  handleHelp,
  handleSheet,
  handleRegister,
  handleRegisterReply,
  handleAccount,
  handleRecent,
  handleStats
} from "./commands.js";
import { handleBackfill } from "./backfill.js";
import { handleCallback } from "./callbacks.js";
import { handleSmsPaste } from "./sms.js";
import { handleTagReply, handleCancel } from "./cardActions.js";
import { handleAsk, handleAskResume, handlePendingAsk } from "./ask.js";
import { isUsable, gateText } from "./onboarding.js";
import {
  handleGroupStart,
  handleGroupHelp,
  handleGroupAccount,
  handleGroupSheet,
  handleGroupStats,
  handleGroupSettle,
  handleMembershipUpdate
} from "./groups.js";

const ONBOARDING = ["/start", "/register", "/account"];

const PERSONAL_COMMANDS = {
  "/start": (ctx, m) => handleStart(ctx, m.chatId, m.username),
  "/register": (ctx, m) => handleRegister(ctx, m.chatId, m.username, m.text),
  "/account": (ctx, m) => handleAccount(ctx, m.chatId),
  "/help": (ctx, m) => handleHelp(ctx, m.chatId),
  "/sheet": (ctx, m) => handleSheet(ctx, m.chatId),
  "/recent": (ctx, m) => handleRecent(ctx, m.chatId, m.text),
  "/stats": (ctx, m) => handleStats(ctx, m.chatId),
  "/backfill": (ctx, m) => handleBackfill(ctx, m.chatId, m.text),
  "/cancel": (ctx, m) => handleCancel(ctx, m),
  "/ask": (ctx, m) => handleAsk(ctx, m)
};

const GROUP_COMMANDS = {
  "/start": handleGroupStart,
  "/help": handleGroupHelp,
  "/account": handleGroupAccount,
  "/sheet": handleGroupSheet,
  "/stats": handleGroupStats,
  "/settle": handleGroupSettle
};

// Plain-text flows that run before SMS paste: /ask replies, 🏷 tag, bare /ask.
const PLAIN_TEXT_STEPS = [handleAskResume, handleTagReply, handlePendingAsk];

export function commandOf(text) {
  return String(text || "")
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();
}

export async function handleMessage(ctx, message) {
  const text = message.text;
  if (!text) return;
  const chatId = String(message.chat.id);
  const m = {
    chatId,
    text,
    username: (message.from && (message.from.first_name || message.from.username)) || "",
    userId: message.from ? String(message.from.id) : chatId,
    replyTo: message.reply_to_message || null,
    raw: message
  };

  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    if (!text.startsWith("/")) return;
    const handler = GROUP_COMMANDS[commandOf(text)];
    // Unknown commands stay silent — they may be for another bot.
    if (handler) await handler(ctx, m);
    return;
  }

  const tenant = await getTenant(ctx.db, chatId);
  if (text.startsWith("/")) {
    const command = commandOf(text);
    if (!ONBOARDING.includes(command) && !isUsable(tenant)) {
      await ctx.tg.sendMessage(chatId, gateText(tenant));
      return;
    }
    const handler = PERSONAL_COMMANDS[command];
    if (handler) await handler(ctx, m, tenant);
    else await ctx.tg.sendMessage(chatId, "❌ *Unknown command!*\n\nUse /help to see available commands.");
    return;
  }

  // Plain text: reply flows first, then pending inputs, then SMS paste.
  for (const step of PLAIN_TEXT_STEPS) {
    if (await step(ctx, m, tenant)) return;
  }
  if (await handleRegisterReply(ctx, chatId, m.username, text)) return;
  await handleSmsPaste(ctx, tenant, chatId, text);
}

export async function handleUpdate(ctx, update) {
  try {
    if (update.callback_query) return await handleCallback(ctx, update.callback_query);
    if (update.message) return await handleMessage(ctx, update.message);
    if (update.my_chat_member || update.chat_member) return await handleMembershipUpdate(ctx, update);
  } catch (e) {
    console.error("[update] failed:", e && e.stack);
  }
}
