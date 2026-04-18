const CHAT_ID = GROUP_CHAT_ID;
const BOT_EDIT_MESSAGE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
const BOT_SEND_MESSAGE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const BOT_DELETE_MESSAGE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
const BOT_ANSWER_CALLBACK_QUERY_URL = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
const BOT_SET_COMMANDS_URL = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
const BOT_DELETE_WEBHOOK_URL = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`;
const BOT_SET_WEBHOOK_URL = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;

// Google Sheets
const SHEET_ID = PROD_SHEET_ID;
const CATEGORY_COLUMN = 5; // Column E
const SPLIT_COLUMN = 8; // Column H
const MESSAGE_ID_COLUMN = 9; // Column I
const CURRENCY_COLUMN = 10; // Column J
const EMAIL_LINK_COLUMN = 11; // Column K

// Split Status Values (enum-like constants)
const SPLIT_STATUS = {
  PERSONAL: "Personal", // 100% mine
  SPLIT: "Split", // 50/50 between users
  PARTNER: "Partner" // I paid, 100% belongs to the other user
};

// Category options for the picker
const CATEGORIES = [
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
  "CC Bill Payment"
];

const CREDIT_CATEGORIES = ["Salary", "Refund", "Cashback", "Transfer In", "Reimbursement", "Interest/Dividend"];

const CATEGORY_EMOJIS = {
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
  Salary: "💼",
  Refund: "🔄",
  Cashback: "🎁",
  "Transfer In": "📥",
  Reimbursement: "🧾",
  "Interest/Dividend": "🏦"
};

// Gmail
const MAILS_LOOKBACK_PERIOD = "1h";

// Gmail search query — matches bank transaction emails by sender domain.
// Covers major Indian banks + common legacy domains. Add new banks here, no label setup needed.
// The LLM's not_a_transaction branch handles any remaining noise (OTPs, marketing, etc.).
const GMAIL_SEARCH_QUERY =
  "from:(" +
  "bank.in OR bank.com OR bank.net OR bank.co.in" +
  " OR sbi.co.in OR hsbc.co.in OR idbi.co.in OR pnbindia.in" +
  " OR bobmail.in OR bankofbaroda.com OR bobcard.in" +
  " OR sc.com OR standardchartered.com" +
  " OR citi.com" +
  " OR kotak.com OR indusind.com" +
  " OR americanexpress.com" +
  " OR goniyo.com" +
  ') -subject:(statement OR "e-statement")' +
  " -category:(promotions OR social OR forums)";
