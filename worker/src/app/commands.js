// Personal-chat onboarding, live summary helpers, and Gmail setup mail.
import { getTenant, getTenantEmails, registerEmail } from "../db/tenants.js";
import { listTransactions } from "../db/transactions.js";
import { BOT_INBOX_EMAIL } from "./constants.js";
import { escapeMarkdown, money, shortCategoryName, formatLongDate } from "./format.js";
import { isUsable } from "./onboarding.js";
import { ensurePersonalPin } from "./personalPin.js";
import { callAppsScript } from "./appsScript.js";

const README_URL = "https://github.com/Rrishik/dus-aane-bot#readme";

export async function handleStart(ctx, chatId, username) {
  const tenant = await getTenant(ctx.db, chatId);
  if (isUsable(tenant)) {
    await ensurePersonalPin(ctx, chatId);
    return handleHelp(ctx, chatId);
  }
  const greeting = username ? "Hey " + username + "! " : "";
  await ctx.tg.sendMessage(
    chatId,
    "✌️ " +
      greeting +
      "Track your spends — and split them with friends — by forwarding bank emails or pasting bank SMS. No full-inbox access, no account linking.\n\n" +
      "Worried about apps like Cred reading your OTPs, statements, and personal mail? This [open-source bot](https://github.com/Rrishik/Dus-Aane-Bot) solves that.\n\n" +
      "*Solo:* reply with your Gmail address (e.g. `your.email@gmail.com`) to begin.\n" +
      "*Shared expenses:* register first, then add me to a Telegram group with the people you split with — every transaction notification gains a one-tap _Split with <group>_ button.",
    { disable_web_page_preview: true }
  );
}

export async function handleHelp(ctx, chatId) {
  await ctx.tg.sendMessage(
    chatId,
    "*Just type in plain English* — no commands needed:\n" +
      "• _How much did I spend on food last month?_\n" +
      "• _Tag Rahul as Food_\n" +
      "• _Split dinner 50/50_\n" +
      "• _Export September CSV_\n\n" +
      "_Paste a bank SMS here any time to add it, or check your pinned bar above for a live summary._",
    { reply_markup: { inline_keyboard: [[{ text: "📖 README", url: README_URL }]] } }
  );
}

// ─── Email registration ──────────────────────────────────────────────

export async function registerEmailForChat(ctx, chatId, username, rawEmail) {
  const email = String(rawEmail || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await ctx.tg.sendMessage(
      chatId,
      "❌ That doesn't look like a valid email. Reply with e.g. `your.email@gmail.com`."
    );
    return;
  }
  const before = await getTenant(ctx.db, chatId);
  const res = await registerEmail(ctx.db, chatId, email, username || (before && before.name) || "", ctx.now());
  if (!res.ok) {
    await ctx.tg.sendMessage(chatId, "❌ That email is already registered to another account.", { parse_mode: null });
    return;
  }
  if (isUsable(before)) {
    const emails = await getTenantEmails(ctx.db, chatId);
    await ctx.tg.sendMessage(
      chatId,
      "✅ Added `" +
        email +
        "` to your forwarder list.\n\nRegistered emails:\n" +
        emails.map((e) => "• `" + e + "`").join("\n")
    );
    await sendSetupEmail(ctx, chatId, [email]);
    return;
  }
  await sendSetupEmail(ctx, chatId, await getTenantEmails(ctx.db, chatId));
}

// Apps Script sends the auto-forwarding setup email from the bot account.
export async function sendSetupEmail(ctx, chatId, emails) {
  if (!emails || emails.length === 0) {
    await ctx.tg.sendMessage(chatId, "⚠️ No registered email yet. Reply with `your.email@gmail.com` first.");
    return false;
  }
  try {
    await callAppsScript(ctx, "send_setup_email", { chatId: String(chatId), emails });
  } catch (e) {
    console.error("[setup email]", e && e.message);
    await ctx.tg.sendMessage(
      chatId,
      "⚠️ Couldn't email setup instructions right now. Ask me to resend setup instructions in a minute.",
      {
        reply_markup: { inline_keyboard: [[{ text: "📬 Retry setup email", callback_data: "resend_setup" }]] }
      }
    );
    return false;
  }
  await ctx.tg.sendMessage(
    chatId,
    "📬 Auto-forwarding setup emailed to " +
      emails.map((e) => "`" + e + "`").join(", ") +
      ".\n\n_You can start right now_ by manually forwarding any bank email to `" +
      BOT_INBOX_EMAIL +
      "` or pasting a bank SMS here. The email I sent has the steps to skip manual forwarding (~1 min on desktop).",
    {
      reply_markup: { inline_keyboard: [[{ text: "📬 Resend setup instructions", callback_data: "resend_setup" }]] }
    }
  );
  return true;
}

// ─── Recent & Trends view helpers (used by pinned summary callbacks) ─

export async function recentMessage(ctx, tenantId, { limit = 5, user = null } = {}) {
  let rows = await listTransactions(ctx.db, tenantId, { limit: user ? 500 : limit });
  if (user)
    rows = rows
      .filter((r) =>
        String(r.forwarder || "")
          .toLowerCase()
          .includes(user)
      )
      .slice(0, limit);
  if (rows.length === 0) {
    return user ? "📅 *No transactions found* for user: " + escapeMarkdown(user) : "📅 *No transactions found yet!*";
  }
  let msg = "📅 *Recent Transactions*" + (user ? " (user: " + escapeMarkdown(user) + ")" : "") + "\n";
  rows.forEach((r) => {
    const cat = r.category ? " · " + shortCategoryName(r.category) : " · _untagged_";
    msg +=
      "\n" +
      (r.direction === "debit" ? "🔴" : "🟢") +
      " *" +
      escapeMarkdown(r.merchant || "Unknown") +
      "* " +
      money(r.amount_minor, r.currency) +
      (r.category ? escapeMarkdown(cat) : cat) +
      "\n   _" +
      escapeMarkdown(formatLongDate(r.occurred_on)) +
      "_\n";
  });
  return msg;
}

export function statsMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🕒 Recent", callback_data: "stats_recent" },
        { text: "📉 Trends", callback_data: "stats_trends" }
      ]
    ]
  };
}
