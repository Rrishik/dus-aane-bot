// Your data: /export (CSV, or a Google Sheet copy via Apps Script) and
// /deletemydata.
import { getTenantEmails, groupsForMember, deleteTenantData } from "../db/tenants.js";
import { listEffectiveTransactions } from "../db/analytics.js";
import { getSetting, setSetting } from "../db/settings.js";
import { callAppsScript } from "./appsScript.js";
import { refreshBalancesPin } from "./groups.js";
import { fromMinor } from "../util/money.js";

export const EXPORT_HEADER = [
  "Date",
  "Merchant",
  "Amount",
  "Currency",
  "Type",
  "Category",
  "Kind",
  "Your share",
  "Account",
  "Reference",
  "Forwarder",
  "Status",
  "Id"
];

const USAGE = "Usage: `/export`, `/export 2026-09` or `/export 2026-01-01 2026-03-31`";

// "" → all time; "YYYY-MM" → that month; two ISO dates → that range.
export function parseExportRange(text) {
  const args = String(text || "")
    .trim()
    .split(/\s+/)
    .slice(1);
  if (!args.length) return { from: null, to: null };
  if (args.length === 1 && /^\d{4}-\d{2}$/.test(args[0])) {
    const [y, m] = args[0].split("-").map(Number);
    if (m < 1 || m > 12) return null;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: args[0] + "-01", to: args[0] + "-" + String(last).padStart(2, "0") };
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (args.length === 2 && iso.test(args[0]) && iso.test(args[1]) && args[0] <= args[1]) {
    return { from: args[0], to: args[1] };
  }
  return null;
}

export function exportRows(txns) {
  return txns.map((t) => [
    t.occurred_on,
    t.merchant || t.merchant_raw || "",
    fromMinor(t.amount_minor),
    t.currency,
    t.direction === "debit" ? "Debit" : "Credit",
    t.category || "",
    t.kind,
    fromMinor(t.effective_minor),
    t.account_last4 || "",
    t.reference || "",
    t.forwarder || "",
    t.status,
    t.id
  ]);
}

// RFC 4180, with formula-looking text cells neutralised for spreadsheets.
export function toCsv(rows) {
  const cell = (v) => {
    if (typeof v === "number") return String(v);
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const rangeKey = (r) => (r.from ? r.from + "_" + r.to : "all");
const rangeFromKey = (k) =>
  k && k !== "all" ? { from: k.split("_")[0], to: k.split("_")[1] } : { from: null, to: null };
const rangeLabel = (r) => (r.from ? r.from + " → " + r.to : "all time");

async function loadRows(ctx, chatId, range) {
  const txns = await listEffectiveTransactions(ctx.db, chatId, {
    from: range.from,
    to: range.to,
    statuses: ["confirmed", "review"]
  });
  return exportRows(txns);
}

export async function handleExport(ctx, chatId, text) {
  const range = parseExportRange(text);
  if (!range) {
    await ctx.tg.sendMessage(chatId, USAGE);
    return;
  }
  const rows = await loadRows(ctx, chatId, range);
  if (!rows.length) {
    await ctx.tg.sendMessage(chatId, "📭 No transactions for " + rangeLabel(range) + ".", { parse_mode: null });
    return;
  }
  await ctx.tg.sendDocument(chatId, {
    filename: "dus-aane-bot-" + (range.from ? range.from + "-to-" + range.to : "all") + ".csv",
    content: toCsv([EXPORT_HEADER, ...rows]),
    caption: rows.length + " transactions · " + rangeLabel(range),
    replyMarkup: {
      inline_keyboard: [[{ text: "📊 Open in Google Sheets", callback_data: "export_sheet_" + rangeKey(range) }]]
    }
  });
}

// Write the export into the tenant's export sheet (one per tenant, rewritten
// each time) shared with their registered emails.
export async function handleExportSheet(ctx, chatId, key) {
  const range = rangeFromKey(key);
  const rows = await loadRows(ctx, chatId, range);
  if (!rows.length) {
    await ctx.tg.sendMessage(chatId, "📭 No transactions for " + rangeLabel(range) + ".", { parse_mode: null });
    return;
  }
  await ctx.tg.sendChatAction(chatId).catch(() => {});
  const settingKey = "export_sheet:" + chatId;
  let res;
  try {
    res = await callAppsScript(ctx, "export_to_sheet", {
      sheetId: await getSetting(ctx.db, settingKey, ""),
      title: "Dus Aane Bot — export",
      emails: await getTenantEmails(ctx.db, chatId),
      header: EXPORT_HEADER,
      rows
    });
  } catch (e) {
    console.error("[export sheet]", e && e.message);
    await ctx.tg.sendMessage(
      chatId,
      "❌ Couldn't create the Google Sheet right now. The CSV above has the same data.",
      {
        parse_mode: null
      }
    );
    return;
  }
  await setSetting(ctx.db, settingKey, res.sheetId, ctx.now());
  await ctx.tg.sendMessage(
    chatId,
    "📊 *Exported " +
      rows.length +
      " transactions* (" +
      rangeLabel(range) +
      ")\n\n_A snapshot — it doesn't update. Open it signed in with your registered Gmail._",
    { reply_markup: { inline_keyboard: [[{ text: "📊 Open sheet", url: res.url }]] } }
  );
}

// ─── /deletemydata ───────────────────────────────────────────────────

export async function handleDeleteMyData(ctx, chatId, tenant) {
  if (!tenant) {
    await ctx.tg.sendMessage(chatId, "There's no data stored for this chat.", { parse_mode: null });
    return;
  }
  await ctx.tg.sendMessage(
    chatId,
    "⚠️ *Delete all your data?*\n\n" +
      "This permanently removes your transactions, registered emails, merchant tags and settings. " +
      "Splits you paid are removed from your groups' balances; your shares in others' splits stay so their balances still add up.\n\n" +
      "_Exported CSVs and Google Sheet copies aren't affected. This can't be undone — /export first if you want a copy._",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🗑 Delete everything", callback_data: "wipe_yes" },
            { text: "← Keep my data", callback_data: "wipe_no" }
          ]
        ]
      }
    }
  );
}

export async function handleWipeCallback(ctx, chatId, messageId, answer) {
  if (answer !== "yes") {
    await ctx.tg.editMessageText(chatId, messageId, "👍 Nothing was deleted.", { parse_mode: null });
    return;
  }
  const groups = await groupsForMember(ctx.db, chatId);
  await deleteTenantData(ctx.db, chatId);
  for (const g of groups) await refreshBalancesPin(ctx, g);
  await ctx.tg.editMessageText(
    chatId,
    messageId,
    "🗑 Done — all your data is deleted. Send /start any time to begin again.",
    { parse_mode: null }
  );
}
