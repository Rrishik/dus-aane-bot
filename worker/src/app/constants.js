// Bot-wide constants: categories, currency symbols, limits.

export const CATEGORIES = ["Food", "Groceries", "Shopping", "Travel", "Bills", "Health", "Fun", "Invest", "Transfer"];

export const CREDIT_CATEGORIES = ["Income", "Refund", "Transfer"];

export const CATEGORY_EMOJIS = {
  Food: "🍕",
  Groceries: "🥦",
  Shopping: "🛍",
  Travel: "🚕",
  Bills: "🏠",
  Health: "💊",
  Fun: "🎬",
  Invest: "📈",
  Transfer: "💸",
  Income: "💼",
  Refund: "↩️"
};

export const CURRENCY_SYMBOLS = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
  HKD: "HK$",
  NZD: "NZ$",
  CHF: "CHF ",
  AED: "AED ",
  SAR: "SAR ",
  THB: "฿",
  KRW: "₩",
  RUB: "₽",
  TRY: "₺",
  ZAR: "R "
};

export const TAG_MAX_LEN = 28;
export const PILL_MAX_LEN = 18;
export const MAX_GROUP_MEMBERS = 4;
export const FREE_ASK_LIMIT = 20;
export const SMS_PASTE_MAX = 10;
export const BOT_INBOX_EMAIL = "dusaanebot.inbox@gmail.com";

export function categoriesFor(direction) {
  return direction === "credit" ? CREDIT_CATEGORIES : CATEGORIES;
}
