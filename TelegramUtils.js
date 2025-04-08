// Set up webhook (Run this once)
function setTelegramWebhook() {
  var url = "https://api.telegram.org/bot" + BOT_TOKEN + "/setWebhook";
  var webhookUrl = "https://script.google.com/macros/s/AKfycbzia6ZMpsfBklC2fTlDR8d2tEYt-ACrxvs6xHBKvHAf6dzUbhMbYsK66h-7zo5yW4qO/exec";
  
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
}

function getReplyMarkup(text, callbackData) {
  return {
    inline_keyboard: [
      [{ text: text, callback_data: callbackData }]
    ]
  };
}