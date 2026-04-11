// Debug flag
const DEBUG = false;
const BACKFILL = "";
// use format YYYY/MM/DD
const BACKFILL_FROM = "";

// AI Provider
const AI_PROVIDERS = {
  GEMINI: 0,
  AZURE_OPENAI: 1
};

const AI_PROVIDER = AI_PROVIDERS.AZURE_OPENAI;

const CHAT_ID = DEBUG ? PERSONAL_CHAT_ID : GROUP_CHAT_ID; // Use Rishik's chat ID for debugging
const BOT_UPDATE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
const BOT_EDIT_MESSAGE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
const BOT_SEND_MESSAGE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const BOT_ANSWER_CALLBACK_QUERY_URL = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
const BOT_SET_COMMANDS_URL = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
const BOT_DELETE_COMMANDS_URL = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMyCommands`;
const BOT_DELETE_WEBHOOK_URL = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`;
const BOT_SET_WEBHOOK_URL = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;

// Google Sheets
const SHEET_ID = DEBUG ? TEST_SHEET_ID : PROD_SHEET_ID;
const SPLIT_COLUMN = 8; // Column H
const MESSAGE_ID_COLUMN = 9; // Column I
const CURRENCY_COLUMN = 10; // Column J

// Split Status Values (enum-like constants)
const SPLIT_STATUS = {
  PERSONAL: "Personal",
  SPLIT: "Split"
};

// Gmail
const MAILS_LOOKBACK_PERIOD = DEBUG ? "1d" : BACKFILL ? BACKFILL : "1h";
