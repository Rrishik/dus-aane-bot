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
          handleStartCommand(chatId, username);
          break;
        case "/help":
          handleHelpCommand(chatId);
          break;
        case "/summary":
          showTransactionSummary(chatId, messageText);
          break;
        case "/recent":
          showRecentTransactions(chatId);
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
      showRecentTransactions(chatId);
    }
  }
}

// Method to handle the /start command and show menu options
function handleStartCommand(chatId, username) {
  var message =
    `👋 *Welcome ${username}!*\n\nI'm your transaction management bot. Here's what I can do:\n\n` +
    `📝 *Commands:*\n` +
    `• /backfill - Backfill transactions for a date range\n` +
    `• /summary - View summary (e.g. /summary 10)\n` +
    `• /recent - View recent transactions\n` +
    `• /help - Show help information\n\n` +
    `💡 *Tip:* Type / to see all available commands!`;

  var keyboard = {
    keyboard: [["📊 View Summary", "📅 Recent Transactions"]],
    resize_keyboard: true,
    one_time_keyboard: false
  };

  var options = {
    parse_mode: "Markdown",
    reply_markup: JSON.stringify(keyboard)
  };

  sendTelegramMessage(chatId, message, options);
}

// Method to handle the /help command
function handleHelpCommand(chatId) {
  var message =
    `📚 *Help Guide*\n\n` +
    `*Available Commands:*\n` +
    `• /start - Start the bot\n` +
    `• /backfill - Backfill transactions for a date range\n` +
    `• /summary - View summary (e.g. /summary 10)\n` +
    `• /recent - View recent transactions\n` +
    `• /help - Show this help message\n\n` +
    `*Backfilling Transactions:*\n` +
    `Use the format: /backfill YYYY-MM-DD YYYY-MM-DD\n` +
    `Example: /backfill 2026-03-01 2026-03-31\n\n` +
    `*Features:*\n` +
    `• Automatic email transaction parsing\n` +
    `• Transaction splitting\n` +
    `• Date range backfill with dedup\n` +
    `• Category-wise spending analysis\n` +
    `• Recent transaction history`;

  sendTelegramMessage(chatId, message);
}

// Method to handle the /backfill command
function handleBackfillCommand(chatId, messageText) {
  var parts = messageText.split(" ");
  if (parts.length < 3) {
    sendTelegramMessage(
      chatId,
      "❌ *Invalid format!* Use: `/backfill YYYY-MM-DD YYYY-MM-DD`\n\nExample: `/backfill 2026-03-01 2026-03-31`"
    );
    return;
  }

  var startDate = new Date(parts[1]);
  var endDate = new Date(parts[2]);

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

  // Set end date to end of day
  endDate.setHours(23, 59, 59, 999);

  backfillTransactions(chatId, startDate, endDate);
}

// Method to handle the callback queries sent from the Telegram message reply buttons.
function handleCallbackQuery(update) {
  try {
    if (!update.callback_query) {
      console.log("[handleCallbackQuery] Error: No callback_query in update");
      return;
    }

    var callbackQueryId = update.callback_query.id;
    var chatId = update.callback_query.message.chat.id;
    var telegramMessageId = update.callback_query.message.message_id;
    var messageText = update.callback_query.message.text;
    var data = update.callback_query.data; // Example: "split_abc123" or "personal_abc123"

    console.log("[handleCallbackQuery] Callback received:", { data: data });

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

    var action = data.substring(0, separatorIndex); // "personal", "split", or "details"
    var callbackPayload = data.substring(separatorIndex + 1);

    // Handle "Show Details" from backfill summary
    if (action === "details") {
      var dates = callbackPayload.split("_");
      if (dates.length < 2) {
        answerCallbackQuery(callbackQueryId, "❌ Invalid date range", false);
        return;
      }
      answerCallbackQuery(callbackQueryId, "📋 Loading details...", false);
      showBackfillDetails(chatId, dates[0], dates[1]);
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

    // Build toggle button
    var toggleAction = action === "personal" ? "split" : "personal";
    var toggleText = toggleAction === "split" ? "✂️ Split Transaction" : "🔄 Mark as Personal";

    var options = {
      parse_mode: "Markdown",
      reply_markup: buildReplyMarkup(toggleText, `${toggleAction}_${emailMessageId}`),
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

    // Parse optional limit from message (e.g. "/summary 10")
    var limit = 0;
    if (messageText) {
      var parts = messageText.split(" ");
      if (parts.length >= 2) {
        limit = parseInt(parts[1]);
        if (isNaN(limit) || limit <= 0) limit = 0;
      }
    }

    // Apply limit — take last N transactions
    if (limit > 0 && data.length > limit) {
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
function showRecentTransactions(chatId) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var data = sheet.getDataRange().getValues();

    // Check if sheet is empty
    if (data.length <= 1) {
      sendTelegramMessage(chatId, "📅 *No transactions found yet!*");
      return;
    }

    // Skip header row
    data.shift();

    // Get last 5 transactions
    var recentTransactions = data.slice(-5).reverse();

    var message = `📅 *Recent Transactions*\n\n`;

    recentTransactions.forEach(function (row, index) {
      var date = row[1] || "Unknown Date";
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

// Function to show individual transactions for a date range (triggered from backfill "Show Details" button)
function showBackfillDetails(chatId, startDateStr, endDateStr) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      sendTelegramMessage(chatId, "📋 *No transactions found.*");
      return;
    }

    // Skip header
    data.shift();

    var startDate = new Date(startDateStr);
    var endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);

    // Filter rows by transaction date within range
    var matching = data.filter(function (row) {
      var txnDate = new Date(row[1]);
      return txnDate >= startDate && txnDate <= endDate;
    });

    if (matching.length === 0) {
      sendTelegramMessage(chatId, `📋 *No transactions found* for ${startDateStr} to ${endDateStr}`);
      return;
    }

    // Send each transaction as read-only detail (cap at 20 to avoid flooding)
    var cap = Math.min(matching.length, 20);
    for (var i = 0; i < cap; i++) {
      var row = matching[i];
      var txnData = {
        transaction_date: row[1],
        merchant: row[2],
        amount: row[3],
        category: row[4],
        transaction_type: row[5],
        currency: row[9] || "INR"
      };
      var user = row[6];
      sendTransactionDetailMessage(chatId, txnData, user);
      Utilities.sleep(500);
    }

    if (matching.length > cap) {
      sendTelegramMessage(chatId, `📋 *Showing ${cap} of ${matching.length} transactions*`);
    }
  } catch (error) {
    console.error("Error in showBackfillDetails:", error);
    sendTelegramMessage(chatId, "❌ *Error fetching details*\n\nPlease try again later.");
  }
}
