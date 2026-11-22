// Personal-chat onboarding, live summary helpers, and Gmail setup mail.
import { getTenant, getTenantEmails, registerEmail } from "../db/tenants.js";
import { getMerchantRules } from "../db/merchantRules.js";
import { upsertAccountLabel, deleteAccountLabel, listSeenAccounts } from "../db/accountLabels.js";
import { putEphemeral, getEphemeral } from "../db/ephemeral.js";
import { listTransactions } from "../db/transactions.js";
import { BOT_INBOX_EMAIL } from "./constants.js";
import { escapeMarkdown, money, formatDayMonth, formatLongDate } from "./format.js";
import { isUsable, gateText } from "./onboarding.js";
import { ensurePersonalPin, refreshPersonalPin } from "./personalPin.js";
import { sweepPendingFxConversions } from "./fx.js";
import { syncMemberGroupTitles } from "./groups.js";
import { normalizeTenantMerchants } from "./merchants.js";
import { callAppsScript } from "./appsScript.js";

const README_URL = "https://github.com/Rrishik/dus-aane-bot#readme";

export async function handleStart(ctx, chatId, username) {
  const tenant = await getTenant(ctx.db, chatId);
  if (isUsable(tenant)) {
    const rules = await getMerchantRules(ctx.db, chatId);
    await normalizeTenantMerchants(ctx.db, chatId, rules, ctx.now()).catch(() => {});
    await sweepPendingFxConversions(ctx, { tenantId: chatId }).catch(() => {});
    await syncMemberGroupTitles(ctx, chatId);
    await ensurePersonalPin(ctx, chatId);
    return sendWelcomeGuide(ctx, chatId);
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

async function sendWelcomeGuide(ctx, chatId) {
  await ctx.tg.sendMessage(
    chatId,
    "*Just type in plain English* — no commands needed:\n" +
      "• _How much did I spend on food last month?_\n" +
      "• _Tag Rahul as Food_\n" +
      "• _Split dinner 50/50_\n" +
      "• _Export September CSV_\n\n" +
      "💡 *Swipe-reply* on any card with a merchant name, `₹amount`, `50-50`, or `del` — or swipe-reply on any answer to follow up.\n" +
      "💳 *Cards & accounts:* tap *💳 Cards* on your pinned summary (or type `/cards`) to view & label `*last4` digits.",
    { reply_markup: { inline_keyboard: [[{ text: "📖 README", url: README_URL }]] } }
  );
}

const CARDS_VIEW_TTL_SEC = 86400;
export const cardsViewKey = (chatId, messageId) => "cards_view:" + chatId + ":" + messageId;

const CARDS_VIEW_CMD_RE =
  /^(?:\/?(?:cards|accounts)(?:@\w+)?|(?:show\s+|list\s+|view\s+)?(?:my\s+|saved\s+|labell?ed\s+)?(?:cards|accounts|cards\s*(?:&|and|\/)\s*accounts))\s*\??$/i;
const DIRECT_LABEL_UPSERT_RE =
  /^(?:label\s+|name\s+)?(card|a\/c|acct|account|bank)\s+[*xX#]*(\d{3,4})\s+(?:is|as|=|:)\s+(.+)$/i;
const DIRECT_LABEL_DELETE_RE =
  /^(?:del(?:ete)?|remove|unlabel|clear)\s+(?:(?:card|a\/c|acct|account|bank|label)\s+)?[*xX#]*(\d{3,4})$/i;

function kindForToken(token) {
  return /^(?:a\/c|acct|account|bank)$/i.test(String(token || "").trim()) ? "account" : "card";
}

function formatLabelledLine(r, icon) {
  const metaParts = [];
  if (r.txn_count > 0) metaParts.push(r.txn_count + (r.txn_count === 1 ? " txn" : " txns"));
  if (r.last_seen) metaParts.push(formatDayMonth(r.last_seen));
  const meta = metaParts.length > 0 ? " _(" + escapeMarkdown(metaParts.join(" · ")) + ")_" : "";
  return "• " + icon + " `*" + r.last4 + "` — *" + escapeMarkdown(r.label) + "*" + meta;
}

export async function accountsMessage(ctx, tenantId) {
  const seen = await listSeenAccounts(ctx.db, tenantId);
  const labelledCards = seen.filter((r) => r.label && r.kind !== "account");
  const labelledAccounts = seen.filter((r) => r.label && r.kind === "account");
  const unlabelled = seen.filter((r) => !r.label);
  const lines = ["💳 *Cards & Accounts*"];

  if (labelledCards.length > 0 || labelledAccounts.length > 0) {
    if (labelledCards.length > 0) {
      lines.push("", "*Credit Cards*");
      for (const r of labelledCards) lines.push(formatLabelledLine(r, "💳"));
    }
    if (labelledAccounts.length > 0) {
      lines.push("", "*Bank Accounts*");
      for (const r of labelledAccounts) lines.push(formatLabelledLine(r, "🏦"));
    }
  } else {
    lines.push("", "_No cards or accounts labelled yet._");
  }

  if (unlabelled.length > 0) {
    lines.push("", "*Unlabelled* _(seen in alerts)_");
    const shown = unlabelled.slice(0, 10);
    const chips = shown.map(
      (r) => "`*" + r.last4 + "` _(" + r.txn_count + (r.txn_count === 1 ? " txn" : " txns") + ")_"
    );
    for (let i = 0; i < chips.length; i += 3) {
      lines.push("• " + chips.slice(i, i + 3).join(" · "));
    }
    if (unlabelled.length > shown.length) {
      lines.push("_+" + (unlabelled.length - shown.length) + " more_");
    }
  } else if (labelledCards.length === 0 && labelledAccounts.length === 0) {
    lines.push("_No card or account digits seen in transactions yet._");
  }

  lines.push(
    "",
    "💡 _Swipe-reply here_ (e.g. `5678 Infinia, a/c 1264 HDFC` or `del 5678`), _or say_ `card 5678 is Infinia` _anytime._"
  );
  return lines.join("\n");
}

export async function handleCardsViewCommand(ctx, chatId, text, tenant = null) {
  if (!CARDS_VIEW_CMD_RE.test(String(text || "").trim())) return false;
  if (tenant && !isUsable(tenant)) {
    await ctx.tg.sendMessage(chatId, gateText(tenant));
    return true;
  }
  const posted = await ctx.tg.sendMessage(chatId, await accountsMessage(ctx, chatId));
  if (posted && posted.message_id) {
    await putEphemeral(
      ctx.db,
      cardsViewKey(chatId, posted.message_id),
      { pinView: false },
      CARDS_VIEW_TTL_SEC,
      ctx.now()
    );
  }
  return true;
}

export async function handleDirectCardLabel(ctx, chatId, text) {
  const s = String(text || "").trim();
  const delMatch = s.match(DIRECT_LABEL_DELETE_RE);
  if (delMatch) {
    const res = await deleteAccountLabel(ctx.db, chatId, delMatch[1], ctx.now());
    if (!res.ok) {
      await ctx.tg.sendMessage(chatId, "ℹ️ " + res.error, { parse_mode: null });
      return true;
    }
    await ctx.tg.sendMessage(
      chatId,
      "🗑 Removed label *" + escapeMarkdown(res.removed_label) + "* from `*" + res.last4 + "`."
    );
    return true;
  }

  const m = s.match(DIRECT_LABEL_UPSERT_RE);
  if (!m) return false;
  const kind = kindForToken(m[1]);
  const res = await upsertAccountLabel(ctx.db, chatId, m[2], m[3], kind, ctx.now());
  if (!res.ok) {
    await ctx.tg.sendMessage(chatId, "❌ " + res.error, { parse_mode: null });
    return true;
  }
  const icon = res.kind === "account" ? "🏦" : "💳";
  const noun = res.kind === "account" ? "account" : "card";
  const extra =
    res.upgraded_transactions > 0
      ? " (updated " + res.upgraded_transactions + " past CC bill" + (res.upgraded_transactions === 1 ? "" : "s") + ")"
      : "";
  await ctx.tg.sendMessage(
    chatId,
    icon + " Saved " + noun + " `*" + res.last4 + "` as *" + escapeMarkdown(res.label) + "*" + extra + "."
  );
  return true;
}

// Parse comma/newline-separated swipe-replies on the Cards & Accounts card:
//   "5678 Infinia, a/c 1264 HDFC" / "card 4178 is Atlas" / "del 5678"
export function parseCardsViewReply(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 240 || /[?]/.test(raw)) return null;
  const segments = raw
    .split(/\s*(?:,|;|\n)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!segments.length) return null;

  const ops = [];
  for (const seg of segments) {
    const del = seg.match(DIRECT_LABEL_DELETE_RE);
    if (del) {
      ops.push({ op: "delete", last4: del[1] });
      continue;
    }
    const explicit = seg.match(
      /^(?:label\s+|name\s+)?(?:(card|a\/c|acct|account|bank)\s+)?[*xX#]*(\d{3,4})\s*(?:is|as|=|:|\s)\s*(.+)$/i
    );
    if (!explicit) return null;
    const label = explicit[3].trim();
    if (!label || label.split(/\s+/).length > 5) return null;
    ops.push({
      op: "upsert",
      kind: kindForToken(explicit[1]),
      last4: explicit[2],
      label
    });
  }
  return ops.length > 0 ? ops : null;
}

export async function handleCardsReply(ctx, m) {
  if (!m.replyTo || !m.replyTo.message_id) return false;
  const messageId = m.replyTo.message_id;
  const active = await getEphemeral(ctx.db, cardsViewKey(m.chatId, messageId), ctx.now());
  if (!active) return false;

  const ops = parseCardsViewReply(m.text);
  if (!ops) return false;

  let changed = 0;
  for (const item of ops) {
    if (item.op === "delete") {
      const r = await deleteAccountLabel(ctx.db, m.chatId, item.last4, ctx.now());
      if (r.ok) changed++;
    } else {
      const r = await upsertAccountLabel(ctx.db, m.chatId, item.last4, item.label, item.kind, ctx.now());
      if (r.ok) changed++;
    }
  }
  if (changed === 0) return false;

  if (m.raw && m.raw.message_id && ctx.tg.setMessageReaction) {
    await ctx.tg.setMessageReaction(m.chatId, m.raw.message_id, "👍").catch(() => {});
  }

  const opts = active.pinView
    ? { reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "stats_back" }]] } }
    : {};
  await ctx.tg.editMessageText(m.chatId, messageId, await accountsMessage(ctx, m.chatId), opts);
  await putEphemeral(ctx.db, cardsViewKey(m.chatId, messageId), active, CARDS_VIEW_TTL_SEC, ctx.now());
  if (!active.pinView) await refreshPersonalPin(ctx, m.chatId).catch(() => {});
  return true;
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

export async function recentMessage(ctx, tenantId, limit = 5) {
  const rows = await listTransactions(ctx.db, tenantId, { limit });
  if (rows.length === 0) return "📅 *No transactions found yet!*";
  let msg = "📅 *Recent Transactions*\n";
  rows.forEach((r) => {
    const cat = r.category ? " · " + escapeMarkdown(r.category) : " · _untagged_";
    msg +=
      "\n" +
      (r.direction === "debit" ? "🔴" : "🟢") +
      " *" +
      escapeMarkdown(r.merchant || "Unknown") +
      "* " +
      money(r.amount_minor, r.currency) +
      cat +
      "\n   _" +
      escapeMarkdown(formatLongDate(r.occurred_on)) +
      "_\n";
  });
  return msg;
}
