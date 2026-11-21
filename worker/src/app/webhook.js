// Telegram update dispatcher.
//
// Personal DMs are commandless: only `/start` and `/cancel` (plus unlisted
// `/sms`) are handled as slash commands. Deterministic fast-paths handle card
// replies, strict bank SMS pastes, and bare onboarding emails; everything else
// flows through the central LLM orchestrator.
import { getTenant } from "../db/tenants.js";
import { handleStart, registerEmailForChat } from "./commands.js";
import { handleCallback } from "./callbacks.js";
import { handleSmsPaste } from "./sms.js";
import { handleTagReply, handleAmountReply, handleCardReply, handleCancel } from "./cardActions.js";
import { handleOrchestrator, handleAskResume, handlePendingAsk } from "./orchestrator.js";
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

const GROUP_COMMANDS = {
  "/start": handleGroupStart,
  "/help": handleGroupHelp,
  "/account": handleGroupAccount,
  "/sheet": handleGroupSheet,
  "/stats": handleGroupStats,
  "/settle": handleGroupSettle
};

const EMAIL_TOKEN_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function commandOf(text) {
  return String(text || "")
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();
}

// Deterministic email capture (0 LLM tokens) for bare email replies during
// onboarding or explicit "register alice@gmail.com" messages.
export function extractDirectRegistrationEmail(text, tenant) {
  const s = String(text || "").trim();
  if (!s) return null;
  const regMatch = s.match(/^\/?register(?:@\w+)?\s+(\S+)$/i);
  if (regMatch) return regMatch[1];
  if (!isUsable(tenant) && EMAIL_TOKEN_RE.test(s)) return s;
  return null;
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

  const command = text.startsWith("/") ? commandOf(text) : null;
  if (command === "/start") return handleStart(ctx, chatId, m.username);
  if (command === "/cancel") return handleCancel(ctx, m);

  const tenant = await getTenant(ctx.db, chatId);

  // Unlisted power-user / debug escape hatch for forcing SMS parsing.
  if (command === "/sms") {
    const rawSms = text.replace(/^\/sms(@\w+)?\s*/i, "").trim();
    if (!rawSms) {
      await ctx.tg.sendMessage(chatId, "Paste the bank SMS text right after `/sms`.");
      return;
    }
    if (!(await handleSmsPaste(ctx, tenant, chatId, rawSms, { force: true }))) {
      await ctx.tg.sendMessage(chatId, "ℹ️ No transaction found in that.", { parse_mode: null });
    }
    return;
  }

  // Deterministic pending card inputs.
  if (await handleTagReply(ctx, m)) return;
  if (await handleAmountReply(ctx, m)) return;

  // Deterministic strict bank SMS paste (0 LLM tokens when matching templates).
  if (await handleSmsPaste(ctx, tenant, chatId, text)) return;

  // Deterministic email registration (0 LLM tokens).
  const directEmail = extractDirectRegistrationEmail(text, tenant);
  if (directEmail) {
    await registerEmailForChat(ctx, chatId, m.username, directEmail);
    return;
  }

  // Unregistered chats never burn LLM tokens — prompt to onboard instead.
  if (!tenant) {
    await ctx.tg.sendMessage(chatId, gateText(null));
    return;
  }

  // Active conversation resume (swipe reply or open ask_user) -> card quick-reply -> central orchestrator.
  if (await handleAskResume(ctx, m, tenant)) return;
  if (await handleCardReply(ctx, m)) return;
  if (await handlePendingAsk(ctx, m, tenant)) return;
  await handleOrchestrator(ctx, m, tenant);
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
