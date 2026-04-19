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

// Bank sender domains — matched as substrings by Gmail's `from:` operator.
// Add new banks here; no label setup needed.
const BANK_FROM_DOMAINS = [
  "bank.in",
  "bank.com",
  "bank.net",
  "bank.co.in",
  "sbi.co.in",
  "hsbc.co.in",
  "idbi.co.in",
  "idfcfirstbank.com",
  "pnbindia.in",
  "bobmail.in",
  "bankofbaroda.com",
  "bobcard.in",
  "sc.com",
  "standardchartered.com",
  "citi.com",
  "kotak.com",
  "indusind.com",
  "americanexpress.com",
  "goniyo.com",
  "sbicard.com"
];

// Specific senders / marketing subdomains to ignore even though they match BANK_FROM_DOMAINS.
// Quote phrases with spaces; plain addresses and subdomains don't need quoting.
const IGNORE_SENDERS = [
  "services@custcomm.icici.bank.in",
  "email.americanexpress.com",
  "cc.statements@axis.bank.in",
  "statements@axis.bank.in",
  "statements@hdfcbank.net",
  "digital.axisbankmail.bank.in",
  "information@yes.bank.in",
  "customer.communication@custcom.yes.bank.in",
  "information@hdfcbank.bank.in",
  "welcome.americanexpress.com",
  "information@mailers.hdfcbank.bank.in",
  "communications.sbi.co.in",
  "no-reply@alerts.sbi.co.in",
  "noreply@alerts.sbi.co.in",
  "cbssbi.info@alerts.sbi.co.in",
  "feedbackemail.americanexpress.com",
  "global@goniyo.com",
  "global.escalation@goniyo.com",
  "paylink.india@citi.com",
  "yonosbi@alerts.sbi.co.in",
  "no-reply@goniyo.com",
  "indusind_bank@indusind.com",
  "yonobysbi@alerts.sbi.co.in",
  "yonobysbi@sbi.co.in",
  "investor@indusind.com",
  "sbm-global@goniyo.com",
  "hsbc@informationservices.hsbc.co.in",
  "custcomm.hsbc.co.in",
  "kycEmailintimation@hdfcbank.bank.in",
  "customer-support@equitas.bank.in",
  "HSBC-CreditCard@notification.hsbc.co.in",
  "hsbc-ckycr@hsbc.co.in",
  "CkycEmailintimation@hdfcbank.bank.in",
  "cmdnoreply@indusind.com",
  "customerinfo@hdfcbank.bank.in",
  "advices@idfcfirst.bank.in",
  "Creditcard.closure@indusind.com"
];

// Subject keywords/phrases that indicate non-transaction mail (OTPs, statements, security alerts, marketing).
const IGNORE_SUBJECTS = [
  "statement",
  '"e-statement"',
  '"scheduled maintenance"',
  "maintenance",
  "OTP",
  "MPIN",
  '"one time password"',
  '"one-time password"',
  '"temporary security code"',
  '"security code"',
  "verification",
  "verify",
  '"security alert"',
  "password",
  "login",
  '"sign in"',
  '"sign-in"',
  '"trusted device"',
  '"new device"',
  '"device added"',
  '"payment due"',
  '"payment reminder"',
  '"due reminder"',
  '"transaction limit"',
  '"transaction limits"',
  '"upcoming autopay"',
  '"autopay reminder"',
  '"upcoming transaction"',
  '"successful log on"',
  '"logged on"',
  '"logged in"',
  '"pin reset"',
  '"reset pin"',
  '"pin change"',
  '"face id"',
  '"biometric"',
  '"mobile banking"',
  "offer",
  "offers"
];

// Gmail categories to exclude (marketing, notifications, groups).
// Currently empty — bank transaction mail has historically been mis-categorized
// as Promotions, so we rely on sender/subject filters instead.
const IGNORE_CATEGORIES = [];

// Gmail search query: process any email that arrives in the bot inbox.
// The bot account exists only for this bot, so every inbox message is a
// forwarded bank alert (either via Cloudflare Email Routing from
// dus-aane-bot@healthvault.online, or forwarded directly to
// dusaanebot.inbox@gmail.com). The forwarder's email is extracted from
// the From: header per-message to tag the transaction's user.
const GMAIL_SEARCH_QUERY = `in:inbox`;
