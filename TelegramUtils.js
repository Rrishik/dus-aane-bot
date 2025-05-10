function deleteWebhook() {
  var url = "https://api.telegram.org/bot" + BOT_TOKEN + "/deleteWebhook";
  sendRequest(url, "post", {});
}

// Set up webhook (Run this once)
function setTelegramWebhook() {
  // First delete any existing webhook
  deleteWebhook();

  var url = "https://api.telegram.org/bot" + BOT_TOKEN + "/setWebhook";
  
  var payload = {
    url: SCRIPT_APP_URL,
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
  var MAX_RETRIES = 3; // Maximum number of retries for rate-limited requests
  var INITIAL_RETRY_DELAY_MS = 1000; // Initial delay in milliseconds if retry_after is not provided

  for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
    var options = {
      method: method,
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true // Crucial for manually handling HTTP errors
    };

    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();
    var responseBody = response.getContentText();

    if (responseCode === 200) {
      if (DEBUG) {
        console.log("Telegram API request successful for URL: " + url + "\nResponse: " + responseBody);
      }
      return response; // Success
    } else if (responseCode === 429) {
      console.warn("Telegram API rate limit hit (429) for URL: " + url + ". Attempt " + (attempt + 1) + " of " + MAX_RETRIES + ".");
      console.warn("Response body: " + responseBody);
      
      var retryAfterSeconds = 0;
      try {
        var errorData = JSON.parse(responseBody);
        if (errorData && errorData.parameters && errorData.parameters.retry_after) {
          retryAfterSeconds = parseInt(errorData.parameters.retry_after, 10);
          console.log("Telegram API suggested retry_after: " + retryAfterSeconds + " seconds.");
        }
      } catch (e) {
        console.error("Could not parse retry_after from 429 response: " + e);
      }

      var delayMs = (retryAfterSeconds * 1000) || INITIAL_RETRY_DELAY_MS;

      if (attempt < MAX_RETRIES - 1) {
        console.log("Waiting for " + (delayMs / 1000) + " seconds before retrying...");
        Utilities.sleep(delayMs);
      } else {
        console.error("Max retries (" + MAX_RETRIES + ") reached for URL: " + url + ". Giving up on this request.");
        // Throw an error to indicate persistent failure, which will be caught by the calling function's try-catch
        throw new Error("Telegram API request failed after " + MAX_RETRIES + " attempts due to rate limiting. Last response code: " + responseCode + ", body: " + responseBody);
      }
    } else {
      // Handle other non-200, non-429 errors
      console.error("Telegram API request failed for URL: " + url + ". Response Code: " + responseCode + ". Response Body: " + responseBody);
      throw new Error("Telegram API request failed. Response Code: " + responseCode + ", body: " + responseBody);
    }
  }
  // Fallback, should ideally not be reached if logic above is correct
  throw new Error("Telegram API request failed unexpectedly after all retries for URL: " + url);
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