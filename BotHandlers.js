// Look up the sheet row for a callback's email message id. If not found, send
// a chat message explaining and return -1 so the caller can early-out. The
// callback ack itself is handled by handleCallbackQuery up-front.
function requireRowForCallback(chatId, emailMessageId) {
  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    sendTelegramMessage(chatId, "❌ *Transaction not found in your sheet.*");
    return -1;
  }
  return rowNumber;
}

// Method to handle messages sent to the Telegram bot.
function handleMessage(update) {
  if (update.message) {
    var chatId = update.message.chat.id;
    var messageText = update.message.text;
    var username = update.message.from.first_name || update.message.from.username;

    if (!messageText) return; // Ignore non-text messages (photos, joins, etc.)

    // Handle commands
    if (messageText.startsWith("/")) {
      var command = messageText.split(" ")[0].split("@")[0].toLowerCase();

      // Onboarding commands always allowed (they're how tenants are created).
      var ONBOARDING = ["/start", "/register", "/account"];
      if (ONBOARDING.indexOf(command) === -1) {
        if (!gateTenantForCommand(chatId)) return;
      }

      switch (command) {
        case "/start":
          handleStartCommand(chatId, username);
          break;
        case "/register":
          handleRegisterCommand(chatId, username, messageText);
          break;
        case "/account":
          handleAccountCommand(chatId);
          break;
        case "/help":
          handleHelpCommand(chatId, username);
          break;
        case "/recent":
          showRecentTransactions(chatId, messageText);
          break;
        case "/stats":
          handleStatsCommand(chatId);
          break;
        case "/ask":
          handleAskCommand(chatId, messageText);
          break;
        case "/backfill":
          handleBackfillCommand(chatId, messageText);
          break;
        default:
          sendTelegramMessage(chatId, "❌ *Unknown command!*\n\nUse /help to see available commands.");
      }
    }
    // Handle menu button clicks
    else if (messageText === " Recent Transactions") {
      showRecentTransactions(chatId, "/recent");
    } else {
      // Pending-input flows (bare /ask or bare /register stashed a flag and
      // is now waiting for the user's next plain message). Check these first
      // — they're the highest-intent interactions, and merchant edits are
      // keyed by message id so they can't collide.
      if (handleAskQuestionReply(chatId, messageText)) return;
      if (handleRegisterEmailReply(chatId, username, messageText)) return;

      // Check for pending merchant input
      var userId = update.message.from.id;
      var props = PropertiesService.getScriptProperties();
      var pendingEditMsgId = props.getProperty("pending_editmerch_" + userId);
      if (pendingEditMsgId) {
        // User is editing the merchant name as part of the new-merchant flow.
        // Capture the typed name, then prompt them to pick a category for the mapping.
        props.deleteProperty("pending_editmerch_" + userId);
        var newName = messageText.trim();
        if (!newName) {
          sendTelegramMessage(chatId, "❌ Empty name, edit cancelled");
          return;
        }
        var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, pendingEditMsgId);
        if (rowNumber < 0) {
          sendTelegramMessage(chatId, "❌ Transaction not found");
          return;
        }
        // Stash the new name keyed by the email message id so whoever picks the category completes the mapping.
        props.setProperty("editmerch_newname_" + pendingEditMsgId, newName);

        var sheet = getSpreadsheet().getSheets()[0];
        var txnType = sheet.getRange(rowNumber, TRANSACTION_TYPE_COLUMN).getValue();
        sendTelegramMessage(chatId, "📂 *Pick a category for " + escapeMarkdown(newName) + ":*", {
          parse_mode: "Markdown",
          reply_markup: buildCategoryKeyboard(pendingEditMsgId, getCategoryListForType(txnType), "mapcat")
        });
        return;
      }

      var pendingEmailId = props.getProperty("pending_merchant_" + userId);
      if (pendingEmailId) {
        // Clear pending state
        props.deleteProperty("pending_merchant_" + userId);
        var merchantName = messageText.trim();
        var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, pendingEmailId);
        if (rowNumber < 0) {
          sendTelegramMessage(chatId, "❌ Transaction not found");
          return;
        }
        updateGoogleSheetCellWithFeedback(rowNumber, MERCHANT_COLUMN, merchantName, "");
        // Add to MerchantResolution and auto-populate category if available
        addNewMerchantIfNeeded(merchantName);
        var resolutions = getMerchantResolutions();
        var resolved = lookupMerchantCategory(merchantName, resolutions);
        var confirmMsg = "✅ *Merchant set to " + escapeMarkdown(merchantName) + "*";
        if (resolved && resolved.category) {
          updateGoogleSheetCellWithFeedback(rowNumber, CATEGORY_COLUMN, resolved.category, "");
          confirmMsg += " \\(" + escapeMarkdown(resolved.category) + "\\)";
        }
        sendTelegramMessage(chatId, confirmMsg, {
          parse_mode: "Markdown"
        });
      }
    }
  }
}

// Method to handle the /help command (also handles /start)
function handleHelpCommand(chatId, username) {
  var message =
    `*Commands*\n` +
    `• /ask — ask anything about your spending\n` +
    `   _e.g. /ask how much on food last month?_\n` +
    `• /stats — dashboard: recent, trends, who owes\n` +
    `• /register — add another Gmail to forward from\n` +
    `• /account — status, sheet link, resend setup\n` +
    `• /help — this message`;

  var url = sheetUrl(getTenantSheetId());
  sendTelegramMessage(chatId, message, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📋 Open Sheet", url: url },
          { text: "📖 README", url: "https://github.com/Rrishik/dus-aane-bot#readme" }
        ]
      ]
    }
  });
}

// Backfill duration unit alias map (module-scope so it isn't rebuilt per call,
// and so tests can inspect it).
var BACKFILL_UNIT_MAP = {
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  h: "hour",
  hour: "hour",
  hours: "hour",
  d: "day",
  day: "day",
  days: "day",
  w: "week",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month"
};

var BACKFILL_USAGE_MSG =
  "❌ *Invalid format!*\n\n" +
  "Use: `/backfill 10m` or `/backfill 3 days` or `/backfill 2 weeks`\n" +
  "Or: `/backfill YYYY-MM-DD YYYY-MM-DD`";

// Pure parser for /backfill arguments. Pulled out for unit-testability.
//   Input:  messageText (the full command), optional `now` Date for tests.
//   Output: { ok:true, startDate, endDate } | { ok:false, error: 'usage' | 'unknown_unit' | 'invalid_dates' | 'invalid_range' }
//
// Supported forms:
//   /backfill 10m | 2h | 3d | 1w           (compact)
//   /backfill 10 min | 3 days | 2 weeks    (spaced)
//   /backfill YYYY-MM-DD YYYY-MM-DD        (absolute range)
function parseBackfillDuration(messageText, now) {
  var parts = (messageText || "").split(" ");
  if (parts.length < 2) return { ok: false, error: "usage" };

  var amount, unit;
  var compactMatch =
    parts[1] && parts[1].match(/^(\d+)(m|h|d|w|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months)$/i);
  if (compactMatch) {
    amount = parseInt(compactMatch[1], 10);
    unit = compactMatch[2].toLowerCase();
  } else {
    amount = parseInt(parts[1], 10);
    if (!isNaN(amount) && parts.length >= 3 && parts[1].indexOf("-") < 0) {
      unit = parts[2].toLowerCase();
    }
  }

  var startDate, endDate;
  if (unit) {
    var normalized = BACKFILL_UNIT_MAP[unit];
    if (!normalized) return { ok: false, error: "unknown_unit" };
    var nowMs = now ? now.getTime() : Date.now();
    endDate = new Date(nowMs);
    startDate = new Date(nowMs);
    if (normalized === "minute") startDate.setMinutes(startDate.getMinutes() - amount);
    else if (normalized === "hour") startDate.setHours(startDate.getHours() - amount);
    else if (normalized === "day") startDate.setDate(startDate.getDate() - amount);
    else if (normalized === "week") startDate.setDate(startDate.getDate() - amount * 7);
    else if (normalized === "month") startDate.setMonth(startDate.getMonth() - amount);
  } else if (parts.length >= 3) {
    startDate = new Date(parts[1]);
    endDate = new Date(parts[2]);
  } else {
    return { ok: false, error: "usage" };
  }

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { ok: false, error: "invalid_dates" };
  }
  if (startDate > endDate) return { ok: false, error: "invalid_range" };
  return { ok: true, startDate: startDate, endDate: endDate };
}

// Method to handle the /backfill command
function handleBackfillCommand(chatId, messageText) {
  var parsed = parseBackfillDuration(messageText);
  if (!parsed.ok) {
    if (parsed.error === "unknown_unit") {
      sendTelegramMessage(chatId, "❌ *Unknown unit!* Use `min`, `hour`, `day`, `week`, or `month`.");
    } else if (parsed.error === "invalid_dates") {
      sendTelegramMessage(
        chatId,
        "❌ *Invalid dates!* Use format YYYY-MM-DD\n\nExample: `/backfill 2026-03-01 2026-03-31`"
      );
    } else if (parsed.error === "invalid_range") {
      sendTelegramMessage(chatId, "❌ *Start date must be before end date.*");
    } else {
      sendTelegramMessage(chatId, BACKFILL_USAGE_MSG);
    }
    return;
  }
  startChunkedBackfill(parsed.startDate, parsed.endDate);
}

// Method to handle the callback queries sent from the Telegram message reply buttons.
function handleCallbackQuery(update) {
  try {
    if (!update.callback_query) {
      return;
    }

    var callbackQueryId = update.callback_query.id;
    var chatId = update.callback_query.message.chat.id;
    var telegramMessageId = update.callback_query.message.message_id;
    var messageText = update.callback_query.message.text;
    var data = update.callback_query.data; // Example: "split_abc123", "partner_abc123", "personal_abc123"

    if (!data) {
      sendTelegramMessage(chatId, "❌ *Error: No data received*");
      return;
    }

    // Parse action and message ID from callback data
    var separatorIndex = data.indexOf("_");
    if (separatorIndex < 0) {
      sendTelegramMessage(chatId, "❌ *Error: Invalid request*");
      return;
    }

    var action = data.substring(0, separatorIndex); // "personal", "split", "partner", "editcat", "cat", "del", "setmerch", "stats", etc.
    var callbackPayload = data.substring(separatorIndex + 1);

    // Ack the callback up front so Telegram clears the button spinner
    // immediately (~150-300ms) instead of waiting on sheet I/O. All later
    // per-branch toasts/errors must go through sendTelegramMessage —
    // Telegram only honors one answerCallbackQuery per callback_query_id.
    answerCallbackQuery(callbackQueryId, "");

    // "Upgrade to Premium" upsell — shown after a user hits the /ask cap.
    // Premium isn't built yet; we just acknowledge intent and measure who
    // taps it (via Telegram update logs). The 5/day cap is the same for
    // everyone for now; this branch will graduate into a real upgrade flow
    // once we set pricing.
    if (data === "premium_info") {
      sendTelegramMessage(chatId, "\u{1F48E} *Premium coming soon* \u2014 we'll let you know when it's ready.");
      return;
    }

    // Handle stats callbacks: stats_recent, stats_trends, stats_whoowes
    if (action === "stats") {
      return handleStatsCallback(chatId, telegramMessageId, callbackQueryId, callbackPayload);
    }

    // Handle month navigation: monthprev / monthnext
    if (action === "monthprev" || action === "monthnext") {
      return handleMonthNavigation(chatId, telegramMessageId, callbackQueryId, action, callbackPayload);
    }

    // Handle "Edit Category" — show category picker
    if (action === "editcat") {
      var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, callbackPayload);
      var catList = CATEGORIES;
      if (rowNumber > 0) {
        var sheet = getSpreadsheet().getSheets()[0];
        catList = getCategoryListForType(sheet.getRange(rowNumber, TRANSACTION_TYPE_COLUMN).getValue());
      }
      sendTelegramMessage(chatId, "📂 *Select a category:*", {
        parse_mode: "Markdown",
        reply_markup: buildCategoryKeyboard(callbackPayload, catList)
      });
      return;
    }

    // Handle category selection: cat_{messageId}_{index}
    if (action === "cat") {
      var lastUnderscore = callbackPayload.lastIndexOf("_");
      if (lastUnderscore < 0) {
        sendTelegramMessage(chatId, "❌ *Invalid category data*");
        return;
      }
      var emailMessageId = callbackPayload.substring(0, lastUnderscore);
      var categoryIndex = parseInt(callbackPayload.substring(lastUnderscore + 1), 10);

      // Look up transaction type to determine which category list to use
      var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
      if (rowNumber < 0) return;

      var sheet = getSpreadsheet().getSheets()[0];
      var rowData = sheet.getRange(rowNumber, 1, 1, 10).getValues()[0];
      var catList = getCategoryListForType(rowData[TRANSACTION_TYPE_COLUMN - 1]);

      if (isNaN(categoryIndex) || categoryIndex < 0 || categoryIndex >= catList.length) {
        sendTelegramMessage(chatId, "❌ *Invalid category*");
        return;
      }

      var newCategory = catList[categoryIndex];
      var currentCategory = rowData[CATEGORY_COLUMN - 1];
      var updateResult = updateGoogleSheetCellWithFeedback(rowNumber, CATEGORY_COLUMN, newCategory, currentCategory);

      if (!updateResult.success) {
        sendTelegramMessage(chatId, "❌ " + updateResult.message);
        return;
      }

      // Edit the picker message to show confirmation
      sendTelegramMessage(chatId, "✅ *Category updated to " + newCategory + "*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId
      });
      return;
    }

    // Handle "Set Merchant" — ask user to type merchant name
    if (action === "setmerch") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;
      // Store pending state per user per user
      var userId = update.callback_query.from.id;
      var props = PropertiesService.getScriptProperties();
      props.setProperty("pending_merchant_" + userId, emailMessageId);
      sendTelegramMessage(chatId, "🏪 *Type the merchant name for this transaction:*", {
        parse_mode: "Markdown"
      });
      return;
    }

    // Handle delete transaction: del_{messageId}
    if (action === "del") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;

      deleteSheetRow(rowNumber);

      sendTelegramMessage(chatId, "🗑️ *Transaction deleted*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId
      });
      return;
    }

    // Handle "Save Mapping" — confirm the LLM-suggested merchant + category mapping
    if (action === "savemerch") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;
      var sheet = getSpreadsheet().getSheets()[0];
      var rowData = sheet.getRange(rowNumber, 1, 1, 10).getValues()[0];
      var merchant = (rowData[MERCHANT_COLUMN - 1] || "").toString().trim();
      var category = (rowData[CATEGORY_COLUMN - 1] || "").toString().trim();
      if (!merchant) {
        sendTelegramMessage(chatId, "❌ *No merchant on this row to save.*");
        return;
      }
      var result = setMerchantResolution(merchant, merchant);
      if (!result.success) {
        sendTelegramMessage(chatId, "❌ " + result.message);
        return;
      }
      if (category) setCategoryOverride(merchant, category);

      // Rebuild keyboard without the Save Mapping row
      var newRows = [
        [
          { text: "✂️ Split", callback_data: "split_" + emailMessageId },
          { text: "✏️ Category", callback_data: "editcat_" + emailMessageId },
          { text: "🗑️ Delete", callback_data: "del_" + emailMessageId }
        ]
      ];
      sendTelegramMessage(chatId, messageText, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: buildReplyMarkup(newRows)
      });
      return;
    }

    // Handle "Edit Merchant" — prompt for a new merchant name; category picker follows after reply
    if (action === "editmerchname") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;
      var userIdEdit = update.callback_query.from.id;
      var propsEdit = PropertiesService.getScriptProperties();
      propsEdit.setProperty("pending_editmerch_" + userIdEdit, emailMessageId);
      sendTelegramMessage(chatId, "🏪 *Type the new merchant name (category picker follows):*", {
        parse_mode: "Markdown",
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: "e.g. Flipkart" }
      });
      return;
    }

    // Handle category pick for the new-merchant mapping flow: mapcat_<msgId>_<index>
    // Reads pending new merchant name (if user came via Edit Merchant); else keeps current merchant.
    // Updates both the main-sheet row (merchant + category) and the MerchantResolution row.
    if (action === "mapcat") {
      var lastUnderscore = callbackPayload.lastIndexOf("_");
      if (lastUnderscore < 0) {
        sendTelegramMessage(chatId, "❌ *Invalid data*");
        return;
      }
      var emailMessageId = callbackPayload.substring(0, lastUnderscore);
      var categoryIndex = parseInt(callbackPayload.substring(lastUnderscore + 1), 10);
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;
      var sheet = getSpreadsheet().getSheets()[0];
      var rowData = sheet.getRange(rowNumber, 1, 1, 10).getValues()[0];
      var rawMerchant = (rowData[MERCHANT_COLUMN - 1] || "").toString().trim(); // current value in col C; for new-merchant flow this == the original raw pattern
      var catList = getCategoryListForType(rowData[TRANSACTION_TYPE_COLUMN - 1]);
      if (isNaN(categoryIndex) || categoryIndex < 0 || categoryIndex >= catList.length) {
        sendTelegramMessage(chatId, "❌ *Invalid category*");
        return;
      }
      var newCategory = catList[categoryIndex];

      // Pick up the typed name from the Edit-Merchant flow (if any); else keep existing.
      var propsMap = PropertiesService.getScriptProperties();
      var pendingNewName = propsMap.getProperty("editmerch_newname_" + emailMessageId);
      var resolvedName = pendingNewName ? pendingNewName : rawMerchant;
      if (pendingNewName) propsMap.deleteProperty("editmerch_newname_" + emailMessageId);

      if (!rawMerchant) {
        sendTelegramMessage(chatId, "❌ *No merchant on this row*");
        return;
      }

      // Save mapping in MerchantResolution (raw pattern → resolved name)
      var mapResult = setMerchantResolution(rawMerchant, resolvedName);
      if (!mapResult.success) {
        sendTelegramMessage(chatId, "❌ " + mapResult.message);
        return;
      }
      // Save merchant → category in CategoryOverrides
      setCategoryOverride(resolvedName, newCategory);

      // Update this transaction's row to reflect the resolved name + chosen category
      if (resolvedName !== rawMerchant) {
        updateGoogleSheetCellWithFeedback(rowNumber, MERCHANT_COLUMN, resolvedName, rawMerchant);
      }
      updateGoogleSheetCellWithFeedback(rowNumber, CATEGORY_COLUMN, newCategory, rowData[CATEGORY_COLUMN - 1]);

      sendTelegramMessage(
        chatId,
        "✅ *Mapping saved:* " + escapeMarkdown(resolvedName) + " → " + escapeMarkdown(newCategory),
        { parse_mode: "Markdown" }
      );
      return;
    }

    var emailMessageId = callbackPayload; // Gmail message ID

    // Only handle split-toggle actions here; other actions handled above
    if (action !== "personal" && action !== "split" && action !== "partner") {
      sendTelegramMessage(chatId, "❌ *Unknown action*");
      return;
    }

    // Look up the row by message ID
    var rowNumber = requireRowForCallback(chatId, emailMessageId);
    if (rowNumber < 0) return;

    var valueToSet;
    if (action === "personal") valueToSet = SPLIT_STATUS.PERSONAL;
    else if (action === "split") valueToSet = SPLIT_STATUS.SPLIT;
    else valueToSet = SPLIT_STATUS.PARTNER;

    // Read current value
    var sheet = getSpreadsheet().getSheets()[0];
    var currentValue = sheet.getRange(rowNumber, SPLIT_COLUMN).getValue();

    // Update the cell
    var updateResult = updateGoogleSheetCellWithFeedback(rowNumber, SPLIT_COLUMN, valueToSet, currentValue);

    if (!updateResult.success) {
      sendTelegramMessage(chatId, "❌ *Error updating transaction*\n\n" + updateResult.message);
      return;
    }

    // Build cycle button: personal → split → partner → personal
    var nextActionMap = { personal: "split", split: "partner", partner: "personal" };
    var nextLabelMap = { personal: "🔄 Personal", split: "✂️ Split", partner: "👤 Partner" };
    var toggleAction = nextActionMap[action];
    var toggleText = nextLabelMap[toggleAction];

    var options = {
      parse_mode: "Markdown",
      reply_markup: buildReplyMarkup([
        [
          { text: toggleText, callback_data: toggleAction + "_" + emailMessageId },
          { text: "✏️ Category", callback_data: "editcat_" + emailMessageId },
          { text: "🗑️ Delete", callback_data: "del_" + emailMessageId }
        ]
      ]),
      message_id: telegramMessageId
    };

    var message = `✅ *Marked as ${valueToSet}*\n\n${messageText}`;
    sendTelegramMessage(chatId, message, options);
  } catch (error) {
    console.error("[handleCallbackQuery] Error:", error.message, error.stack);
    if (update.callback_query && update.callback_query.message && update.callback_query.message.chat) {
      sendTelegramMessage(update.callback_query.message.chat.id, "❌ *Error:* " + escapeMarkdown(error.message));
    }
  }
}

// Function to show transaction summary. Optional limit param: /summary 10
// Function to show recent transactions
// Supports: /recent, /recent 10, /recent rishik, /recent 10 rishik
function showRecentTransactions(chatId, messageText) {
  try {
    var parts = messageText.trim().split(/\s+/);
    parts.shift(); // remove "/recent"

    var limit = 5;
    var userFilter = null;

    // Parse params: number = limit, string = user filter
    parts.forEach(function (part) {
      if (/^\d+$/.test(part)) {
        limit = parseInt(part, 10);
      } else {
        userFilter = part.toLowerCase();
      }
    });

    var result = buildRecentTransactionsMessage(limit, userFilter);
    sendTelegramMessage(chatId, result.text);
  } catch (error) {
    console.error("Error in showRecentTransactions:", error);
    sendTelegramMessage(chatId, "❌ *Error fetching recent transactions*\n\nPlease try again later.");
  }
}

// Build the markdown body for a "recent N transactions" view. Pure-ish — reads
// the tenant sheet but returns text only, no Telegram I/O. Used both by the
// typed `/recent` command (above) and the 🕒 Recent button in /stats.
function buildRecentTransactionsMessage(limit, userFilter) {
  // Cap limit to keep the webhook response snappy.
  if (limit > 50) limit = 50;
  if (limit < 1) limit = 1;

  var sheet = getSpreadsheet().getSheets()[0];
  var data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { text: "📅 *No transactions found yet!*" };
  }

  // Skip header row
  data.shift();

  if (userFilter) {
    data = data.filter(function (row) {
      var user = (row[USER_COLUMN - 1] || "").toString().toLowerCase();
      return user.indexOf(userFilter) !== -1;
    });
  }

  if (data.length === 0) {
    return { text: "📅 *No transactions found* for user: " + userFilter };
  }

  var recentTransactions = data.slice(-limit).reverse();

  var header = "📅 *Recent Transactions*";
  if (userFilter) header += " (user: " + userFilter + ")";
  var message = header + "\n";

  recentTransactions.forEach(function (row) {
    var rawDate = row[EMAIL_DATE_COLUMN - 1] || row[TRANSACTION_DATE_COLUMN - 1];
    var date =
      rawDate instanceof Date
        ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd MMM yyyy, HH:mm")
        : rawDate || "Unknown Date";
    var merchant = row[MERCHANT_COLUMN - 1] || "Unknown";
    var amount = parseFloat(row[AMOUNT_COLUMN - 1]) || 0;
    var type = row[TRANSACTION_TYPE_COLUMN - 1] || "Unknown";
    var category = row[CATEGORY_COLUMN - 1] || "";
    var currency = row[CURRENCY_COLUMN - 1] || "INR";

    var emoji = type === "Debit" ? "💸" : "💰";
    var money = currencySymbol(currency) + formatAmount(amount);
    var catLabel = category ? " · " + shortCategoryName(category) : "";

    // Two lines per entry, blank line between. No ─── dividers — line
    // spacing alone is enough separation, and dividers were dominating the
    // visual weight of every row.
    message += "\n" + emoji + " *" + escapeMarkdown(merchant) + "* " + money + catLabel + "\n";
    message += "   _" + escapeMarkdown(date) + "_\n";
  });

  return { text: message };
}

// ─── Stats Command ───────────────────────────────────────────────────

function handleStatsCommand(chatId) {
  sendTelegramMessage(chatId, "📊 *Stats* — pick a view:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buildStatsMenuKeyboard() }
  });
}

// Pure-data builder — used both by /stats entry and the back button.
// One row of three keeps each button label readable on narrow phone screens.
// Monthly was dropped: Trends already shows each month's INR debit total as
// a bar chart and gives MoM deltas + biggest category movers, which covered
// the same intent more compactly. Top-5-txns-by-amount and per-user breakdown
// (Monthly's other features) are recoverable via /ask for the rare reader
// who wants them.
function buildStatsMenuKeyboard() {
  return [
    [
      { text: "🕒 Recent", callback_data: "stats_recent" },
      { text: "📉 Trends", callback_data: "stats_trends" },
      { text: "💰 Who Owes", callback_data: "stats_whoowes" }
    ]
  ];
}

// ─── Ask Command (AI tool-calling) ───────────────────────────────────

function handleAskCommand(chatId, messageText) {
  try {
    var question = messageText.replace(/^\/ask(@\w+)?\s*/i, "").trim();

    // Tapped /ask from the slash menu (or sent /ask with no question): stash
    // a pending flag and prompt for the question. The next plain-text message
    // from this chat is consumed by handleAskQuestionReply. Mirrors the
    // /register-without-address flow. Plain text (no parse_mode) — keeps the
    // prompt bullet-proof against future markdown-special chars in the copy.
    if (!question) {
      PropertiesService.getScriptProperties().setProperty("pending_ask_" + chatId, "1");
      sendTelegramMessage(
        chatId,
        "❓ What would you like to know about your spending?\n\n" +
          "Examples:\n" +
          "• How much did we spend on food?\n" +
          "• Top merchants this month\n" +
          "• Who owes whom in March?\n" +
          "• Compare grocery spending Feb vs Mar\n\n" +
          "Reply with your question, or send /ask <question> directly.",
        {
          reply_markup: { force_reply: true, input_field_placeholder: "Ask about your spending…" }
        }
      );
      return;
    }

    // Direct /ask <question>: clear any stale pending-ask flag so a follow-up
    // plain message isn't accidentally consumed as another question.
    PropertiesService.getScriptProperties().deleteProperty("pending_ask_" + chatId);
    runAskFlow(chatId, question);
  } catch (e) {
    console.error("handleAskCommand failed:", e && e.message, e && e.stack);
    try {
      sendTelegramMessage(chatId, "❌ Something went wrong handling /ask. Please try again.");
    } catch (_) {}
  }
}

// Consume a plain-text reply when the user is mid-/ask flow. Returns true
// if the message was consumed (and therefore handleMessage should stop).
function handleAskQuestionReply(chatId, messageText) {
  var props = PropertiesService.getScriptProperties();
  var key = "pending_ask_" + chatId;
  if (!props.getProperty(key)) return false;
  props.deleteProperty(key);
  var question = (messageText || "").trim();
  if (!question) {
    sendTelegramMessage(chatId, "❌ Empty question, /ask cancelled.");
    return true;
  }
  runAskFlow(chatId, question);
  return true;
}

// Shared core: quota → typing indicator → LLM loop → send answer. Used by
// both the direct /ask <question> path and the pending-input reply path.
// Any uncaught throw inside the LLM loop, sheet read, or quota update is
// surfaced to the user as a chat message — silent failure here means the
// user sees nothing and assumes /ask is broken.
function runAskFlow(chatId, question) {
  var quotaConsumed = false;
  try {
    // Daily /ask cap. consumeAskQuota is atomic (LockService) and tracks both
    // the daily counter and lifetime/cap-hit metrics on the Tenants row. We
    // consume *before* spending Azure tokens; if runAskLoop later throws we
    // refund so a failed call doesn't burn a slot.
    var quota = consumeAskQuota(chatId);
    if (!quota.allowed) {
      sendTelegramMessage(chatId, formatAskCapHitMessage(new Date()), {
        reply_markup: buildAskCapHitKeyboard()
      });
      return;
    }
    quotaConsumed = true;

    // Show "typing..." in the chat header instead of a "🤔 Thinking..." message.
    // Telegram clears the indicator automatically when the bot's next message
    // arrives, so there's nothing to delete or edit on success. The indicator
    // expires after ~5s, so runAskLoop re-emits it before each LLM iteration
    // via the onProgress callback (most /ask runs take 5-15s).
    sendChatAction(chatId, "typing");

    var answer = runAskLoop(question, function () {
      sendChatAction(chatId, "typing");
    });
    sendTelegramMessage(chatId, escapeMarkdown(answer));
  } catch (error) {
    if (quotaConsumed) {
      try {
        refundAskQuota(chatId);
      } catch (_) {}
    }
    console.error("runAskFlow failed:", error && error.message, error && error.stack);
    try {
      sendTelegramMessage(chatId, "❌ Something went wrong. Try /stats for preset analytics.");
    } catch (_) {}
  }
}

function handleStatsCallback(chatId, telegramMessageId, callbackQueryId, subAction) {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();

  try {
    // Back button — restore the dashboard menu in place.
    if (subAction === "back") {
      sendTelegramMessage(chatId, "📊 *Stats* — pick a view:", {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: buildStatsMenuKeyboard() }
      });
      return;
    }

    if (subAction === "recent") {
      // 🕒 Recent inside /stats — same content as the typed /recent command,
      // rendered in place with a Back button. The typed-command path is
      // unchanged for power users who want filters (e.g. /recent 10 rishik).
      var recent = buildRecentTransactionsMessage(5, null);
      sendTelegramMessage(chatId, recent.text, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: [buildStatsBackRow()] }
      });
      return;
    }

    if (subAction === "trends") {
      var months = getTrendsAnalytics(6);
      var msg = formatTrendsMessage(months);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: [buildStatsBackRow()] }
      });
    } else if (subAction === "whoowes") {
      var data = getWhoOwesAnalytics(year, month);
      if (!data) {
        sendTelegramMessage(chatId, "💰 *No split transactions this month.*", {
          parse_mode: "Markdown",
          message_id: telegramMessageId,
          reply_markup: { inline_keyboard: [buildMonthNavButtons(year, month, "whoowes"), buildStatsBackRow()] }
        });
        return;
      }
      var msg = formatWhoOwesMessage(year, month, data);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: [buildMonthNavButtons(year, month, "whoowes"), buildStatsBackRow()] }
      });
    }
  } catch (error) {
    console.error("Error in handleStatsCallback:", error.message, error.stack);
    sendTelegramMessage(chatId, "❌ *Error:* " + escapeMarkdown(error.message));
  }
}

function buildStatsBackRow() {
  return [{ text: "🔙 Back", callback_data: "stats_back" }];
}

function handleMonthNavigation(chatId, telegramMessageId, callbackQueryId, action, payload) {
  try {
    // payload: "YYYY_M_whoowes". Month-nav now exists only inside Who Owes —
    // Monthly was retired (Trends covers the same intent across 6 months).
    // We still parse a `mode` for forward-compat, but only "whoowes" is
    // currently produced by buildMonthNavButtons.
    var parts = payload.split("_");
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);

    if (action === "monthprev") {
      month--;
      if (month < 0) {
        month = 11;
        year--;
      }
    } else {
      month++;
      if (month > 11) {
        month = 0;
        year++;
      }
    }

    var data = getWhoOwesAnalytics(year, month);
    if (!data) {
      var tz = Session.getScriptTimeZone();
      var label = Utilities.formatDate(new Date(year, month, 1), tz, "MMMM yyyy");
      sendTelegramMessage(chatId, "💰 *No split transactions in " + label + "*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: [buildMonthNavButtons(year, month, "whoowes"), buildStatsBackRow()] }
      });
      return;
    }
    var msg = formatWhoOwesMessage(year, month, data);
    sendTelegramMessage(chatId, msg, {
      parse_mode: "Markdown",
      message_id: telegramMessageId,
      reply_markup: { inline_keyboard: [buildMonthNavButtons(year, month, "whoowes"), buildStatsBackRow()] }
    });
  } catch (error) {
    console.error("Error in handleMonthNavigation:", error.message, error.stack);
    sendTelegramMessage(chatId, "❌ *Error:* " + escapeMarkdown(error.message));
  }
}

// Builds the [◀️ Prev] [▶️ Next] row. Hides Next when at the current month
// (no future data exists). `mode` adds a trailing _whoowes suffix when set.
function buildMonthNavButtons(year, month, mode) {
  var suffix = mode ? "_" + mode : "";
  var now = new Date();
  var atCurrent = year === now.getFullYear() && month === now.getMonth();
  var row = [{ text: "◀️ Prev", callback_data: "monthprev_" + year + "_" + month + suffix }];
  if (!atCurrent) {
    row.push({ text: "▶️ Next", callback_data: "monthnext_" + year + "_" + month + suffix });
  }
  return row;
}
