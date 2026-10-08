// Personal-chat commands: onboarding, /help, /recent, /stats, /backfill.
import { getTenant, getTenantEmails, registerEmail } from "../db/tenants.js";
import { listTransactions } from "../db/transactions.js";
import { BOT_INBOX_EMAIL } from "./constants.js";
import { escapeMarkdown, money, shortCategoryName, formatDateTime } from "./format.js";
import { isUsable } from "./onboarding.js";
import { callAppsScript } from "./appsScript.js";
import { setPending, takePending } from "./pending.js";

const README_URL = "https://github.com/Rrishik/dus-aane-bot#readme";

export async function handleStart(ctx, chatId, username) {
  const tenant = await getTenant(ctx.db, chatId);
  if (isUsable(tenant)) return handleHelp(ctx, chatId);
  const greeting = username ? "Hey " + username + "! " : "";
  await ctx.tg.sendMessage(
    chatId,
    "✌️ " +
      greeting +
      "Track your spends — and split them with friends — by forwarding bank emails or pasting bank SMS. No full-inbox access, no account linking.\n\n" +
      "Worried about apps like Cred reading your OTPs, statements, and personal mail? This [open-source bot](https://github.com/Rrishik/Dus-Aane-Bot) solves that.\n\n" +
      "*Solo:* send `/register your.email@gmail.com` to begin.\n" +
      "*Shared expenses:* register first, then add me to a Telegram group with the people you split with — every transaction notification gains a one-tap _Split with <group>_ button.",
    { disable_web_page_preview: true }
  );
}

export async function handleHelp(ctx, chatId) {
  await ctx.tg.sendMessage(
    chatId,
    "*Commands*\n" +
      "• /ask — ask anything about your spending\n" +
      "   _e.g. /ask how much on food last month?_\n" +
      "• /stats — dashboard: recent, trends\n" +
      "• /register — add another Gmail to forward from\n" +
      "• /account — status & resend setup\n" +
      "• /export — download your data\n" +
      "• /help — this message\n\n" +
      "_Paste a bank SMS here any time to add it._",
    { reply_markup: { inline_keyboard: [[{ text: "📖 README", url: README_URL }]] } }
  );
}

export async function handleSheet(ctx, chatId) {
  await ctx.tg.sendMessage(
    chatId,
    "📋 Your transactions now live with the bot, not in a Google Sheet. Send /export for a CSV or a fresh Google Sheet copy."
  );
}

// ─── /register ───────────────────────────────────────────────────────

export async function handleRegister(ctx, chatId, username, text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);
  if (parts.length < 2) {
    await setPending(ctx, "register", chatId);
    await ctx.tg.sendMessage(
      chatId,
      "📬 What's the Gmail address you'd like to forward bank emails from?\n\n_Reply with just the address, or send_ `/register your.email@gmail.com`."
    );
    return;
  }
  await registerEmailForChat(ctx, chatId, username, parts[1]);
}

// Plain-text reply to a bare /register. Returns true if consumed.
export async function handleRegisterReply(ctx, chatId, username, text) {
  if (!(await takePending(ctx, "register", chatId))) return false;
  await registerEmailForChat(ctx, chatId, username, String(text || "").trim());
  return true;
}

export async function registerEmailForChat(ctx, chatId, username, rawEmail) {
  const email = String(rawEmail || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await ctx.tg.sendMessage(chatId, "❌ That doesn't look like a valid email. Try: `/register your.email@gmail.com`");
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
    await ctx.tg.sendMessage(chatId, "⚠️ No registered email yet. Send `/register your.email@gmail.com` first.");
    return false;
  }
  try {
    await callAppsScript(ctx, "send_setup_email", { chatId: String(chatId), emails });
  } catch (e) {
    console.error("[setup email]", e && e.message);
    await ctx.tg.sendMessage(
      chatId,
      "⚠️ Couldn't email setup instructions right now. Try again from `/account` in a minute."
    );
    return false;
  }
  await ctx.tg.sendMessage(
    chatId,
    "📬 Auto-forwarding setup emailed to " +
      emails.map((e) => "`" + e + "`").join(", ") +
      ".\n\n_You can start right now_ by manually forwarding any bank email to `" +
      BOT_INBOX_EMAIL +
      "` or pasting a bank SMS here. The email I sent has the steps to skip manual forwarding (~1 min on desktop). Resend any time from `/account`."
  );
  return true;
}

export async function handleAccount(ctx, chatId) {
  const tenant = await getTenant(ctx.db, chatId);
  if (!tenant) {
    await ctx.tg.sendMessage(chatId, "No account found for this chat. Use `/start` to onboard.");
    return;
  }
  const emails = await getTenantEmails(ctx.db, chatId);
  const lines = ["*Your account*", "Status: `" + tenant.status + "`"];
  if (tenant.name) lines.push("Name: " + escapeMarkdown(tenant.name));
  lines.push("Chat ID: `" + tenant.id + "`");
  lines.push("Emails: " + (emails.length ? emails.map((e) => "`" + e + "`").join(", ") : "_none_"));
  lines.push("Data: stored with the bot — /export for a copy");
  const opts = {};
  if (emails.length) {
    opts.reply_markup = {
      inline_keyboard: [[{ text: "📬 Resend auto-forwarding setup", callback_data: "resend_setup" }]]
    };
  }
  await ctx.tg.sendMessage(chatId, lines.join("\n"), opts);
}

// ─── /recent ─────────────────────────────────────────────────────────

// /recent, /recent 10, /recent alice, /recent 10 alice
export function parseRecentArgs(text) {
  let limit = 5;
  let user = null;
  String(text || "")
    .trim()
    .split(/\s+/)
    .slice(1)
    .forEach((p) => {
      if (/^\d+$/.test(p)) limit = parseInt(p, 10);
      else if (p) user = p.toLowerCase();
    });
  return { limit: Math.min(50, Math.max(1, limit)), user };
}

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
    const cat = r.category ? " · " + shortCategoryName(r.category) : "";
    msg +=
      "\n" +
      (r.direction === "debit" ? "🔴" : "🟢") +
      " *" +
      escapeMarkdown(r.merchant || "Unknown") +
      "* " +
      money(r.amount_minor, r.currency) +
      escapeMarkdown(cat) +
      "\n   _" +
      escapeMarkdown(formatDateTime(r.created_at)) +
      "_\n";
  });
  return msg;
}

export async function handleRecent(ctx, chatId, text) {
  await ctx.tg.sendMessage(chatId, await recentMessage(ctx, chatId, parseRecentArgs(text)));
}

// ─── /stats ──────────────────────────────────────────────────────────

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

export async function handleStats(ctx, chatId) {
  await ctx.tg.sendMessage(chatId, "📊 *Stats* — pick a view:", { reply_markup: statsMenuKeyboard() });
}
