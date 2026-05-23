function deleteWebhook() {
  sendRequest(BOT_DELETE_WEBHOOK_URL, "post", {});
}

// Webhook setup — points Telegram at the Cloudflare Worker proxy that
// forwards to Apps Script. Run once.
function setTelegramWebhook() {
  deleteWebhook();
  var payload = {
    url: WORKER_PROXY_URL,
    // chat_member / my_chat_member aren't in the default set — we need them
    // to detect group adds + member joins/leaves. chat_member only fires
    // reliably when the bot is a group admin (enforced at /start).
    allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"]
  };

  sendRequest(BOT_SET_WEBHOOK_URL, "post", payload);
}

function setTelegramCommands() {
  // Only list zero-arg commands. Tapping a slash-menu item sends the command
  // immediately with no chance to add arguments, so listing /register, /ask,
  // etc. here just produces usage errors. Scoped per-chat-type.
  var personalCommands = [
    { command: "/start", description: "Onboard / show welcome" },
    { command: "/register", description: "Register a Gmail address to forward from" },
    { command: "/ask", description: "Ask anything about your spending" },
    { command: "/stats", description: "Dashboard: recent, trends, who owes" },
    { command: "/account", description: "Account & settings" },
    { command: "/help", description: "Show available commands" }
  ];
  sendRequest(BOT_SET_COMMANDS_URL, "post", {
    commands: personalCommands,
    scope: { type: "all_private_chats" }
  });

  var groupCommands = [
    { command: "/start", description: "Set up this group / re-sync members" },
    { command: "/account", description: "Group status, members, sheet link" },
    { command: "/stats", description: "Who owes whom (per currency)" },
    { command: "/help", description: "Group commands" }
  ];
  sendRequest(BOT_SET_COMMANDS_URL, "post", {
    commands: groupCommands,
    scope: { type: "all_group_chats" }
  });
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

// Keyboard-only edit. Use when we want to swap the inline buttons without
// touching the message body (e.g. show a category picker / help menu /
// confirm step in place of the default action row). The body would
// require a re-render if we used sendTelegramMessage(message_id).
function editTelegramReplyMarkup(chat_id, message_id, reply_markup) {
  var payload = {
    chat_id: chat_id,
    message_id: message_id,
    reply_markup: reply_markup ? JSON.stringify(reply_markup) : undefined
  };
  sendRequest(BOT_EDIT_REPLY_MARKUP_URL, "post", payload);
}

// Fire-and-forget chat-header indicator ("typing", etc.). Auto-clears after
// ~5s or on the bot's next message. Used by /ask while the LLM loop runs.
// Errors are swallowed — cosmetic only.
function sendChatAction(chat_id, action) {
  try {
    sendRequest(BOT_SEND_CHAT_ACTION_URL, "post", {
      chat_id: chat_id,
      action: action || "typing"
    });
  } catch (e) {
    console.warn("sendChatAction failed (ignored): " + e);
  }
}

// ─── Group-lifecycle read helpers ───────────────────────────────────────────
// Thin wrappers — return parsed `result` on success, null on any error.
// Callers must tolerate null (network failures, bot kicked, privacy mode, etc.).

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

// Chat owner + admins. Works without the bot being an admin. Used at /start
// to seed the initial member list — non-admin regulars aren't enumerable.
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

// One user's profile within a chat. Returns { name, username } — name falls
// back to username then "", username strips the @. Never throws. Per-execution
// memo (Apps Script clears globals between runs).
var _CHAT_MEMBER_INFO_CACHE = {};
function getTelegramChatMemberInfo(chat_id, user_chat_id) {
  var key = String(chat_id) + ":" + String(user_chat_id);
  if (Object.prototype.hasOwnProperty.call(_CHAT_MEMBER_INFO_CACHE, key)) {
    return _CHAT_MEMBER_INFO_CACHE[key];
  }
  var info = { name: "", username: "" };
  try {
    var resp = sendRequest(BOT_GET_CHAT_MEMBER_URL, "post", { chat_id: chat_id, user_id: user_chat_id });
    if (resp) {
      var body = JSON.parse(resp.getContentText());
      if (body && body.ok && body.result && body.result.user) {
        var u = body.result.user;
        info.username = u.username || "";
        info.name = u.first_name || u.username || "";
      }
    }
  } catch (e) {
    console.error("getTelegramChatMemberInfo error: " + e);
  }
  _CHAT_MEMBER_INFO_CACHE[key] = info;
  return info;
}

// Backwards-compat name-only accessor.
function getTelegramChatMemberName(chat_id, user_chat_id) {
  return getTelegramChatMemberInfo(chat_id, user_chat_id).name;
}

// The bot's own User object. Cached in ScriptProperties (BOT_TOKEN-stable).
// Used in every my_chat_member / chat_member event for self-detection.
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
  var MAX_RETRIES = 5;
  var INITIAL_RETRY_DELAY_MS = 1000;

  for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
    var options = {
      method: method,
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(url, options);
    var response_code = response.getResponseCode();
    var response_body = response.getContentText();

    if (response_code === 200) {
      return response;
    } else if (response_code === 429) {
      console.warn(
        "API rate limit hit (429) for URL: " + url + ". Attempt " + (attempt + 1) + " of " + MAX_RETRIES + "."
      );
      console.warn("Response body: " + response_body);

      var retry_after_seconds = 0;
      try {
        var error_data = JSON.parse(response_body);

        // Standard Telegram `parameters.retry_after`
        if (error_data && error_data.parameters && error_data.parameters.retry_after) {
          retry_after_seconds = parseInt(error_data.parameters.retry_after, 10);
        }
        // "Please retry in Xs" in error.message
        else if (error_data && error_data.error && error_data.error.message) {
          var message = error_data.error.message;
          var match = message.match(/Please retry in\s+([\d\.]+)\s*s/);
          if (match && match[1]) {
            retry_after_seconds = Math.ceil(parseFloat(match[1]));
          }
        }
        // Google RPC RetryInfo in error.details (e.g. "52s")
        if (!retry_after_seconds && error_data && error_data.error && error_data.error.details) {
          error_data.error.details.forEach(function (detail) {
            if (detail["@type"] && detail["@type"].includes("RetryInfo") && detail.retryDelay) {
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

      // Specific suggestion: honor it + 1s buffer. Otherwise exponential backoff.
      if (retry_after_seconds > 0) {
        delay_ms += 1000;
      } else {
        delay_ms = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      }

      if (attempt < MAX_RETRIES - 1) {
        Utilities.sleep(delay_ms);
      } else {
        console.error("Max retries (" + MAX_RETRIES + ") reached for URL: " + url + ". Giving up.");
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
      // Telegram returns this specific 400 when an editMessageText call edits
      // a message to the same body + reply_markup it already has — happens on
      // double-taps of menu buttons (gnav/gset/gbk) and on webhook retries.
      // Treat it as a successful no-op so the user never sees a confusing
      // error for an intent that's already been fulfilled.
      if (response_code === 400) {
        try {
          var parsed_err = JSON.parse(response_body);
          if (parsed_err && parsed_err.description && /message is not modified/i.test(parsed_err.description)) {
            return response;
          }
        } catch (_) {}
      }
      console.error(
        "API request failed for URL: " + url + ". Response Code: " + response_code + ". Response Body: " + response_body
      );
      throw new Error("API request failed. Response Code: " + response_code + ", body: " + response_body);
    }
  }
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
  // Back row — picker is shown as an in-place keyboard swap on the txn card,
  // so the user needs an explicit way out without picking something.
  rows.push([{ text: "← Back", callback_data: "back_" + emailMessageId }]);
  return { inline_keyboard: rows };
}

// Help/overflow menu — shown when the ❓ button on a txn card is tapped.
// Hosts the low-frequency destructive actions (Delete, Report error) so the
// default action row stays focused on the common ops (Split / toggle / pills).
function buildHelpMenuKeyboard(emailMessageId) {
  return {
    inline_keyboard: [
      [
        { text: "⚠️ Report error", callback_data: "report_" + emailMessageId },
        { text: "🗑️ Delete", callback_data: "del_" + emailMessageId }
      ],
      [{ text: "← Back", callback_data: "back_" + emailMessageId }]
    ]
  };
}

// Two-step delete confirm. Tapped from the help menu; either commits the
// deletion (delyes_) or aborts back to the default keyboard (back_).
function buildDeleteConfirmKeyboard(emailMessageId) {
  return {
    inline_keyboard: [
      [
        { text: "✓ Yes, delete", callback_data: "delyes_" + emailMessageId },
        { text: "← Cancel", callback_data: "back_" + emailMessageId }
      ]
    ]
  };
}

// Escape Telegram **legacy** Markdown (parse_mode: "Markdown"). Only four
// chars are syntactically special: _ * [ `. Stray `]` is left as-is —
// Telegram tolerates it. Do NOT escape MarkdownV2's extras (( ) ~ > # + =
// | { } ! .) here — in legacy Markdown those are literal, and prefixing
// with backslash leaks the backslash into rendered output.
function escapeMarkdown(text) {
  if (typeof text !== "string") {
    return text;
  }
  return text.replace(/([_*\[`])/g, "\\$1");
}

// ─── Transaction notification card ─────────────────────────────────────────────
// 2-line body, 4 buttons in a fixed 2x2 grid. Tag + Category render as status
// pills with a ▾ glyph — current value lives on the affordance to change it,
// so the body stays minimal and there's no conditional rendering for "new
// merchant" / "empty merchant" cases (every card looks the same).
function getTransactionMessageAsString(transaction_details, user) {
  var rawDate = transaction_details.email_date || transaction_details.transaction_date;
  var date = escapeMarkdown(
    rawDate instanceof Date
      ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd MMM yyyy, HH:mm")
      : rawDate || "Unknown Date"
  );
  var merchant = transaction_details.merchant;
  var currency = transaction_details.currency || "INR";
  var rawAmount = Number(transaction_details.amount) || 0;
  var money = currencySymbol(currency) + formatAmount(rawAmount);

  var typeEmoji = isDebit(transaction_details.transaction_type) ? "🔴" : "🟢";
  var header = merchant
    ? typeEmoji + " *" + escapeMarkdown(merchant) + "* — " + money
    : typeEmoji + " *" + money + " " + transaction_details.transaction_type + "ed*";

  var lines = [header, "🗓 " + date];
  if (user) lines.push("👤 " + escapeMarkdown(user));
  return lines.join("\n");
}

// Tag input cap. Keep in lockstep with the BotHandlers validation —
// buttons never wrap on narrow phones if labels stay within this budget.
var TAG_MAX_LEN = 18;

// Trim long tag/category labels for button display. Inputs are already capped
// at TAG_MAX_LEN, but defensively guard pre-existing CategoryOverrides values
// and free-form category names like "Bills & Utilities" → "Bills".
function pillLabel(value, fallback) {
  var v = (value || "").toString().trim();
  if (!v) return fallback;
  if (v.length > TAG_MAX_LEN) return v.substring(0, TAG_MAX_LEN - 1) + "…";
  return v;
}

function sendTransactionMessage(transaction_details, messageId, user) {
  var message = getTransactionMessageAsString(transaction_details, user);

  var options = {
    parse_mode: "Markdown"
  };

  if (messageId) {
    var tagPill = "🏷 " + pillLabel(transaction_details.merchant, "Untagged") + " ▾";
    var catPill = "📂 " + pillLabel(shortCategoryName(transaction_details.category), "Uncategorized") + " ▾";

    // Pills row carries the ❓ overflow. Group-split parent buttons (one row
    // per group the user belongs to) stack above the pills so the per-group
    // action is the most prominent option. Users in zero groups see only
    // pills + overflow — no split UI applies until they join a group.
    var rows = [
      [
        { text: tagPill, callback_data: "tag_" + messageId },
        { text: catPill, callback_data: "editcat_" + messageId },
        { text: "❓", callback_data: "help_" + messageId }
      ]
    ];
    var groupRows = buildGroupParentButtonRows(getTenantChatId(), messageId);
    for (var gi = 0; gi < groupRows.length; gi++) {
      rows.unshift(groupRows[groupRows.length - 1 - gi]);
    }
    options.reply_markup = buildReplyMarkup(rows);
  }

  sendTelegramMessage(getTenantChatId(), message, options);
}
