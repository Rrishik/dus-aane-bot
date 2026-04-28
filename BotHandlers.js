// Look up the sheet row for a callback's email message id. If not found, answer
// the callback with the standard "not found" toast and return -1 so the caller
// can early-out. Centralizes the most-duplicated guard in the callback dispatch.
function requireRowForCallback(callbackQueryId, emailMessageId) {
  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    answerCallbackQuery(callbackQueryId, "❌ Transaction not found", false);
    return -1;
  }
  return rowNumber;
}

// Show the category picker for a transaction row. Uses the right list (debit vs
// credit) for the row's transaction type. `displayName` is shown in the prompt.
function promptCategoryPicker(chatId, rowNumber, emailMessageId, displayName) {
  var sheet = getSpreadsheet().getSheets()[0];
  var txnType = sheet.getRange(rowNumber, TRANSACTION_TYPE_COLUMN).getValue();
  sendTelegramMessage(chatId, "📂 *Pick a category for " + escapeMarkdown(displayName) + ":*", {
    parse_mode: "Markdown",
    reply_markup: buildCategoryKeyboard(emailMessageId, getCategoryListForType(txnType), "mapcat")
  });
}

// Single entry point for the typed-merchant-name reply, used by both the empty-
// merchant Set Merchant flow and the new-merchant Edit Merchant flow. Returns
// true if the message was consumed.
//
// If the typed name already has a category in the resolution table, auto-apply
// it (no picker). Otherwise stash the name keyed by emailMessageId and show the
// picker; the `mapcat` callback completes the mapping when the user picks.
function handleMerchantInput(chatId, userId, messageText) {
  var props = PropertiesService.getScriptProperties();
  var emailMessageId = props.getProperty("pending_merchant_input_" + userId);
  if (!emailMessageId) return false;
  props.deleteProperty("pending_merchant_input_" + userId);

  var typedName = (messageText || "").trim();
  if (!typedName) {
    sendTelegramMessage(chatId, "❌ Empty name, edit cancelled");
    return true;
  }
  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    sendTelegramMessage(chatId, "❌ Transaction not found");
    return true;
  }

  addNewMerchantIfNeeded(typedName);
  var resolutions = getMerchantResolutions();
  var resolved = lookupMerchantCategory(typedName, resolutions);

  // Auto-apply shortcut: typed name already maps to a category — skip the picker.
  if (resolved && resolved.category) {
    var rowData = getRowData(rowNumber);
    var rawMerchant = (rowData[MERCHANT_COLUMN - 1] || "").toString().trim();
    if (rawMerchant && rawMerchant.toLowerCase() !== typedName.toLowerCase()) {
      setMerchantResolution(rawMerchant, typedName);
    }
    setCategoryOverride(typedName, resolved.category);
    if (rawMerchant !== typedName) {
      updateGoogleSheetCellWithFeedback(rowNumber, MERCHANT_COLUMN, typedName, rawMerchant);
    }
    updateGoogleSheetCellWithFeedback(rowNumber, CATEGORY_COLUMN, resolved.category, rowData[CATEGORY_COLUMN - 1]);
    sendTelegramMessage(
      chatId,
      "✅ *Mapping saved:* " + escapeMarkdown(typedName) + " → " + escapeMarkdown(resolved.category),
      { parse_mode: "Markdown" }
    );
    return true;
  }

  // No known category: stash the typed name for `mapcat` to consume, then show picker.
  props.setProperty("editmerch_newname_" + emailMessageId, typedName);
  promptCategoryPicker(chatId, rowNumber, emailMessageId, typedName);
  return true;
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
      var ONBOARDING = ["/start", "/register", "/myinfo"];
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
        case "/myinfo":
          handleMyInfoCommand(chatId);
          break;
        case "/setup":
          handleSetupCommand(chatId);
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
      // Pending merchant-name reply (from Set Merchant or Edit Merchant flow).
      var userId = update.message.from.id;
      if (handleMerchantInput(chatId, userId, messageText)) return;
    }
  }
}

// Method to handle the /help command (also handles /start)
function handleHelpCommand(chatId, username) {
  var message =
    `*Commands*\n` +
    `• /ask — ask anything about your spending\n` +
    `   _e.g. /ask how much on food last month?_\n` +
    `• /stats — analytics dashboard\n` +
    `• /recent — recent transactions _(e.g. /recent 10)_\n` +
    `• /setup — email auto-forward setup instructions\n` +
    `• /myinfo — your account\n` +
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
      answerCallbackQuery(callbackQueryId, "❌ Error: No data received", false);
      return;
    }

    // Parse action and message ID from callback data
    var separatorIndex = data.indexOf("_");
    if (separatorIndex < 0) {
      answerCallbackQuery(callbackQueryId, "❌ Error: Invalid request", false);
      return;
    }

    var action = data.substring(0, separatorIndex); // "personal", "split", "partner", "editcat", "cat", "del", "setmerch", "stats", etc.
    var callbackPayload = data.substring(separatorIndex + 1);

    // Handle stats callbacks: stats_monthly, stats_trends, stats_whoowes
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
      answerCallbackQuery(callbackQueryId, "📂 Pick a category", false);
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
        answerCallbackQuery(callbackQueryId, "❌ Invalid category data", false);
        return;
      }
      var emailMessageId = callbackPayload.substring(0, lastUnderscore);
      var categoryIndex = parseInt(callbackPayload.substring(lastUnderscore + 1), 10);

      // Look up transaction type to determine which category list to use
      var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
      if (rowNumber < 0) return;

      var rowData = getRowData(rowNumber);
      var catList = getCategoryListForType(rowData[TRANSACTION_TYPE_COLUMN - 1]);

      if (isNaN(categoryIndex) || categoryIndex < 0 || categoryIndex >= catList.length) {
        answerCallbackQuery(callbackQueryId, "❌ Invalid category", false);
        return;
      }

      var newCategory = catList[categoryIndex];
      var currentCategory = rowData[CATEGORY_COLUMN - 1];
      var updateResult = updateGoogleSheetCellWithFeedback(rowNumber, CATEGORY_COLUMN, newCategory, currentCategory);

      if (!updateResult.success) {
        answerCallbackQuery(callbackQueryId, "❌ " + updateResult.message, false);
        return;
      }

      // Edit the picker message to show confirmation
      sendTelegramMessage(chatId, "✅ *Category updated to " + newCategory + "*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId
      });
      answerCallbackQuery(callbackQueryId, "✅ " + newCategory, false);
      return;
    }

    // Handle "Set Merchant" — ask user to type merchant name
    if (action === "setmerch") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
      if (rowNumber < 0) return;
      // Store pending state per user per user
      var userId = update.callback_query.from.id;
      var props = PropertiesService.getScriptProperties();
      props.setProperty("pending_merchant_input_" + userId, emailMessageId);
      answerCallbackQuery(callbackQueryId, "🏪 Type the merchant name", false);
      sendTelegramMessage(chatId, "🏪 *Type the merchant name (category picker follows):*", {
        parse_mode: "Markdown",
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: "e.g. Flipkart" }
      });
      return;
    }

    // Handle delete transaction: del_{messageId}
    if (action === "del") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
      if (rowNumber < 0) return;

      deleteSheetRow(rowNumber);

      sendTelegramMessage(chatId, "🗑️ *Transaction deleted*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId
      });
      answerCallbackQuery(callbackQueryId, "🗑️ Deleted", false);
      return;
    }

    // Handle "Save Mapping" — confirm the LLM-suggested merchant + category mapping
    if (action === "savemerch") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
      if (rowNumber < 0) return;
      var rowData = getRowData(rowNumber);
      var merchant = (rowData[MERCHANT_COLUMN - 1] || "").toString().trim();
      var category = (rowData[CATEGORY_COLUMN - 1] || "").toString().trim();
      if (!merchant) {
        answerCallbackQuery(callbackQueryId, "❌ No merchant to save", false);
        return;
      }
      var result = setMerchantResolution(merchant, merchant);
      if (!result.success) {
        answerCallbackQuery(callbackQueryId, "❌ " + result.message, false);
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
      answerCallbackQuery(callbackQueryId, "✅ Mapping saved", false);
      return;
    }

    // Handle "Edit Merchant" — prompt for a new merchant name; category picker follows after reply
    if (action === "editmerchname") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
      if (rowNumber < 0) return;
      var userIdEdit = update.callback_query.from.id;
      var propsEdit = PropertiesService.getScriptProperties();
      propsEdit.setProperty("pending_merchant_input_" + userIdEdit, emailMessageId);
      answerCallbackQuery(callbackQueryId, "🏪 Type the merchant name", false);
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
        answerCallbackQuery(callbackQueryId, "❌ Invalid data", false);
        return;
      }
      var emailMessageId = callbackPayload.substring(0, lastUnderscore);
      var categoryIndex = parseInt(callbackPayload.substring(lastUnderscore + 1), 10);
      var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
      if (rowNumber < 0) return;
      var rowData = getRowData(rowNumber);
      var rawMerchant = (rowData[MERCHANT_COLUMN - 1] || "").toString().trim(); // current value in col C; for new-merchant flow this == the original raw pattern
      var catList = getCategoryListForType(rowData[TRANSACTION_TYPE_COLUMN - 1]);
      if (isNaN(categoryIndex) || categoryIndex < 0 || categoryIndex >= catList.length) {
        answerCallbackQuery(callbackQueryId, "❌ Invalid category", false);
        return;
      }
      var newCategory = catList[categoryIndex];

      // Pick up the typed name from the merchant-input flow (if any); else keep existing.
      var propsMap = PropertiesService.getScriptProperties();
      var pendingNewName = propsMap.getProperty("editmerch_newname_" + emailMessageId);
      var resolvedName = pendingNewName ? pendingNewName : rawMerchant;
      if (pendingNewName) propsMap.deleteProperty("editmerch_newname_" + emailMessageId);

      if (!resolvedName) {
        answerCallbackQuery(callbackQueryId, "❌ No merchant name to save", false);
        return;
      }

      // Save resolution mapping (raw pattern → resolved name) only when the row
      // already had a raw merchant that differs from the typed name.
      if (rawMerchant && rawMerchant.toLowerCase() !== resolvedName.toLowerCase()) {
        var mapResult = setMerchantResolution(rawMerchant, resolvedName);
        if (!mapResult.success) {
          answerCallbackQuery(callbackQueryId, "❌ " + mapResult.message, false);
          return;
        }
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
      answerCallbackQuery(callbackQueryId, "✅ Saved", false);
      return;
    }

    var emailMessageId = callbackPayload; // Gmail message ID

    // Only handle split-toggle actions here; other actions handled above
    if (action !== "personal" && action !== "split" && action !== "partner") {
      answerCallbackQuery(callbackQueryId, "❌ Unknown action", false);
      return;
    }

    // Look up the row by message ID
    var rowNumber = requireRowForCallback(callbackQueryId, emailMessageId);
    if (rowNumber < 0) {
      sendTelegramMessage(chatId, "❌ *Error:* Could not find the transaction in the sheet.");
      return;
    }

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
      answerCallbackQuery(callbackQueryId, "❌ " + updateResult.message, false);
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
    answerCallbackQuery(callbackQueryId, `✅ Marked as ${valueToSet}`, false);
  } catch (error) {
    console.error("[handleCallbackQuery] Error:", error.message, error.stack);
    if (update.callback_query && update.callback_query.id) {
      answerCallbackQuery(update.callback_query.id, "❌ Error: " + error.message, false);
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

    // Cap limit to keep the webhook response snappy.
    if (limit > 50) limit = 50;
    if (limit < 1) limit = 1;

    var sheet = getSpreadsheet().getSheets()[0];
    var data = sheet.getDataRange().getValues();

    // Check if sheet is empty
    if (data.length <= 1) {
      sendTelegramMessage(chatId, "📅 *No transactions found yet!*");
      return;
    }

    // Skip header row
    data.shift();

    // Filter by user if specified
    if (userFilter) {
      data = data.filter(function (row) {
        var user = (row[USER_COLUMN - 1] || "").toString().toLowerCase();
        return user.indexOf(userFilter) !== -1;
      });
    }

    if (data.length === 0) {
      sendTelegramMessage(chatId, "📅 *No transactions found* for user: " + userFilter);
      return;
    }

    // Get last N transactions
    var recentTransactions = data.slice(-limit).reverse();

    var header = "📅 *Recent Transactions*";
    if (userFilter) header += " (user: " + userFilter + ")";
    var message = header + "\n\n";

    recentTransactions.forEach(function (row, index) {
      var rawDate = row[EMAIL_DATE_COLUMN - 1] || row[TRANSACTION_DATE_COLUMN - 1];
      var date =
        rawDate instanceof Date
          ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd MMM yyyy, HH:mm")
          : rawDate || "Unknown Date";
      var merchant = row[MERCHANT_COLUMN - 1] || "Unknown Merchant";
      var amount = parseFloat(row[AMOUNT_COLUMN - 1]) || 0;
      var type = row[TRANSACTION_TYPE_COLUMN - 1] || "Unknown";
      var category = row[CATEGORY_COLUMN - 1] || "Uncategorized";
      var currency = row[CURRENCY_COLUMN - 1] || "INR";

      var emoji = type === "Debit" ? "💸" : "💰";
      message += `${emoji} *${date}*\n`;
      message += `🏪 ${merchant}\n`;
      message += `💰 ${currency} ${amount.toFixed(2)}\n`;
      message += `📂 ${category}`;
      if (index < recentTransactions.length - 1) {
        message += `\n─────────────\n`;
      }
    });

    sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error("Error in showRecentTransactions:", error);
    sendTelegramMessage(chatId, "❌ *Error fetching recent transactions*\n\nPlease try again later.");
  }
}

// ─── Stats Command ───────────────────────────────────────────────────

function handleStatsCommand(chatId) {
  sendTelegramMessage(chatId, "📊 *Analytics Dashboard*\n\nPick an option:", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Monthly", callback_data: "stats_monthly" },
          { text: "📉 Trends", callback_data: "stats_trends" },
          { text: "💰 Who Owes", callback_data: "stats_whoowes" }
        ]
      ]
    }
  });
}

// ─── Ask Command (AI tool-calling) ───────────────────────────────────

function handleAskCommand(chatId, messageText) {
  var question = messageText.replace(/^\/ask(@\w+)?\s*/i, "").trim();

  // Retrieve thinking message ID sent by doPost
  var props = PropertiesService.getScriptProperties();
  var thinkingMsgId = props.getProperty("ask_thinking_msg_id");
  props.deleteProperty("ask_thinking_msg_id");
  thinkingMsgId = thinkingMsgId ? parseInt(thinkingMsgId, 10) : null;

  if (!question) {
    if (thinkingMsgId) deleteTelegramMessage(chatId, thinkingMsgId);
    sendTelegramMessage(
      chatId,
      "❓ *Ask me anything about your spending!*\n\n" +
        "Examples:\n" +
        "• `/ask How much did we spend on food?`\n" +
        "• `/ask Top merchants this month`\n" +
        "• `/ask Who owes whom in March?`\n" +
        "• `/ask Compare grocery spending Feb vs Mar`"
    );
    return;
  }

  try {
    var answer = runAskLoop(question);
    var escaped = escapeMarkdown(answer);

    if (thinkingMsgId) {
      // Edit the thinking message with the answer
      sendTelegramMessage(chatId, escaped, {
        message_id: thinkingMsgId
      });
    } else {
      sendTelegramMessage(chatId, escaped);
    }
  } catch (error) {
    console.error("Error in handleAskCommand:", error.message, error.stack);
    var errorMsg = "❌ Something went wrong. Try /stats for preset analytics.";
    if (thinkingMsgId) {
      sendTelegramMessage(chatId, errorMsg, { message_id: thinkingMsgId });
    } else {
      sendTelegramMessage(chatId, errorMsg);
    }
  }
}

function handleStatsCallback(chatId, telegramMessageId, callbackQueryId, subAction) {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();

  try {
    if (subAction === "monthly" || subAction.indexOf("monthly_") === 0) {
      var numMonths = 1;
      if (subAction.indexOf("monthly_") === 0) {
        numMonths = parseInt(subAction.split("_")[1], 10) || 1;
      }
      answerCallbackQuery(callbackQueryId, "📊 Loading...", false);
      var data = getMonthlyAnalytics(year, month, numMonths);
      if (!data) {
        sendTelegramMessage(chatId, "📊 *No transactions found.*");
        return;
      }
      var msg = formatMonthlyMessage(year, month, data, numMonths);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [buildPeriodButtons(year, month), buildMonthNavButtons(year, month)]
        }
      });
    } else if (subAction === "trends") {
      answerCallbackQuery(callbackQueryId, "📉 Loading trends...", false);
      var months = getTrendsAnalytics(6);
      var msg = formatTrendsMessage(months);
      sendTelegramMessage(chatId, msg);
    } else if (subAction === "whoowes") {
      answerCallbackQuery(callbackQueryId, "💰 Calculating...", false);
      var data = getWhoOwesAnalytics(year, month);
      if (!data) {
        sendTelegramMessage(chatId, "💰 *No split transactions this month.*");
        return;
      }
      var msg = formatWhoOwesMessage(year, month, data);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [buildMonthNavButtons(year, month, "whoowes")]
        }
      });
    }
  } catch (error) {
    console.error("Error in handleStatsCallback:", error.message, error.stack);
    answerCallbackQuery(callbackQueryId, "❌ Error: " + error.message, false);
  }
}

function handleMonthNavigation(chatId, telegramMessageId, callbackQueryId, action, payload) {
  try {
    // payload: "YYYY_M" or "YYYY_M_whoowes"
    var parts = payload.split("_");
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var mode = parts[2] || "monthly"; // "monthly" or "whoowes"

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

    if (mode === "whoowes") {
      answerCallbackQuery(callbackQueryId, "💰 Loading...", false);
      var data = getWhoOwesAnalytics(year, month);
      if (!data) {
        answerCallbackQuery(callbackQueryId, "No split transactions", false);
        var tz = Session.getScriptTimeZone();
        var label = Utilities.formatDate(new Date(year, month, 1), tz, "MMMM yyyy");
        sendTelegramMessage(chatId, "💰 *No split transactions in " + label + "*", {
          parse_mode: "Markdown",
          message_id: telegramMessageId,
          reply_markup: {
            inline_keyboard: [buildMonthNavButtons(year, month, "whoowes")]
          }
        });
        return;
      }
      var msg = formatWhoOwesMessage(year, month, data);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: {
          inline_keyboard: [buildMonthNavButtons(year, month, "whoowes")]
        }
      });
    } else {
      answerCallbackQuery(callbackQueryId, "📊 Loading...", false);
      var data = getMonthlyAnalytics(year, month);
      if (!data) {
        answerCallbackQuery(callbackQueryId, "No transactions", false);
        var tz = Session.getScriptTimeZone();
        var label = Utilities.formatDate(new Date(year, month, 1), tz, "MMMM yyyy");
        sendTelegramMessage(chatId, "📊 *No transactions in " + label + "*", {
          parse_mode: "Markdown",
          message_id: telegramMessageId,
          reply_markup: {
            inline_keyboard: [buildPeriodButtons(year, month), buildMonthNavButtons(year, month)]
          }
        });
        return;
      }
      var msg = formatMonthlyMessage(year, month, data);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: {
          inline_keyboard: [buildPeriodButtons(year, month), buildMonthNavButtons(year, month)]
        }
      });
    }
  } catch (error) {
    console.error("Error in handleMonthNavigation:", error.message, error.stack);
    answerCallbackQuery(callbackQueryId, "❌ Error: " + error.message, false);
  }
}

function buildMonthNavButtons(year, month, mode) {
  var suffix = mode ? "_" + mode : "";
  return [
    { text: "◀️ Prev", callback_data: "monthprev_" + year + "_" + month + suffix },
    { text: "▶️ Next", callback_data: "monthnext_" + year + "_" + month + suffix }
  ];
}

function buildPeriodButtons(year, month) {
  return [
    { text: "1M", callback_data: "stats_monthly_1" },
    { text: "2M", callback_data: "stats_monthly_2" },
    { text: "3M", callback_data: "stats_monthly_3" },
    { text: "6M", callback_data: "stats_monthly_6" }
  ];
}
