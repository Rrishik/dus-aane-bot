// Bot-wide constants for the native Worker app. Mirrors Constants.js in the
// Apps Script project until cutover, when that copy is deleted.

export const CATEGORIES = [
  "Shopping",
  "Groceries",
  "Food & Dining",
  "Healthcare",
  "Fuel",
  "Entertainment",
  "Travel",
  "Bills & Utilities",
  "Education",
  "Investment",
  "Subscriptions",
  "CC Bill Payment",
  "Transfer Out"
];

export const CREDIT_CATEGORIES = ["Salary", "Refund", "Cashback", "Transfer In", "Reimbursement", "Interest/Dividend"];

export const CATEGORY_EMOJIS = {
  Shopping: "🛍",
  Groceries: "🥦",
  "Food & Dining": "🍕",
  Healthcare: "🏥",
  Fuel: "⛽",
  Entertainment: "🎬",
  Travel: "✈️",
  "Bills & Utilities": "💡",
  Education: "🎓",
  Investment: "📈",
  Subscriptions: "📱",
  "CC Bill Payment": "💳",
  "Transfer Out": "📤",
  Salary: "💼",
  Refund: "🔄",
  Cashback: "🎁",
  "Transfer In": "📥",
  Reimbursement: "🧾",
  "Interest/Dividend": "🏦"
};

export const CATEGORY_SHORT_NAMES = {
  "Food & Dining": "Food",
  "Bills & Utilities": "Bills",
  "CC Bill Payment": "CC Bill",
  "Interest/Dividend": "Interest",
  Reimbursement: "Reimburse",
  "Transfer In": "Transfer",
  "Transfer Out": "Transfer"
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

export const TAG_MAX_LEN = 18;
export const MAX_GROUP_MEMBERS = 4;
export const FREE_ASK_LIMIT = 5;
export const SMS_PASTE_MAX = 10;
export const BOT_INBOX_EMAIL = "dusaanebot.inbox@gmail.com";
export const TIMEZONE = "Asia/Kolkata";

export function categoriesFor(direction) {
  return direction === "credit" ? CREDIT_CATEGORIES : CATEGORIES;
}
