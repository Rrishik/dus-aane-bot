function deleteWebhook() {
  sendRequest(BOT_DELETE_WEBHOOK_URL, "post", {});
}

// Set up webhook (Run this once)
// Points to Cloudflare Worker proxy which forwards to Apps Script
function setTelegramWebhook() {
  // First delete any existing webhook
  deleteWebhook();
  var payload = {
    url: WORKER_PROXY_URL,
    // chat_member + my_chat_member don't ship by default — we need them so the
    // bot can detect being added to a group and members joining/leaving.
    // For chat_member to fire reliably the bot must be a group admin (per
    // Telegram docs); we enforce that at /start time.
    allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"]
  };

  sendRequest(BOT_SET_WEBHOOK_URL, "post", payload);
}

function setTelegramCommands() {
  // Only list commands that work without arguments. Commands like /register
  // and /ask need args; Telegram's menu auto-sends on tap with no chance to
  // add an argument, so listing them here just produces usage errors.
  var commands = [
    { command: "/start", description: "Onboard / show welcome" },
    { command: "/register", description: "Register a Gmail address to forward from" },
    { command: "/account", description: "Account & settings" },
    { command: "/recent", description: "Recent transactions (e.g. /recent 10 rishik)" },
    { command: "/stats", description: "Analytics dashboard (monthly, trends, who owes)" },
    { command: "/dashboard", description: "Open your Looker Studio dashboard" },
    { command: "/ownsheet", description: "Transfer Drive ownership of your sheet" },
    { command: "/help", description: "Show available commands" }
  ];
  var payload = {
    commands: commands
  };
  sendRequest(BOT_SET_COMMANDS_URL, "post", payload);
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

  var response = sendRequest(message_url, "post", payload);
  return response ? response.getContentText() : null;
}

// Utility to acknowledge a callback query
function answerCallbackQuery(callback_query_id, text = "✅ Updated Successfully!", show_alert = false) {
  var payload = {
    callback_query_id: callback_query_id,
    text: text,
    show_alert: show_alert
  };

  sendRequest(BOT_ANSWER_CALLBACK_QUERY_URL, "post", payload);
}

// Utility to delete a Telegram message
function deleteTelegramMessage(chat_id, message_id) {
  var payload = {
    chat_id: chat_id,
    message_id: message_id
  };
  sendRequest(BOT_DELETE_MESSAGE_URL, "post", payload);
}

// --- Group-lifecycle read helpers ---
// Thin wrappers around Telegram's read APIs. All return the parsed `result`
// payload on success, or null on any error/non-ok response. Callers must
// tolerate null (network failures, bot kicked, privacy mode, etc.).

function getTelegramChat(chat_id) {
  try {
    var resp = sendRequest(BOT_GET_CHAT_URL, "post", { chat_id: chat_id });
    if (!resp) return null;
    var body = JSON.parse(resp.getContentText());
    return body && body.ok ? body.result : null;
  } catch (e) {
    console.error("getTelegramChat error: " + e);
    return null;
  }
}

// Returns array of ChatMember objects for the chat's owner + admins. Works
// without the bot being an admin itself. Used during /start to seed the
// initial member list (regular non-admin members aren't enumerable via API).
function getTelegramChatAdministrators(chat_id) {
  try {
    var resp = sendRequest(BOT_GET_CHAT_ADMINISTRATORS_URL, "post", { chat_id: chat_id });
    if (!resp) return null;
    var body = JSON.parse(resp.getContentText());
    return body && body.ok ? body.result : null;
  } catch (e) {
    console.error("getTelegramChatAdministrators error: " + e);
    return null;
  }
}

// Best-effort lookup of one user's display name within a chat. Returns the
// user's first_name (preferred), then username, then "" — NEVER throws and
// NEVER returns a chat_id (caller decides the final fallback). Used by the
// split-UI keyboards when a member's personal tenant is missing or has an
// empty name column, so we don't render raw chat_ids on buttons.
//
// Per-execution memo (Apps Script clears globals between runs) keeps repeat
// renders within the same callback dispatch from re-hitting Telegram.
var _CHAT_MEMBER_NAME_CACHE = {};
function getTelegramChatMemberName(chat_id, user_chat_id) {
  var key = String(chat_id) + ":" + String(user_chat_id);
  if (Object.prototype.hasOwnProperty.call(_CHAT_MEMBER_NAME_CACHE, key)) {
    return _CHAT_MEMBER_NAME_CACHE[key];
  }
  var name = "";
  try {
    var resp = sendRequest(BOT_GET_CHAT_MEMBER_URL, "post", { chat_id: chat_id, user_id: user_chat_id });
    if (resp) {
      var body = JSON.parse(resp.getContentText());
      if (body && body.ok && body.result && body.result.user) {
        var u = body.result.user;
        name = u.first_name || u.username || "";
      }
    }
  } catch (e) {
    console.error("getTelegramChatMemberName error: " + e);
  }
  _CHAT_MEMBER_NAME_CACHE[key] = name;
  return name;
}

// Returns the bot's own User object (id, username, ...). Cached in
// ScriptProperties because it never changes for a given BOT_TOKEN — used in
// every my_chat_member / chat_member event to detect "is this about us".
function getTelegramBotUserId() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty("bot_user_id");
  if (cached) return cached;
  try {
    var resp = sendRequest(BOT_GET_ME_URL, "post", {});
    if (!resp) return null;
    var body = JSON.parse(resp.getContentText());
    if (body && body.ok && body.result && body.result.id) {
      var id = String(body.result.id);
      props.setProperty("bot_user_id", id);
      return id;
    }
  } catch (e) {
    console.error("getTelegramBotUserId error: " + e);
  }
  return null;
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
      return response; // Success
    } else if (response_code === 429) {
      console.warn(
        "API rate limit hit (429) for URL: " + url + ". Attempt " + (attempt + 1) + " of " + MAX_RETRIES + "."
      );
      console.warn("Response body: " + response_body);

      var retry_after_seconds = 0;
      try {
        var error_data = JSON.parse(response_body);

        // 1. Check for standard Telegram `parameters.retry_after`
        if (error_data && error_data.parameters && error_data.parameters.retry_after) {
          retry_after_seconds = parseInt(error_data.parameters.retry_after, 10);
        }

        // 2. Check for `error.message` containing "Please retry in Xs"
        else if (error_data && error_data.error && error_data.error.message) {
          var message = error_data.error.message;
          var match = message.match(/Please retry in\s+([\d\.]+)\s*s/);
          if (match && match[1]) {
            retry_after_seconds = Math.ceil(parseFloat(match[1]));
          }
        }

        // 3. Check for Google RPC RetryInfo in `error.details`
        if (!retry_after_seconds && error_data && error_data.error && error_data.error.details) {
          error_data.error.details.forEach(function (detail) {
            if (detail["@type"] && detail["@type"].includes("RetryInfo") && detail.retryDelay) {
              // detail.retryDelay might be "52s"
              var delayStr = detail.retryDelay;
              if (delayStr.endsWith("s")) {
                retry_after_seconds = Math.ceil(parseFloat(delayStr));
              }
            }
          });
        }
      } catch (e) {
        console.error("Could not parse retry_after from 429 response: " + e);
      }

      var delay_ms = retry_after_seconds * 1000 || INITIAL_RETRY_DELAY_MS;

      // If we got a specific 429, we should probably wait closer to the suggestion + buffer
      if (retry_after_seconds > 0) {
        delay_ms += 1000; // Add 1s buffer
      } else {
        // Exponential backoff if no specific time given
        delay_ms = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      }

      if (attempt < MAX_RETRIES - 1) {
        Utilities.sleep(delay_ms);
      } else {
        console.error("Max retries (" + MAX_RETRIES + ") reached for URL: " + url + ". Giving up on this request.");
        // Throw an error to indicate persistent failure, which will be caught by the calling function's try-catch
        throw new Error(
          "API request failed after " +
            MAX_RETRIES +
            " attempts due to rate limiting. Last response code: " +
            response_code +
            ", body: " +
            response_body
        );
      }
    } else {
      // Handle other non-200, non-429 errors
      console.error(
        "API request failed for URL: " + url + ". Response Code: " + response_code + ". Response Body: " + response_body
      );
      throw new Error("API request failed. Response Code: " + response_code + ", body: " + response_body);
    }
  }
  // Fallback, should ideally not be reached if logic above is correct
  throw new Error("API request failed unexpectedly after all retries for URL: " + url);
}

function buildReplyMarkup(buttons) {
  return { inline_keyboard: buttons };
}

function buildCategoryKeyboard(emailMessageId, categories, prefix) {
  var list = categories || CATEGORIES;
  var pfx = prefix || "cat";
  var rows = [];
  var row = [];
  for (var i = 0; i < list.length; i++) {
    var emoji = CATEGORY_EMOJIS[list[i]] || "";
    var label = emoji ? emoji + " " + list[i] : list[i];
    row.push({ text: label, callback_data: pfx + "_" + emailMessageId + "_" + i });
    if (row.length === 3 || i === list.length - 1) {
      rows.push(row);
      row = [];
    }
  }
  return { inline_keyboard: rows };
}

// Function to escape special characters for Markdown
function escapeMarkdown(text) {
  if (typeof text !== "string") {
    return text;
  }
  return text.replace(/([_*\[\]()~`>#+=|{}!])/g, "\\$1");
}

// --- Merged from MessageUtils.js ---

function getTransactionMessageAsString(transaction_details, user) {
  var amount = escapeMarkdown(transaction_details.amount);
  var rawDate = transaction_details.email_date || transaction_details.transaction_date;
  var date = escapeMarkdown(
    rawDate instanceof Date
      ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd MMM yyyy, HH:mm")
      : rawDate || "Unknown Date"
  );
  var merchant = transaction_details.merchant ? escapeMarkdown(transaction_details.merchant) : "—";
  var category = escapeMarkdown(transaction_details.category);
  var currency = transaction_details.currency || "INR";
  user = escapeMarkdown(user);

  var emoji = transaction_details.transaction_type === "Debit" ? "💸" : "💰";
  var message =
    `${emoji} *${currency} ${amount} ${transaction_details.transaction_type}ed*\n` +
    `🗓 *Date:* ${date}\n` +
    `🏪 *Merchant:* ${merchant}\n` +
    (category ? `📂 *Category:* ${category}\n` : "") +
    `👤 *By:* ${user}`;
  return message;
}

function sendTransactionMessage(transaction_details, messageId, user, isNewMerchant) {
  var message = getTransactionMessageAsString(transaction_details, user);

  var options = {
    parse_mode: "Markdown"
  };

  if (messageId) {
    // Legacy ✂️ Split (cycles personal→split→50/50→partner-100) is only useful
    // for users who are in zero groups. Once the user is in any group, the
    // 👥 Split with <Group> ▾ parent button is the canonical path — keeping the
    // legacy split alongside it just clutters the keyboard. ✏️ Category and
    // 🗑️ Delete still apply to the personal row in either case.
    var inAnyGroup = buildGroupParentButtonRows(getTenantChatId(), messageId).length > 0;
    var buttons = inAnyGroup
      ? [
          { text: "✏️ Category", callback_data: "editcat_" + messageId },
          { text: "🗑️ Delete", callback_data: "del_" + messageId }
        ]
      : [
          { text: "✂️ Split", callback_data: "split_" + messageId },
          { text: "✏️ Category", callback_data: "editcat_" + messageId },
          { text: "🗑️ Delete", callback_data: "del_" + messageId }
        ];
    var rows = [buttons];
    // Add "Set Merchant" button if merchant is empty
    if (!transaction_details.merchant) {
      rows.unshift([{ text: "🏠 Set Merchant", callback_data: "setmerch_" + messageId }]);
    }
    // New-merchant flow: one-tap Save plus Edit Merchant (which then prompts for category).
    if (isNewMerchant && transaction_details.merchant) {
      var saveLabel =
        "🆕 Save: " + transaction_details.merchant + " → " + (transaction_details.category || "Uncategorized");
      rows.unshift([{ text: "🏪 Edit Merchant", callback_data: "editmerchname_" + messageId }]);
      rows.unshift([{ text: saveLabel, callback_data: "savemerch_" + messageId }]);
    }
    // Group-split parent buttons (one row per group the user belongs to).
    // Stacked above the action row so the per-group action is the most
    // prominent option. When the user is in zero groups this is [] and we
    // fall back to the legacy ✂️ Split flow unchanged (see above).
    var groupRows = buildGroupParentButtonRows(getTenantChatId(), messageId);
    for (var gi = 0; gi < groupRows.length; gi++) {
      rows.unshift(groupRows[groupRows.length - 1 - gi]);
    }
    options.reply_markup = buildReplyMarkup(rows);
  }

  sendTelegramMessage(getTenantChatId(), message, options);
}
