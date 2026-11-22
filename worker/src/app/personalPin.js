// Minimalist live-pinned summary for personal DMs.
//
// Line 1 is tuned for Telegram's sticky top-bar preview ("Oct 2026 · ₹18,420
// spent · 2 untagged"); tapping the bar jumps to top categories, group net
// balances, and zero-LLM [Recent] / [Trends] / [Categorize] buttons.
import { getTenant, setPinMessageId, groupsForMember } from "../db/tenants.js";
import { listEffectiveTransactions } from "../db/analytics.js";
import { countUntaggedTransactions } from "../db/transactions.js";
import { getLatestCachedFxRate } from "../db/fxRates.js";
import { groupBalances } from "../db/splits.js";
import { simplifyDebts } from "./groups.js";
import { CATEGORY_EMOJIS } from "./constants.js";
import { escapeMarkdown, currencySymbol, formatAmountCompact, formatMonthYear, money } from "./format.js";
import { istDate, shiftIsoDate } from "../util/dates.js";
import { fromMinor } from "../util/money.js";

const PIN_SKIP = "skip";

export async function personalPinData(ctx, tenantId) {
  const tid = String(tenantId);
  const today = istDate(ctx.now());
  const monthStart = today.slice(0, 8) + "01";
  const [rows, untaggedCount, groups] = await Promise.all([
    listEffectiveTransactions(ctx.db, tid, { from: monthStart, to: today }),
    countUntaggedTransactions(ctx.db, tid, { from: shiftIsoDate(today, -30), to: today }),
    groupsForMember(ctx.db, tid)
  ]);

  const spendByCurrency = {};
  const byCategory = {};
  let hasConvertedFx = false;
  for (const r of rows) {
    if (r.kind !== "spend") continue;
    const cat = r.category || "Uncategorized";
    if (r.effective_inr_minor != null) {
      spendByCurrency.INR = (spendByCurrency.INR || 0) + r.effective_inr_minor;
      if (r.currency !== "INR" && r.effective_minor > 0) hasConvertedFx = true;
      if (cat !== "Uncategorized") {
        byCategory[cat] = (byCategory[cat] || 0) + r.effective_inr_minor;
      }
    } else {
      spendByCurrency[r.currency] = (spendByCurrency[r.currency] || 0) + r.effective_minor;
    }
  }

  const topCategories = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category, minor]) => ({ category, minor }));

  const groupNets = [];
  for (const g of groups) {
    const simplified = simplifyDebts(await groupBalances(ctx.db, g.id)) || {};
    let netInrMinor = 0;
    let approxFx = false;
    const unconverted = [];

    for (const [ccy, edges] of Object.entries(simplified)) {
      let net = 0;
      for (const e of edges || []) {
        if (e.creditor === tid) net += e.amountMinor;
        else if (e.debtor === tid) net -= e.amountMinor;
      }
      if (net === 0) continue;
      if (ccy === "INR") {
        netInrMinor += net;
      } else {
        const rate = await getLatestCachedFxRate(ctx.db, ccy);
        if (rate > 0) {
          netInrMinor += Math.round(net * rate);
          approxFx = true;
        } else {
          unconverted.push({ currency: ccy, netMinor: net });
        }
      }
    }

    groupNets.push({
      name: g.name || "Group",
      currency: "INR",
      netMinor: netInrMinor,
      approxFx,
      unconverted
    });
  }

  return {
    month: formatMonthYear(today),
    spendByCurrency,
    hasConvertedFx,
    txnCount: rows.filter((r) => r.kind === "spend").length,
    topCategories,
    untaggedCount,
    groupNets
  };
}

function headlineSpend(spendByCurrency, hasConvertedFx = false) {
  const keys = Object.keys(spendByCurrency).filter((k) => spendByCurrency[k] > 0);
  if (keys.length === 0) return "₹0 spent";
  const ordered = keys.includes("INR") ? ["INR", ...keys.filter((k) => k !== "INR")] : keys;
  return (
    ordered
      .map((c) => {
        const sym = c === "INR" && hasConvertedFx ? "~₹" : currencySymbol(c);
        return sym + formatAmountCompact(fromMinor(spendByCurrency[c]));
      })
      .join(" + ") + " spent"
  );
}

export function formatPersonalPin(data) {
  const headParts = [
    "📌 *" + escapeMarkdown(data.month) + "*",
    headlineSpend(data.spendByCurrency, data.hasConvertedFx)
  ];
  if (data.untaggedCount > 0) headParts.push("🏷 " + data.untaggedCount + " untagged");
  const lines = [headParts.join(" · ")];

  const bullets = [];
  if (data.topCategories.length > 0) {
    bullets.push(
      "• " +
        data.topCategories
          .map(
            (c) =>
              (CATEGORY_EMOJIS[c.category] || "•") +
              " " +
              escapeMarkdown(c.category) +
              " ₹" +
              formatAmountCompact(fromMinor(c.minor))
          )
          .join(" · ")
    );
  } else if (data.txnCount === 0) {
    bullets.push("_No confirmed spends yet this month._");
  }

  for (const g of data.groupNets) {
    const parts = [];
    const prefix = g.approxFx ? "~" : "";
    if (g.netMinor > 0) parts.push("owed " + prefix + money(g.netMinor, g.currency));
    else if (g.netMinor < 0) parts.push("owe " + prefix + money(-g.netMinor, g.currency));
    for (const u of g.unconverted || []) {
      if (u.netMinor > 0) parts.push("owed " + money(u.netMinor, u.currency));
      else if (u.netMinor < 0) parts.push("owe " + money(-u.netMinor, u.currency));
    }
    const status = parts.length > 0 ? parts.join(" · ") : "_settled up_";
    bullets.push("• 👥 *" + escapeMarkdown(g.name) + "*: " + status);
  }

  if (bullets.length > 0) lines.push("", ...bullets);
  return lines.join("\n");
}

export function personalPinKeyboard(untaggedCount = 0) {
  const rows = [
    [
      { text: "🕒 Recent", callback_data: "stats_recent" },
      { text: "📉 Trends", callback_data: "stats_trends" },
      { text: "💳 Cards", callback_data: "stats_cards" }
    ]
  ];
  if (untaggedCount > 0) {
    rows.push([
      {
        text: "🏷 Categorize " + untaggedCount + " untagged",
        callback_data: "tagq_next"
      }
    ]);
  }
  return { inline_keyboard: rows };
}

// In-place update only: no-op until a pin message has been created.
export async function refreshPersonalPin(ctx, tenantId) {
  const tid = String(tenantId);
  const tenant = await getTenant(ctx.db, tid);
  if (!tenant || tenant.kind !== "personal" || !tenant.pin_message_id || tenant.pin_message_id === PIN_SKIP)
    return false;
  try {
    const data = await personalPinData(ctx, tid);
    await ctx.tg.editMessageText(tid, Number(tenant.pin_message_id), formatPersonalPin(data), {
      disable_web_page_preview: true,
      reply_markup: personalPinKeyboard(data.untaggedCount)
    });
    return true;
  } catch (e) {
    console.error("[personalPin] refresh failed:", e && e.message);
    return false;
  }
}

// Create and pin the live summary if absent, or update the existing one.
export async function ensurePersonalPin(ctx, tenantId) {
  const tid = String(tenantId);
  const tenant = await getTenant(ctx.db, tid);
  if (!tenant || tenant.kind !== "personal") return null;
  const data = await personalPinData(ctx, tid);
  const text = formatPersonalPin(data);
  const opts = { disable_web_page_preview: true, reply_markup: personalPinKeyboard(data.untaggedCount) };

  if (tenant.pin_message_id && tenant.pin_message_id !== PIN_SKIP) {
    try {
      await ctx.tg.editMessageText(tid, Number(tenant.pin_message_id), text, opts);
      return { messageId: Number(tenant.pin_message_id), created: false };
    } catch (_) {
      // Deleted by user — recreate below.
    }
  }

  const sent = await ctx.tg.sendMessage(tid, text, opts);
  if (!sent || !sent.message_id) return null;
  try {
    await ctx.tg.pinChatMessage(tid, sent.message_id, true);
    await setPinMessageId(ctx.db, tid, sent.message_id);
  } catch (_) {
    await setPinMessageId(ctx.db, tid, PIN_SKIP);
  }
  return { messageId: sent.message_id, created: true };
}
