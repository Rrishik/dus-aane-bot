// Webhook endpoint for the Telegram bot
// This function is triggered when a POST request is made to the script URL
function doPost(e) {
  console.log("Webhook data received:", e.postData.contents);
  var update = JSON.parse(e.postData.contents);

  if (update.callback_query) {
    handleCallbackQuery(update);
    console.log("Callback processed!");
  } else if (update.message) {
    handleMessage(update);
    console.log("Message processed!");
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}


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

  appendRowToGoogleSheet(SHEET_ID, [date, date, merchant, amount, category, "Debit", username, "Personal"]);

  var rowNumber = SpreadsheetApp.openById(SHEET_ID).getSheets()[0].getLastRow(); // Get the last row number
  var message = `✅ *Transaction Added!*\n💰 *Amount:* INR ${amount}\n📂 *Category:* ${category}\n🏪 *Merchant:* ${merchant}\n👤 *Added by:* ${username}`;
  var replyMarkup = getReplyMarkup("✂️ Split Transaction", `split_${rowNumber}`);
  var options = {
    parseMode: "Markdown",
    replyMarkup: replyMarkup
  };

  // Send a confirmation message
  sendTelegramMessage(chatId, message, options);
}

// Method to handle the callback queries sent from the Telegram message reply buttons.
function handleCallbackQuery(update) {
  if (update.callback_query) {
    var callbackQueryId = update.callback_query.id;
    var chatId = update.callback_query.message.chat.id;
    var messageId = update.callback_query.message.message_id;
    var messageText = update.callback_query.message.text;
    var data = update.callback_query.data; // Example: "personal_5" or "split_8"
    console.log([chatId, messageId, data]);
    if (data) {
      var action = data.split("_")[0]; // "personal" or "split"
      var toggleAction = action === "personal" ? "split" : "personal"; // Toggle between personal and split
      var rowNumber = parseInt(data.split("_")[1]); // Extract row number

      // Update the existing row in Google Sheets
      updateGoogleSheetCell(SHEET_ID, rowNumber, SPLIT_COLUMN, action === "personal" ? "Personal" : "Split");

      var options = {
        parseMode: "Markdown",
        replyMarkup: getReplyMarkup(`🔄 Update to ${toggleAction}`, `${toggleAction}_${rowNumber}`),
        messageId: messageId
      };
      var message = `✅ *Marked ${action}*

${messageText}`;
      sendTelegramMessage(chatId, message, options);

      // Acknowledge callback to Telegram
      answerCallbackQuery(callbackQueryId);
    }
  }
}

// function getSplitMessage()

function getTransactionMessage(transactionDetails, user) {
  // Escape all transaction details
  var amount = escapeMarkdown(transactionDetails.amount);
  var date = escapeMarkdown(transactionDetails.transaction_date);
  var merchant = escapeMarkdown(transactionDetails.merchant);
  var category = escapeMarkdown(transactionDetails.category);
  var userEscaped = escapeMarkdown(user);

  var message = `💸 *INR ${amount} ${transactionDetails.transaction_type}ed* :
🗓 *Date:* ${date}
🏪 *Merchant:* ${merchant}
${category ? `📂 *Category:* ${category}\n` : ""}
👤 *By:* ${userEscaped}

`;

  return message;
}


function sendTransactionMessage(transactionDetails, rowNumber, user) {

  var message = getTransactionMessage(transactionDetails, user);

  var reply_markup = getReplyMarkup("✂️ Want to split ?", `split_${rowNumber}`);
  var options = {
    parseMode: "Markdown",
    replyMarkup: reply_markup
  };
  sendTelegramMessage(CHAT_ID, message, options);
  console.log("Telegram message sent successfully.");
}

function getPromptforGemini(emailText) {
  promptText = `Extract structured transaction details from this email in JSON format with fields: 
- transaction_date (YYYY-MM-DD)
- merchant
- amount (only numeric, no currency symbols)
- category (if possible)
- transaction_type (Debit or Credit based on email content)

Rules for transaction_type:
- If money is spent (e.g., purchase, bill payment), mark it as "Debit".
- If money is received (e.g., refund, salary, cashback), mark it as "Credit".

Example JSON Output:
{
  "transaction_date": "2025-03-15",
  "merchant": "Amazon",
  "amount": 1500.00,
  "category": "Shopping",
  "transaction_type": "Debit"
}

Here is the email content:
${emailText}`;
  return promptText;
}



function extractTransactionsWithGemini() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  var search_query = BACKFILL_FROM ? `label:${GMAIL_LABEL} after:${BACKFILL_FROM}` : `label:${GMAIL_LABEL} newer_than:${MAILS_LOOKBACK_PERIOD}`;
  var threads = GmailApp.search(search_query);
  var userEmail = Session.getActiveUser().getEmail();

  // Add headers if the sheet is empty
  if (sheet.getLastRow() === 0) {
    appendRowToGoogleSheet(SHEET_ID, ["Email Date", "Transaction Date", "Merchant", "Amount", "Category", "Transaction Type", "User", "Split"]);
    console.log("Headers added to the sheet.");
  }

  threads.reverse();

  threads.forEach(thread => {
    var messages = thread.getMessages();
    messages.forEach(message => {
      var emailText = message.getPlainBody();
      var emailDate = message.getDate();

      var payload = {
        contents: [{
          role: "user",
          parts: [{
            text: getPromptforGemini(emailText),
          }]
        }]
      };

      var response = sendRequest(GEMINI_BASE_URL + "?key=" + GEMINI_API_KEY, "post", payload);
      var json = JSON.parse(response.getContentText());

      if (json.candidates && json.candidates.length > 0) {
        var extractedText = json.candidates[0].content.parts[0].text;

        try {
          if (extractedText.startsWith("```json") && extractedText.endsWith("```")) {
            extractedText = extractedText.replace(/```json|```/g, '').trim();
          }
          var transactionData = JSON.parse(extractedText);

          var transactionDate = transactionData.transaction_date || "N/A";
          var merchant = transactionData.merchant || "Unknown";
          var amount = transactionData.amount || 0;
          var category = transactionData.category || "Uncategorized";
          var transactionType = transactionData.transaction_type || "Unknown";  // Debit or Credit
          var user = userEmail.split("@")[0];
          var split = "personal";

          // Append structured data to the sheet
          appendRowToGoogleSheet(SHEET_ID, [emailDate, transactionDate, merchant, amount, category, transactionType, user, split]);

          var rowNumber = sheet.getLastRow();

          // Send Telegram message with the row number
          sendTransactionMessage(transactionData, rowNumber, user);
        } catch (e) {
          console.log("Extracted text from Gemini response: \n" + extractedText);
          console.log("Failed to parse Gemini response JSON: " + e);
        }
      }
    });
  });

  console.log("Transactions parsed and formatted successfully.");
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
  // Function for time based triggers
  function triggerEmailProcessing() {
    console.log("Triggered email processing started");
    extractTransactionsWithGemini();
    console.log("Triggered email processing completed");
  }

}
