// /stats trends and the weekly digest, ported from Analytics.js. Spend is
// kind = 'spend' (card bill payments, transfers and investments excluded).
import { listEffectiveTransactions } from "../db/analytics.js";
import { CATEGORY_EMOJIS } from "./constants.js";
import { escapeMarkdown, formatAmount, formatAmountCompact, currencySymbol, shortCategoryName } from "./format.js";
import { shiftIsoDate, istDate } from "../util/dates.js";
import { fromMinor } from "../util/money.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sumByCurrency(rows) {
  const out = {};
  rows.forEach((r) => {
    out[r.currency] = (out[r.currency] || 0) + fromMinor(r.effective_minor);
  });
  return out;
}

export function buildTrendBucket(rows, label) {
  const spend = rows.filter((r) => r.kind === "spend");
  const credits = rows.filter((r) => r.direction === "credit");
  const categorySpend = {};
  spend.forEach((r) => {
    const c = r.category || "Uncategorized";
    categorySpend[c] = (categorySpend[c] || 0) + fromMinor(r.effective_minor);
  });
  return {
    label,
    txnCount: rows.length,
    debitByCurrency: sumByCurrency(spend),
    creditByCurrency: sumByCurrency(credits),
    categorySpend
  };
}

// Rolling 7-day window ending the day before `todayIso`.
export function weekRangeFor(todayIso) {
  const end = shiftIsoDate(todayIso, -1);
  return { start: shiftIsoDate(end, -6), end };
}

export async function monthlyTrends(db, tenantId, nowMs, numMonths = 6) {
  const today = istDate(nowMs);
  let [y, m] = today.split("-").map(Number);
  const months = [];
  for (let i = 0; i < numMonths; i++) {
    months.unshift({ y, m });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const pad = (n) => String(n).padStart(2, "0");
  const from = months[0].y + "-" + pad(months[0].m) + "-01";
  const rows = await listEffectiveTransactions(db, tenantId, { from });
  return months.map(({ y: yy, m: mm }) => {
    const prefix = yy + "-" + pad(mm) + "-";
    return buildTrendBucket(
      rows.filter((r) => r.occurred_on.startsWith(prefix)),
      MONTHS[mm - 1] + " " + String(yy).slice(2)
    );
  });
}

export async function weeklyTrends(db, tenantId, nowMs, numWeeks = 5) {
  const today = istDate(nowMs);
  const ranges = [];
  for (let i = numWeeks - 1; i >= 0; i--) ranges.push(weekRangeFor(shiftIsoDate(today, -7 * i)));
  const rows = await listEffectiveTransactions(db, tenantId, { from: ranges[0].start, to: ranges.at(-1).end });
  return ranges.map((r) => {
    const [, mm, dd] = r.start.split("-");
    return buildTrendBucket(
      rows.filter((x) => x.occurred_on >= r.start && x.occurred_on <= r.end),
      MONTHS[Number(mm) - 1] + " " + dd
    );
  });
}

// 8-cell bar; positive values always get ≥1 filled cell.
function makeBar(value, buckets) {
  const max = Math.max(0, ...buckets.map((b) => b.debitByCurrency.INR || 0));
  if (max === 0) return "░".repeat(8);
  let len = Math.round((value / max) * 8);
  if (value > 0 && len === 0) len = 1;
  return "█".repeat(len) + "░".repeat(8 - len);
}

export function formatTrendsMessage(buckets, { title = "📉 *Spending Trends*", comparisonLabel = "vs Previous" } = {}) {
  let msg = title + "\n\n";
  const labelWidth = Math.max(...buckets.map((b) => b.label.length));
  const inrAmounts = buckets.map((b) => formatAmountCompact(b.debitByCurrency.INR || 0));
  const amtWidth = Math.max(...inrAmounts.map((a) => a.length));

  msg += "🔴 *Spend (INR):*\n";
  buckets.forEach((b, i) => {
    const bar = makeBar(b.debitByCurrency.INR || 0, buckets);
    msg += "`" + b.label.padEnd(labelWidth) + "  " + bar + "  ₹" + inrAmounts[i].padEnd(amtWidth) + "`\n";
  });

  const otherLine = (byCcy) =>
    Object.keys(byCcy)
      .filter((c) => byCcy[c] > 0)
      .map((c) => currencySymbol(c) + formatAmountCompact(byCcy[c]))
      .join(", ");
  if (buckets.some((b) => Object.keys(b.debitByCurrency).some((c) => c !== "INR"))) {
    msg += "\n🌍 *Other Currency Spend:*\n";
    buckets.forEach((b) => {
      const others = {};
      Object.keys(b.debitByCurrency)
        .filter((c) => c !== "INR")
        .forEach((c) => (others[c] = b.debitByCurrency[c]));
      const line = otherLine(others);
      if (line) msg += "`" + b.label.padEnd(labelWidth) + "  " + line + "`\n";
    });
  }
  if (buckets.some((b) => Object.keys(b.creditByCurrency).length > 0)) {
    msg += "\n🟢 *Credits:*\n";
    buckets.forEach((b) => {
      const line = otherLine(b.creditByCurrency);
      if (line) msg += "`" + b.label.padEnd(labelWidth) + "  " + line + "`\n";
    });
  }

  if (buckets.length >= 2) {
    const curr = buckets.at(-1);
    const prev = buckets.at(-2);
    const currTotal = curr.debitByCurrency.INR || 0;
    const prevTotal = prev.debitByCurrency.INR || 0;
    if (prevTotal > 0) {
      const delta = currTotal - prevTotal;
      const pct = ((delta / prevTotal) * 100).toFixed(1);
      msg +=
        "\n*" +
        comparisonLabel +
        ":* " +
        (delta >= 0 ? "📈 +" : "📉 ") +
        "₹" +
        formatAmountCompact(Math.abs(delta)) +
        " (" +
        (delta >= 0 ? "+" : "") +
        pct +
        "%)\n";
    }
    const cats = new Set([...Object.keys(curr.categorySpend), ...Object.keys(prev.categorySpend)]);
    const movers = [...cats]
      .map((c) => ({ category: c, delta: (curr.categorySpend[c] || 0) - (prev.categorySpend[c] || 0) }))
      .filter((d) => d.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 3);
    if (movers.length) {
      msg += "\n🔄 *Biggest Changes:*\n";
      movers.forEach((d) => {
        msg +=
          (CATEGORY_EMOJIS[d.category] || "•") +
          " " +
          escapeMarkdown(shortCategoryName(d.category)) +
          " " +
          (d.delta > 0 ? "↑" : "↓") +
          " ₹" +
          formatAmountCompact(Math.abs(d.delta)) +
          "\n";
      });
    }
  }
  return msg;
}

// Weekly digest data for [start, end] plus the previous week for the delta.
export async function weeklyDigestData(db, tenantId, range) {
  const prev = weekRangeFor(range.start);
  const rows = await listEffectiveTransactions(db, tenantId, { from: prev.start, to: range.end });
  const inWeek = rows.filter((r) => r.occurred_on >= range.start && r.occurred_on <= range.end);
  if (inWeek.length === 0) return null;
  const spend = inWeek.filter((r) => r.kind === "spend");
  const prevSpend = rows.filter((r) => r.occurred_on <= prev.end && r.kind === "spend");
  const categorySpend = {};
  spend.forEach((r) => {
    const key = (r.category || "Uncategorized") + "|||" + r.currency;
    categorySpend[key] = (categorySpend[key] || 0) + fromMinor(r.effective_minor);
  });
  return {
    totalTransactions: inWeek.length,
    spentByCurrency: sumByCurrency(spend),
    prevSpentByCurrency: sumByCurrency(prevSpend),
    categorySpend,
    topTransactions: spend
      .slice()
      .sort((a, b) => b.effective_minor - a.effective_minor)
      .slice(0, 5)
      .map((r) => ({ merchant: r.merchant, amount: fromMinor(r.effective_minor), occurredOn: r.occurred_on }))
  };
}

export function formatWeeklyMessage(range, data) {
  const label = (iso) => {
    const [, mm, dd] = iso.split("-");
    return MONTHS[Number(mm) - 1] + " " + Number(dd);
  };
  const inr = data.spentByCurrency.INR || 0;
  const prevInr = data.prevSpentByCurrency.INR || 0;
  let msg = "📅 *Last Week* — " + label(range.start) + "–" + label(range.end) + "\n";
  msg += "🔴 ₹" + formatAmount(inr);
  if (prevInr > 0) {
    const diff = inr - prevInr;
    msg +=
      "  _(vs ₹" +
      formatAmount(prevInr) +
      ", " +
      (diff >= 0 ? "↑" : "↓") +
      Math.abs(Math.round((diff / prevInr) * 100)) +
      "%)_";
  }
  msg += "\n";
  const others = Object.keys(data.spentByCurrency).filter((c) => c !== "INR" && data.spentByCurrency[c] > 0);
  if (others.length) {
    msg += "🌍 " + others.map((c) => currencySymbol(c) + formatAmount(data.spentByCurrency[c])).join(" · ") + "\n";
  }
  msg += "\n";

  const sorted = Object.keys(data.categorySpend).sort((a, b) => data.categorySpend[b] - data.categorySpend[a]);
  const top = sorted.slice(0, 5);
  const nameWidth = Math.max(0, ...top.map((k) => k.split("|||")[0].length));
  const amounts = top.map((k) => formatAmount(data.categorySpend[k]));
  const amtWidth = Math.max(0, ...amounts.map((a) => a.length));
  top.forEach((k, i) => {
    const cat = k.split("|||")[0];
    msg += (CATEGORY_EMOJIS[cat] || "•") + " `" + cat.padEnd(nameWidth) + "  ₹" + amounts[i].padEnd(amtWidth) + "`\n";
  });
  if (sorted.length > 5) {
    const rest = sorted.slice(5).reduce((s, k) => s + data.categorySpend[k], 0);
    msg +=
      "   `" +
      ("+" + (sorted.length - 5) + " more").padEnd(nameWidth) +
      "  ₹" +
      formatAmount(rest).padEnd(amtWidth) +
      "`\n";
  }
  if (data.topTransactions.length) {
    msg += "\n💳 *Top:*\n";
    data.topTransactions.forEach((t, i) => {
      msg +=
        i +
        1 +
        ". " +
        escapeMarkdown(t.merchant || "Unknown") +
        "  ₹" +
        formatAmount(t.amount) +
        "  " +
        label(t.occurredOn) +
        "\n";
    });
  }
  return msg;
}
