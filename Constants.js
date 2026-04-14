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
  PERSONAL: "Personal",
  SPLIT: "Split"
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
