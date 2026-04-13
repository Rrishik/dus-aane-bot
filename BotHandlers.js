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

      switch (command) {
        case "/start":
        case "/help":
          handleHelpCommand(chatId, username);
          break;
        case "/summary":
          showTransactionSummary(chatId, messageText);
          break;
        case "/recent":
          showRecentTransactions(chatId, messageText);
          break;
        case "/stats":
          handleStatsCommand(chatId);
          break;
        case "/backfill":
          handleBackfillCommand(chatId, messageText);
          break;
        default:
          sendTelegramMessage(chatId, "❌ *Unknown command!*\n\nUse /help to see available commands.");
      }
    }
    // Handle menu button clicks
    else if (messageText === "📊 View Summary") {
      showTransactionSummary(chatId);
    } else if (messageText === "📅 Recent Transactions") {
      showRecentTransactions(chatId, "/recent");
    }
  }
}

// Method to handle the /help command (also handles /start)
function handleHelpCommand(chatId, username) {
  var greeting = username ? `👋 *Hey ${username}!*\n\n` : "";
  var message =
    greeting +
    `📚 *Available Commands:*\n\n` +
    `• /summary - View spending summary\n` +
    `  ↳ /summary 20 - Last 20 transactions\n` +
    `  ↳ /summary - Last 10 (default)\n\n` +
    `• /recent - View recent transactions\n` +
    `  ↳ /recent 10 - Last 10 transactions\n` +
    `  ↳ /recent rishik - Filter by user\n` +
    `  ↳ /recent 10 rishik - Both filters\n\n` +
    `• /stats - Analytics dashboard\n` +
    `• /help - Show this message\n\n` +
    `*Hidden Commands:*\n` +
    `• /backfill - Backfill transactions\n` +
    `  ↳ /backfill 3 days\n` +
    `  ↳ /backfill 2 weeks\n` +
    `  ↳ /backfill 1 month\n` +
    `  ↳ /backfill 2026-03-01 2026-03-31\n\n` +
    `*Features:*\n` +
    `• Automatic email transaction parsing\n` +
    `• Transaction splitting\n` +
    `• Multi-currency support\n` +
    `• Category-wise spending analysis`;

  var sheetUrl = "https://docs.google.com/spreadsheets/d/" + SHEET_ID;
  sendTelegramMessage(chatId, message, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📋 Open Sheet", url: sheetUrl },
          { text: "📖 README", url: "https://github.com/Rrishik/dus-aane-bot#readme" }
        ]
      ]
    }
  });
}

// Method to handle the /backfill command
function handleBackfillCommand(chatId, messageText) {
  var parts = messageText.split(" ");

  if (parts.length < 2) {
    sendTelegramMessage(
      chatId,
      "❌ *Invalid format!*\n\n" +
        "Use: `/backfill 3 days` or `/backfill 2 weeks`\n" +
        "Or: `/backfill YYYY-MM-DD YYYY-MM-DD`"
    );
    return;
  }

  var startDate, endDate;

  // Check for relative duration: /backfill <N> <days|weeks|months>
  var amount = parseInt(parts[1], 10);
  var isRelative = !isNaN(amount) && parts.length >= 3 && parts[1].indexOf("-") < 0;
  if (isRelative) {
    var unit = parts[2].toLowerCase().replace(/s$/, ""); // normalize: "days" → "day"
    endDate = new Date();
    startDate = new Date();
    if (unit === "day") {
      startDate.setDate(startDate.getDate() - amount);
    } else if (unit === "week") {
      startDate.setDate(startDate.getDate() - amount * 7);
    } else if (unit === "month") {
      startDate.setMonth(startDate.getMonth() - amount);
    } else {
      sendTelegramMessage(chatId, "❌ *Unknown unit!* Use `days`, `weeks`, or `months`.");
      return;
    }
  } else if (parts.length >= 3) {
    // Absolute date range: /backfill YYYY-MM-DD YYYY-MM-DD
    startDate = new Date(parts[1]);
    endDate = new Date(parts[2]);
  } else {
    sendTelegramMessage(
      chatId,
      "❌ *Invalid format!*\n\n" +
        "Use: `/backfill 3 days` or `/backfill 2 weeks`\n" +
        "Or: `/backfill YYYY-MM-DD YYYY-MM-DD`"
    );
    return;
  }

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    sendTelegramMessage(
      chatId,
      "❌ *Invalid dates!* Use format YYYY-MM-DD\n\nExample: `/backfill 2026-03-01 2026-03-31`"
    );
    return;
  }

  if (startDate > endDate) {
    sendTelegramMessage(chatId, "❌ *Start date must be before end date.*");
    return;
  }

  startChunkedBackfill(startDate, endDate);
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
    var data = update.callback_query.data; // Example: "split_abc123" or "personal_abc123"

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

    var action = data.substring(0, separatorIndex); // "personal", "split", "details", "editcat", or "cat"
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
      answerCallbackQuery(callbackQueryId, "📂 Pick a category", false);
      sendTelegramMessage(chatId, "📂 *Select a category:*", {
        parse_mode: "Markdown",
        reply_markup: buildCategoryKeyboard(callbackPayload)
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

      if (isNaN(categoryIndex) || categoryIndex < 0 || categoryIndex >= CATEGORIES.length) {
        answerCallbackQuery(callbackQueryId, "❌ Invalid category", false);
        return;
      }

      var newCategory = CATEGORIES[categoryIndex];
      var rowNumber = findRowByColumnValue(SHEET_ID, MESSAGE_ID_COLUMN, emailMessageId);
      if (rowNumber < 0) {
        answerCallbackQuery(callbackQueryId, "❌ Transaction not found", false);
        return;
      }

      var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
      var rowData = sheet.getRange(rowNumber, 1, 1, 10).getValues()[0];
      var currentCategory = rowData[CATEGORY_COLUMN - 1];
      var merchant = rowData[2]; // Column C = Merchant
      var updateResult = updateGoogleSheetCellWithFeedback(
        SHEET_ID,
        rowNumber,
        CATEGORY_COLUMN,
        newCategory,
        currentCategory
      );

      if (!updateResult.success) {
        answerCallbackQuery(callbackQueryId, "❌ " + updateResult.message, false);
        return;
      }

      // Save merchant→category override for future AI categorization
      if (merchant) {
        saveCategoryOverride(SHEET_ID, merchant.toString(), newCategory);
      }

      // Edit the picker message to show confirmation
      sendTelegramMessage(chatId, "✅ *Category updated to " + newCategory + "*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId
      });
      answerCallbackQuery(callbackQueryId, "✅ " + newCategory, false);
      return;
    }

    // Handle delete transaction: del_{messageId}
    if (action === "del") {
      var emailMessageId = callbackPayload;
      var rowNumber = findRowByColumnValue(SHEET_ID, MESSAGE_ID_COLUMN, emailMessageId);
      if (rowNumber < 0) {
        answerCallbackQuery(callbackQueryId, "❌ Transaction not found", false);
        return;
      }

      deleteSheetRow(SHEET_ID, rowNumber);

      sendTelegramMessage(chatId, "🗑️ *Transaction deleted*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId
      });
      answerCallbackQuery(callbackQueryId, "🗑️ Deleted", false);
      return;
    }

    var emailMessageId = callbackPayload; // Gmail message ID

    // Look up the row by message ID
    var rowNumber = findRowByColumnValue(SHEET_ID, MESSAGE_ID_COLUMN, emailMessageId);
    if (rowNumber < 0) {
      answerCallbackQuery(callbackQueryId, "❌ Transaction not found", false);
      sendTelegramMessage(chatId, "❌ *Error:* Could not find the transaction in the sheet.");
      return;
    }

    var valueToSet = action === "personal" ? SPLIT_STATUS.PERSONAL : SPLIT_STATUS.SPLIT;

    // Read current value
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var currentValue = sheet.getRange(rowNumber, SPLIT_COLUMN).getValue();

    // Update the cell
    var updateResult = updateGoogleSheetCellWithFeedback(SHEET_ID, rowNumber, SPLIT_COLUMN, valueToSet, currentValue);

    if (!updateResult.success) {
      answerCallbackQuery(callbackQueryId, "❌ " + updateResult.message, false);
      sendTelegramMessage(chatId, "❌ *Error updating transaction*\n\n" + updateResult.message);
      return;
    }

    // Build toggle button + edit category
    var toggleAction = action === "personal" ? "split" : "personal";
    var toggleText = toggleAction === "split" ? "✂️ Split" : "🔄 Personal";

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
function showTransactionSummary(chatId, messageText) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var data = sheet.getDataRange().getValues();

    // Check if sheet is empty
    if (data.length <= 1) {
      sendTelegramMessage(chatId, "📊 *No transactions found yet!*");
      return;
    }

    // Skip header row
    data.shift();

    // Parse optional limit from message (e.g. "/summary 20"), default 10
    var limit = 10;
    if (messageText) {
      var parts = messageText.split(" ");
      if (parts.length >= 2) {
        var parsed = parseInt(parts[1]);
        if (!isNaN(parsed) && parsed > 0) limit = parsed;
      }
    }

    // Apply limit — take last N transactions
    if (data.length > limit) {
      data = data.slice(-limit);
    }

    var spentByCurrency = {};
    var receivedByCurrency = {};
    var categorySpending = {};
    var transactionCount = 0;

    data.forEach(function (row) {
      var amount = parseFloat(row[3]) || 0;
      var type = row[5];
      var category = row[4] || "Uncategorized";
      var currency = row[9] || "INR";

      if (type === "Debit") {
        spentByCurrency[currency] = (spentByCurrency[currency] || 0) + amount;
        var catKey = category + "|||" + currency;
        categorySpending[catKey] = (categorySpending[catKey] || 0) + amount;
      } else if (type === "Credit") {
        receivedByCurrency[currency] = (receivedByCurrency[currency] || 0) + amount;
      }
      transactionCount++;
    });

    var message = limit > 0 ? `📊 *Summary (last ${limit} transactions)*\n\n` : `📊 *Transaction Summary*\n\n`;
    message += `📈 *Total Transactions:* ${transactionCount}\n\n`;

    // Spent per currency
    var spentCurrencies = Object.keys(spentByCurrency);
    if (spentCurrencies.length === 1) {
      message += `💰 *Total Spent:* ${spentCurrencies[0]} ${spentByCurrency[spentCurrencies[0]].toFixed(2)}\n`;
    } else if (spentCurrencies.length > 1) {
      message += `💰 *Total Spent:*\n`;
      spentCurrencies.forEach(function (cur) {
        message += `  • ${cur} ${spentByCurrency[cur].toFixed(2)}\n`;
      });
    }

    // Received per currency
    var receivedCurrencies = Object.keys(receivedByCurrency);
    if (receivedCurrencies.length === 1) {
      message += `💵 *Total Received:* ${receivedCurrencies[0]} ${receivedByCurrency[receivedCurrencies[0]].toFixed(2)}\n`;
    } else if (receivedCurrencies.length > 1) {
      message += `💵 *Total Received:*\n`;
      receivedCurrencies.forEach(function (cur) {
        message += `  • ${cur} ${receivedByCurrency[cur].toFixed(2)}\n`;
      });
    }

    message += `\n📂 *Category-wise Spending:*\n`;

    // Sort categories by amount spent
    var sortedCatKeys = Object.keys(categorySpending).sort(function (a, b) {
      return categorySpending[b] - categorySpending[a];
    });

    sortedCatKeys.forEach(function (catKey) {
      var parts = catKey.split("|||");
      var category = parts[0];
      var currency = parts[1];
      var amount = categorySpending[catKey];
      var totalSpentInCurrency = spentByCurrency[currency] || 1;
      var percentage = ((amount / totalSpentInCurrency) * 100).toFixed(1);
      message += `• ${category}: ${currency} ${amount.toFixed(2)} (${percentage}%)\n`;
    });

    sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error("Error in showTransactionSummary:", error);
    sendTelegramMessage(chatId, "❌ *Error generating summary*\n\nPlease try again later.");
  }
}

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

    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
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
        var user = (row[6] || "").toString().toLowerCase();
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
      var rawDate = row[0] || row[1];
      var date =
        rawDate instanceof Date
          ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd MMM yyyy, HH:mm")
          : rawDate || "Unknown Date";
      var merchant = row[2] || "Unknown Merchant";
      var amount = parseFloat(row[3]) || 0;
      var type = row[5] || "Unknown";
      var category = row[4] || "Uncategorized";
      var currency = row[9] || "INR";

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

function handleStatsCallback(chatId, telegramMessageId, callbackQueryId, subAction) {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();

  try {
    if (subAction === "monthly") {
      answerCallbackQuery(callbackQueryId, "📊 Loading monthly...", false);
      var data = getMonthlyAnalytics(year, month);
      if (!data) {
        sendTelegramMessage(chatId, "📊 *No transactions this month.*");
        return;
      }
      var msg = formatMonthlyMessage(year, month, data);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [buildMonthNavButtons(year, month)]
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
            inline_keyboard: [buildMonthNavButtons(year, month)]
          }
        });
        return;
      }
      var msg = formatMonthlyMessage(year, month, data);
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: {
          inline_keyboard: [buildMonthNavButtons(year, month)]
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
