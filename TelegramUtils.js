function deleteWebhook() {
  sendRequest(BOT_DELETE_WEBHOOK_URL, "post", {});
}

// Set up webhook (Run this once)
function setTelegramWebhook() {
  // First delete any existing webhook
  deleteWebhook();
  var payload = {
    url: DEBUG ? TEST_SCRIPT_APP_URL : SCRIPT_APP_URL,
  }

  sendRequest(BOT_SET_WEBHOOK_URL, "post", payload);
}

function deleteTelegramCommands() {
  sendRequest(BOT_DELETE_COMMANDS_URL, "post", {});
  if (DEBUG) console.log("Telegram commands deleted successfully.");
}

function setTelegramCommands() {
  var commands = [
    { command: "/start", description: "Start the bot" },
    { command: "/help", description: "Get help" }];
  var payload = {
    commands: commands
  };
  sendRequest(BOT_SET_COMMANDS_URL, "post", payload);
  if (DEBUG) console.log("Telegram commands set successfully.");
}

// Utility to send a Telegram message
function sendTelegramMessage(chat_id, message, options = {}) {
  var payload = {
    chat_id: chat_id,
    text: message,
    parse_mode: options.parse_mode || "Markdown",
    reply_markup: options.reply_markup ? JSON.stringify(options.reply_markup) : undefined
  };

  var message_url = BOT_SEND_MESSAGE_URL;
  if (options.message_id) {
    payload.message_id = options.message_id;
    message_url = BOT_EDIT_MESSAGE_URL;
  }

  sendRequest(message_url, "post", payload);
}

// Utility to acknowledge a callback query
function answerCallbackQuery(callback_query_id, text = "✅ Updated Successfully!", show_alert = false) {
  var payload = {
    callback_query_id: callback_query_id,
    text: text,
    show_alert: show_alert
  };

  sendRequest(BOT_ANSWER_CALLBACK_QUERY_URL, "post", payload);
  console.log("Callback query answered");
}

function sendRequest(url, method, payload) {
  var MAX_RETRIES = 5; // Maximum number of retries for rate-limited requests
  var INITIAL_RETRY_DELAY_MS = 1000; // Initial delay in milliseconds if retry_after is not provided

  for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
    var options = {
      method: method,
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true // Crucial for manually handling HTTP errors
    };

    var response = UrlFetchApp.fetch(url, options);
    var response_code = response.getResponseCode();
    var response_body = response.getContentText();

    if (response_code === 200) {
      if (DEBUG) {
        console.log("API request successful for URL: " + url + "\nResponse: " + response_body);
      }
      return response; // Success
    } else if (response_code === 429) {
      console.warn("API rate limit hit (429) for URL: " + url + ". Attempt " + (attempt + 1) + " of " + MAX_RETRIES + ".");
      console.warn("Response body: " + response_body);

      var retry_after_seconds = 0;
      try {
        var error_data = JSON.parse(response_body);

        // 1. Check for standard Telegram `parameters.retry_after`
        if (error_data && error_data.parameters && error_data.parameters.retry_after) {
          retry_after_seconds = parseInt(error_data.parameters.retry_after, 10);
          retry_after_seconds = parseInt(error_data.parameters.retry_after, 10);
          console.log("API suggested retry_after (Telegram format): " + retry_after_seconds + " seconds.");
        }

        // 2. Check for Gemini `error.message` containing "Please retry in Xs"
        else if (error_data && error_data.error && error_data.error.message) {
          var message = error_data.error.message;
          var match = message.match(/Please retry in\s+([\d\.]+)\s*s/);
          if (match && match[1]) {
            retry_after_seconds = Math.ceil(parseFloat(match[1]));
            console.log("Gemini API error message suggested retry_after: " + retry_after_seconds + " seconds.");
          }
        }

        // 3. Check for Google RPC RetryInfo in `error.details`
        if (!retry_after_seconds && error_data && error_data.error && error_data.error.details) {
          error_data.error.details.forEach(function (detail) {
            if (detail["@type"] && detail["@type"].includes("RetryInfo") && detail.retryDelay) {
              // detail.retryDelay might be "52s"
              var delayStr = detail.retryDelay;
              if (delayStr.endsWith('s')) {
                retry_after_seconds = Math.ceil(parseFloat(delayStr));
                console.log("Gemini API details suggested retry_after: " + retry_after_seconds + " seconds.");
              }
            }
          });
        }

      } catch (e) {
        console.error("Could not parse retry_after from 429 response: " + e);
      }

      var delay_ms = (retry_after_seconds * 1000) || INITIAL_RETRY_DELAY_MS;

      // If we got a specific 429, we should probably wait closer to the suggestion + buffer
      if (retry_after_seconds > 0) {
        delay_ms += 1000; // Add 1s buffer
      } else {
        // Exponential backoff if no specific time given
        delay_ms = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      }

      if (attempt < MAX_RETRIES - 1) {
        console.log("Waiting for " + (delay_ms / 1000) + " seconds before retrying...");
        Utilities.sleep(delay_ms);
      } else {
        console.error("Max retries (" + MAX_RETRIES + ") reached for URL: " + url + ". Giving up on this request.");
        // Throw an error to indicate persistent failure, which will be caught by the calling function's try-catch
        throw new Error("API request failed after " + MAX_RETRIES + " attempts due to rate limiting. Last response code: " + response_code + ", body: " + response_body);
      }
    } else {
      // Handle other non-200, non-429 errors
      console.error("API request failed for URL: " + url + ". Response Code: " + response_code + ". Response Body: " + response_body);
      throw new Error("API request failed. Response Code: " + response_code + ", body: " + response_body);
    }
  }
  // Fallback, should ideally not be reached if logic above is correct
  throw new Error("API request failed unexpectedly after all retries for URL: " + url);
}

function buildReplyMarkup(text, callback_data) {
  return {
    inline_keyboard: [
      [{ text: text, callback_data: callback_data }]
    ]
  };
}

// Function to escape special characters for Markdown
function escapeMarkdown(text) {
  if (typeof text !== 'string' || text === null) {
    return text;
  }
  return text.replace(/([_*\[\]()~`>#+=|{}!])/g, '\\$1');
}