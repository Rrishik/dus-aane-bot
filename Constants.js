// Debug flag
const DEBUG = false;
const BACKFILL = true;

const CHAT_ID = DEBUG ? PERSONAL_CHAT_ID : GROUP_CHAT_ID; // Use Rishik's chat ID for debugging
const BOT_UPDATE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
const BOT_EDIT_MESSAGE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
const BOT_SEND_MESSAGE_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const BOT_ANSWER_CALLBACK_QUERY_URL = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
const BOT_ADD_TRANSACTION_KEYWORD = 'addTransaction';


// Google Sheets
const SHEET_ID = DEBUG ? TEST_SHEET_ID : PROD_SHEET_ID;
const SPLIT_COLUMN = 8; // Column H


// Gmail
const MAILS_LOOKBACK_PERIOD = DEBUG ? '1d' : BACKFILL ? '6d' : '1h';