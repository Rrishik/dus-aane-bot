function deleteWebhook() {
  var url = "https://api.telegram.org/bot" + BOT_TOKEN + "/deleteWebhook";
  sendRequest(url, "post", {});
}

// Set up webhook (Run this once)
function setTelegramWebhook() {
  // First delete any existing webhook
  deleteWebhook();

  var url = "https://api.telegram.org/bot" + BOT_TOKEN + "/setWebhook";
  var webhookUrl = ScriptApp.getService().getUrl();
  
  var payload = {
    url: webhookUrl,
  }

  sendRequest(url, "post", payload);
}

// Utility to send a Telegram message
function sendTelegramMessage(chatId, message, options = {}) {
  var payload = {
    chat_id: chatId,
    text: message,
    parse_mode: options.parseMode || "Markdown",
    reply_markup: options.replyMarkup ? JSON.stringify(options.replyMarkup) : undefined
  };

  var messageURL = BOT_SEND_MESSAGE_URL;
  if (options.messageId) {
    payload.message_id = options.messageId;
    messageURL = BOT_EDIT_MESSAGE_URL;
  }

  sendRequest(messageURL, "post", payload);
}

// Utility to acknowledge a callback query
function answerCallbackQuery(callbackQueryId, text = "✅ Updated Successfully!", showAlert = false) {
  var payload = {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  };

  sendRequest(BOT_ANSWER_CALLBACK_QUERY_URL, "post", payload);
  console.log("Callback query answered");
}

function sendRequest(url, method, payload) {
  var options = {
    method: method,
    contentType: "application/json",
    payload: JSON.stringify(payload)
  };
  var response = UrlFetchApp.fetch(url, options);
  if (DEBUG) console.log(response.getContentText());
  return response;
}

function getReplyMarkup(text, callbackData) {
  return {
    inline_keyboard: [
      [{ text: text, callback_data: callbackData }]
    ]
  };
}

// Function to escape special characters for Markdown
function escapeMarkdown(text) {
  if (typeof text !== 'string' || text === null) {
    return text;
  }
  return text.replace(/([_*\[\]()~`>#+=|{}.!])/g, '\\$1');
}