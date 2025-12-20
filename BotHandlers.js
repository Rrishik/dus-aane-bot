// Method to handle messages sent to the Telegram bot.
function handleMessage(update) {
  if (update.message) {
    var chatId = update.message.chat.id;
    var messageText = update.message.text;
    var username = update.message.from.first_name || update.message.from.username;

    // Handle commands
    if (messageText.startsWith('/')) {
      var command = messageText.split(' ')[0].toLowerCase();

      switch (command) {
        case '/start':
          handleStartCommand(chatId, username);
          break;
        case '/help':
          handleHelpCommand(chatId);
          break;
        case '/summary':
          showTransactionSummary(chatId);
          break;
        case '/recent':
          showRecentTransactions(chatId);
          break;
        case '/addtransaction':
          if (messageText.split(' ').length < 4) {
            sendTelegramMessage(chatId, "❌ *Invalid format!* Use: `/addtransaction <amount> <category> <merchant>`\n\nExample: `/addtransaction 1000 Food Zomato`");
          } else {
            addTransaction(chatId, messageText, username);
          }
          break;
        default:
          sendTelegramMessage(chatId, "❌ *Unknown command!*\n\nUse /help to see available commands.");
      }
    }
    // Handle menu button clicks
    else if (messageText === '➕ Add Transaction') {
      sendTelegramMessage(chatId, "To add a transaction, use the format:\n`/addtransaction <amount> <category> <merchant>`\n\nExample: `/addtransaction 1000 Food Zomato`");
    }
    else if (messageText === '📊 View Summary') {
      showTransactionSummary(chatId);
    }
    else if (messageText === '📅 Recent Transactions') {
      showRecentTransactions(chatId);
    }
  }
}

// Method to handle the /start command and show menu options
function handleStartCommand(chatId, username) {
  var message = `👋 *Welcome ${username}!*\n\nI'm your transaction management bot. Here's what I can do:\n\n` +
    `📝 *Commands:*\n` +
    `• /addtransaction - Add a new transaction\n` +
    `• /summary - View transaction summary\n` +
    `• /recent - View recent transactions\n` +
    `• /help - Show help information\n\n` +
    `💡 *Tip:* Type / to see all available commands!`;

  var keyboard = {
    keyboard: [
      ["➕ Add Transaction"],
      ["📊 View Summary", "📅 Recent Transactions"]
    ],
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
  var message = `📚 *Help Guide*\n\n` +
    `*Available Commands:*\n` +
    `• /start - Start the bot\n` +
    `• /addtransaction - Add a new transaction\n` +
    `• /summary - View transaction summary\n` +
    `• /recent - View recent transactions\n` +
    `• /help - Show this help message\n\n` +
    `*Adding a Transaction:*\n` +
    `Use the format: /addtransaction <amount> <category> <merchant>\n` +
    `Example: /addtransaction 1000 Food Zomato\n\n` +
    `*Features:*\n` +
    `• Automatic email transaction parsing\n` +
    `• Transaction splitting\n` +
    `• Category-wise spending analysis\n` +
    `• Recent transaction history`;

  sendTelegramMessage(chatId, message);
}

// Method to add a manual transaction via the Telegram bot.
function addTransaction(chatId, messageText, username) {
  var parts = messageText.split(" "); // Split the message
  if (parts.length < 3) {
    sendTelegramMessage(chatId, "❌ *Invalid format!* Use: `/addtransaction <amount> <category> <merchant>`");
    return;
  }

  var amount = parts[1];
  var category = parts[2];
  var merchant = parts.slice(3).join(" "); // Join remaining words as merchant name
  var date = new Date().toLocaleDateString();

  appendRowToGoogleSheet(SHEET_ID, [date, date, merchant, amount, category, "Debit", username, SPLIT_STATUS.PERSONAL]);

  // Get the row number after appending
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  var rowNumber = sheet.getLastRow(); // Get the last row number
  
  // Validate row number
  if (rowNumber <= 1) {
    console.log("Warning: Invalid row number after append:", rowNumber);
    var message = `✅ *Transaction Added!*\n💰 *Amount:* INR ${amount}\n📂 *Category:* ${category}\n🏪 *Merchant:* ${merchant}\n👤 *Added by:* ${username}`;
    sendTelegramMessage(chatId, message);
    return;
  }
  
  console.log("Manual transaction saved to row:", rowNumber);
  var message = `✅ *Transaction Added!*\n💰 *Amount:* INR ${amount}\n📂 *Category:* ${category}\n🏪 *Merchant:* ${merchant}\n👤 *Added by:* ${username}`;
  var reply_markup = buildReplyMarkup("✂️ Split Transaction", `split_${rowNumber}`);
  var options = {
    parse_mode: "Markdown",
    reply_markup: reply_markup
  };

  // Send a confirmation message
  sendTelegramMessage(chatId, message, options);
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
    var messageId = update.callback_query.message.message_id;
    var messageText = update.callback_query.message.text;
    var data = update.callback_query.data; // Example: "personal_5" or "split_8"
    
    console.log("[handleCallbackQuery] Callback query received:", {
      callbackQueryId: callbackQueryId,
      chatId: chatId, 
      messageId: messageId, 
      data: data,
      SHEET_ID: SHEET_ID,
      SPLIT_COLUMN: SPLIT_COLUMN
    });
    
    if (!data) {
      console.log("[handleCallbackQuery] Error: No callback data received");
      answerCallbackQuery(callbackQueryId, "❌ Error: No data received", false);
      return;
    }
    
    var parts = data.split("_");
    if (parts.length < 2) {
      console.log("[handleCallbackQuery] Error: Invalid callback data format:", data);
      answerCallbackQuery(callbackQueryId, "❌ Error: Invalid request", false);
      return;
    }
    
    var action = parts[0]; // "personal" or "split"
    var rowNumber = parseInt(parts[1]); // Extract row number
    
    console.log("[handleCallbackQuery] Processing callback - Action:", action, "Row:", rowNumber, "Type:", typeof rowNumber);

    if (isNaN(rowNumber) || rowNumber <= 0) {
      console.log("[handleCallbackQuery] Error: Invalid row number:", rowNumber, "Parsed from:", parts[1]);
      answerCallbackQuery(callbackQueryId, "❌ Error: Invalid row number", false);
      return;
    }

    // Determine the value to set based on action
    var valueToSet = action === "personal" ? SPLIT_STATUS.PERSONAL : SPLIT_STATUS.SPLIT;
    
    // First, verify the row exists and get current value
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var lastRow = sheet.getLastRow();
    var currentValue = "";
    var errorMessage = "";
    
    // Check if row exists
    if (rowNumber > lastRow) {
      errorMessage = "❌ *Error:* Row " + rowNumber + " doesn't exist. Last row is " + lastRow + ".";
      answerCallbackQuery(callbackQueryId, "Row doesn't exist", false);
      sendTelegramMessage(chatId, errorMessage);
      return;
    }
    
    if (rowNumber <= 1) {
      errorMessage = "❌ *Error:* Cannot update header row (row 1).";
      answerCallbackQuery(callbackQueryId, "Invalid row", false);
      sendTelegramMessage(chatId, errorMessage);
      return;
    }
    
    // Read current value
    try {
      currentValue = sheet.getRange(rowNumber, SPLIT_COLUMN).getValue();
    } catch (e) {
      errorMessage = "❌ *Error reading cell:* " + e.message;
      answerCallbackQuery(callbackQueryId, "Read error", false);
      sendTelegramMessage(chatId, errorMessage);
      return;
    }

    // Update the existing row in Google Sheets
    var updateResult = updateGoogleSheetCellWithFeedback(SHEET_ID, rowNumber, SPLIT_COLUMN, valueToSet, currentValue);

    if (!updateResult.success) {
      answerCallbackQuery(callbackQueryId, "❌ " + updateResult.message, false);
      sendTelegramMessage(chatId, "❌ *Error updating transaction*\n\n" + updateResult.message + "\n\n*Details:*\nRow: " + rowNumber + "\nColumn: " + SPLIT_COLUMN + "\nCurrent: " + currentValue + "\nTrying to set: " + valueToSet);
      return;
    }

    var toggleAction = action === "personal" ? "split" : "personal"; // Toggle between personal and split
    var toggleText = toggleAction === "split" ? "✂️ Split Transaction" : "🔄 Mark as Personal";
    
    // Verify the update by reading back the value
    var verifyValue = "";
    try {
      verifyValue = sheet.getRange(rowNumber, SPLIT_COLUMN).getValue();
    } catch (e) {
      verifyValue = "Could not verify: " + e.message;
    }
    
    var options = {
      parse_mode: "Markdown",
      reply_markup: buildReplyMarkup(toggleText, `${toggleAction}_${rowNumber}`),
      message_id: messageId
    };
    
    var statusMessage = verifyValue === valueToSet 
      ? `✅ *Marked as ${valueToSet}*` 
      : `⚠️ *Update sent* (Current: ${verifyValue}, Expected: ${valueToSet})`;
    
    var message = `${statusMessage}

${messageText}`;
    sendTelegramMessage(chatId, message, options);

    // Acknowledge callback to Telegram
    answerCallbackQuery(callbackQueryId, `✅ Marked as ${valueToSet}`, false);
  } catch (error) {
    console.error("[handleCallbackQuery] Error processing callback:", error.message);
    console.error("[handleCallbackQuery] Stack trace:", error.stack);
    if (update.callback_query && update.callback_query.id) {
      answerCallbackQuery(update.callback_query.id, "❌ Error: " + error.message, false);
    }
  }
}

// Function to show transaction summary
function showTransactionSummary(chatId) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var data = sheet.getDataRange().getValues();

    // Check if sheet is empty
    if (data.length <= 1) {
      sendTelegramMessage(chatId, "📊 *No transactions found yet!*\n\nStart adding transactions to see your summary.");
      return;
    }

    // Skip header row
    data.shift();

    var totalSpent = 0;
    var totalReceived = 0;
    var categorySpending = {};
    var transactionCount = 0;

    data.forEach(function (row) {
      var amount = parseFloat(row[3]) || 0; // Amount column with fallback to 0
      var type = row[5]; // Transaction Type column
      var category = row[4] || "Uncategorized"; // Category column with fallback

      if (type === "Debit") {
        totalSpent += amount;
        categorySpending[category] = (categorySpending[category] || 0) + amount;
      } else if (type === "Credit") {
        totalReceived += amount;
      }
      transactionCount++;
    });

    var message = `📊 *Transaction Summary*\n\n`;
    message += `📈 *Total Transactions:* ${transactionCount}\n`;
    message += `💰 *Total Spent:* INR ${totalSpent.toFixed(2)}\n`;
    message += `💵 *Total Received:* INR ${totalReceived.toFixed(2)}\n`;
    message += `📉 *Net Balance:* INR ${(totalReceived - totalSpent).toFixed(2)}\n\n`;
    message += `📂 *Category-wise Spending:*\n`;

    // Sort categories by amount spent
    var sortedCategories = Object.keys(categorySpending).sort(function (a, b) {
      return categorySpending[b] - categorySpending[a];
    });

    sortedCategories.forEach(function (category) {
      var amount = categorySpending[category];
      var percentage = ((amount / totalSpent) * 100).toFixed(1);
      message += `• ${category}: INR ${amount.toFixed(2)} (${percentage}%)\n`;
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
      sendTelegramMessage(chatId, "📅 *No transactions found yet!*\n\nStart adding transactions to see your history.");
      return;
    }

    // Skip header row
    data.shift();

    // Get last 5 transactions
    var recentTransactions = data.slice(-5).reverse();

    var message = `📅 *Recent Transactions*\n\n`;

    recentTransactions.forEach(function (row) {
      var date = row[1] || "Unknown Date"; // Transaction Date
      var merchant = row[2] || "Unknown Merchant"; // Merchant
      var amount = parseFloat(row[3]) || 0; // Amount
      var type = row[5] || "Unknown"; // Transaction Type
      var category = row[4] || "Uncategorized"; // Category

      var emoji = type === "Debit" ? "💸" : "💰";
      message += `${emoji} *${date}*\n`;
      message += `🏪 ${merchant}\n`;
      message += `💰 INR ${amount.toFixed(2)}\n`;
      message += `📂 ${category}\n\n`;
    });

    sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error("Error in showRecentTransactions:", error);
    sendTelegramMessage(chatId, "❌ *Error fetching recent transactions*\n\nPlease try again later.");
  }
}