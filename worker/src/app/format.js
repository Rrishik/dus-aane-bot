// Text formatting shared by cards, commands and digests (legacy Markdown).
import { CATEGORY_SHORT_NAMES, CURRENCY_SYMBOLS, TAG_MAX_LEN, TIMEZONE } from "./constants.js";
import { fromMinor } from "../util/money.js";

// Legacy Markdown only treats _ * [ ` as special.
export function escapeMarkdown(text) {
  if (typeof text !== "string") return text;
  return text.replace(/([_*[`])/g, "\\$1");
}

// Whole units, no grouping — phone-width lines are already crowded.
export function formatAmount(num) {
  return String(Math.round(Number(num) || 0));
}

// 12345 → "12.3K"; sub-1K stays an integer.
export function formatAmountCompact(num) {
  const n = Math.round(Number(num) || 0);
  if (n < 1000) return String(n);
  if (n < 1000000) {
    const k = n / 1000;
    return (k < 100 ? k.toFixed(1) : Math.round(k).toString()) + "K";
  }
  const m = n / 1000000;
  return (m < 100 ? m.toFixed(1) : Math.round(m).toString()) + "M";
}

export function currencySymbol(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : (code || "") + " ";
}

export function money(amountMinor, currency) {
  return currencySymbol(currency) + formatAmount(fromMinor(amountMinor));
}

export function shortCategoryName(cat) {
  return CATEGORY_SHORT_NAMES[cat] || cat;
}

export function pillLabel(value, fallback) {
  const v = String(value || "").trim();
  if (!v) return fallback;
  return v.length > TAG_MAX_LEN ? v.substring(0, TAG_MAX_LEN - 1) + "…" : v;
}

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

// "07 Oct 2026, 13:45" in IST.
export function formatDateTime(ms) {
  const p = Object.fromEntries(DATE_TIME.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return p.day + " " + p.month + " " + p.year + ", " + p.hour + ":" + p.minute;
}

// ISO "2026-10-07" → "7 Oct".
export function formatDayMonth(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_MONTH.format(new Date(Date.UTC(y, m - 1, d)));
}
