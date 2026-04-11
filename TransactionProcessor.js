function getTransactionPrompt(email_text) {
  var prompt_text = `Extract structured transaction details from this email in JSON format with fields: 
- transaction_date (YYYY-MM-DD)
- merchant
- amount (only numeric, no currency symbols)
- currency (3-letter ISO code, e.g. INR, JPY, USD. Default to INR if unclear)
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
  "currency": "INR",
  "category": "Shopping",
  "transaction_type": "Debit"
}

Here is the email content:
${email_text}`;
  return prompt_text;
}

/**
 * Main function to orchestrate the email processing flow.
 */
function extractTransactions() {
  ensureSheetHeaders(SHEET_ID);

  var cutoffDate = getCutoffDate();

  var messagesToProcess = fetchAndFilterMessages(cutoffDate);

  var userEmail = Session.getEffectiveUser().getEmail();

  messagesToProcess.forEach((message) => {
    processSingleEmail(message, userEmail);

    // Add a delay to prevent hitting API rate limits
    Utilities.sleep(2000);
  });
}

/**
 * Calculates the cutoff date based on configuration.
 */
function getCutoffDate() {
  var cutoffDate = new Date();
  var value = parseInt(MAILS_LOOKBACK_PERIOD.slice(0, -1));
  var unit = MAILS_LOOKBACK_PERIOD.slice(-1);

  if (unit === "d") cutoffDate.setDate(cutoffDate.getDate() - value);
  else if (unit === "h") cutoffDate.setHours(cutoffDate.getHours() - value);
  else if (unit === "m") cutoffDate.setMinutes(cutoffDate.getMinutes() - value);

  return cutoffDate;
}

/**
 * Fetches threads and filters individual messages by date.
 * Accepts a start date, and an optional end date for range queries.
 */
function fetchAndFilterMessages(startDate, endDate) {
  var startStr = Utilities.formatDate(startDate, Session.getScriptTimeZone(), "yyyy/MM/dd");
  var query = `label:${GMAIL_LABEL} after:${startStr}`;
  if (endDate) {
    var endStr = Utilities.formatDate(endDate, Session.getScriptTimeZone(), "yyyy/MM/dd");
    query += ` before:${endStr}`;
  } else {
    // Use the simpler newer_than for the regular trigger flow
    query = `label:${GMAIL_LABEL} newer_than:${MAILS_LOOKBACK_PERIOD}`;
  }
  var threads = GmailApp.search(query).reverse();

  var filteredMessages = [];
  threads.forEach((thread) => {
    var messages = thread.getMessages();
    var validMessages = messages.filter((msg) => {
      var msgDate = msg.getDate();
      if (msgDate < startDate) return false;
      if (endDate && msgDate > endDate) return false;
      return true;
    });
    filteredMessages = filteredMessages.concat(validMessages);
  });

  return filteredMessages;
}

/**
 * Processes a single email message: calls the AI provider, parses response, saves to sheet, and notifies Telegram.
 * Returns { saved: true/false, duplicate: true/false, data: parsed transaction or null }.
 */
function processSingleEmail(message, userEmail, silent) {
  var emailText = message.getPlainBody();
  var emailDate = message.getDate();
  var messageId = message.getId();

  // Dedup: skip if this message was already processed
  if (findRowByColumnValue(SHEET_ID, MESSAGE_ID_COLUMN, messageId) > 0) {
    return { saved: false, duplicate: true, data: null };
  }

  try {
    var responseText = callAI(getTransactionPrompt(emailText));
    if (responseText) {
      return handleAIResponse(responseText, emailDate, userEmail, messageId, silent);
    }
  } catch (e) {
    // Error processing email
  }
  return { saved: false, duplicate: false, data: null };
}

/**
 * Handles the raw text response from the AI provider, attempts JSON parsing, and saves data.
 */
function handleAIResponse(rawText, emailDate, userEmail, messageId, silent) {
  var cleanText = rawText;

  // Clean markdown code blocks
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/```json|```/g, "").trim();
  }

  try {
    if (cleanText.trim().startsWith("{")) {
      var data = JSON.parse(cleanText);
      saveTransaction(data, emailDate, userEmail, messageId, silent);
      return { saved: true, duplicate: false, data: data };
    } else {
      // AI response was not valid JSON
    }
  } catch (e) {
    // Failed to parse AI JSON
  }
  return { saved: false, duplicate: false, data: null };
}

/**
 * Saves the transaction structure to the sheet and sends a notification.
 */
function saveTransaction(data, emailDate, userEmail, messageId, silent) {
  var transactionDate = data.transaction_date || "N/A";
  var merchant = data.merchant || "Unknown";
  var amount = data.amount || 0;
  var category = data.category || "Uncategorized";
  var type = data.transaction_type || "Unknown";
  var currency = data.currency || "INR";
  var user = userEmail.split("@")[0];
  var splitStatus = SPLIT_STATUS.PERSONAL; // Default to Personal

  appendRowToGoogleSheet(SHEET_ID, [
    emailDate,
    transactionDate,
    merchant,
    amount,
    category,
    type,
    user,
    splitStatus,
    messageId,
    currency
  ]);

  if (!silent) {
    sendTransactionMessage(data, messageId, user);
  }
}

/**
 * Backfill transactions for a date range. Called from the /backfill Telegram command.
 * Sends a progress message, processes emails, then edits it with a summary.
 */
function backfillTransactions(chatId, startDate, endDate) {
  ensureSheetHeaders(SHEET_ID);

  // Send initial progress message
  sendTelegramMessage(
    chatId,
    `⏳ *Backfill in progress...*\nSearching for emails between ${Utilities.formatDate(startDate, Session.getScriptTimeZone(), "yyyy-MM-dd")} and ${Utilities.formatDate(endDate, Session.getScriptTimeZone(), "yyyy-MM-dd")}`
  );

  var messagesToProcess = fetchAndFilterMessages(startDate, endDate);

  if (messagesToProcess.length === 0) {
    sendTelegramMessage(chatId, "📭 *No emails found* in the given date range.");
    return;
  }

  var userEmail = Session.getEffectiveUser().getEmail();
  var savedCount = 0;
  var duplicateCount = 0;
  var failedCount = 0;
  var spentByCurrency = {};
  var receivedByCurrency = {};
  var categoryBreakdown = {};

  messagesToProcess.forEach((message) => {
    var result = processSingleEmail(message, userEmail, true);

    if (result.duplicate) {
      duplicateCount++;
    } else if (result.saved && result.data) {
      savedCount++;
      var amt = parseFloat(result.data.amount) || 0;
      var cur = result.data.currency || "INR";
      var type = result.data.transaction_type || "Debit";

      if (type === "Credit") {
        receivedByCurrency[cur] = (receivedByCurrency[cur] || 0) + amt;
      } else {
        spentByCurrency[cur] = (spentByCurrency[cur] || 0) + amt;
        var cat = result.data.category || "Uncategorized";
        var catKey = cat + "|||" + cur;
        categoryBreakdown[catKey] = (categoryBreakdown[catKey] || 0) + amt;
      }
    } else {
      failedCount++;
    }

    Utilities.sleep(2000);
  });

  var summary = `✅ *Backfill Complete*\n\n`;
  summary += `📧 *Emails found:* ${messagesToProcess.length}\n`;
  summary += `💾 *Transactions saved:* ${savedCount}\n`;
  if (duplicateCount > 0) summary += `🔁 *Duplicates skipped:* ${duplicateCount}\n`;
  if (failedCount > 0) summary += `❌ *Failed:* ${failedCount}\n`;

  var spentCurrencies = Object.keys(spentByCurrency);
  if (spentCurrencies.length === 1) {
    summary += `💰 *Total Spent:* ${spentCurrencies[0]} ${spentByCurrency[spentCurrencies[0]].toFixed(2)}\n`;
  } else if (spentCurrencies.length > 1) {
    summary += `💰 *Total Spent:*\n`;
    spentCurrencies.forEach(function (cur) {
      summary += `  • ${cur} ${spentByCurrency[cur].toFixed(2)}\n`;
    });
  }

  var receivedCurrencies = Object.keys(receivedByCurrency);
  if (receivedCurrencies.length === 1) {
    summary += `💵 *Total Received:* ${receivedCurrencies[0]} ${receivedByCurrency[receivedCurrencies[0]].toFixed(2)}\n`;
  } else if (receivedCurrencies.length > 1) {
    summary += `💵 *Total Received:*\n`;
    receivedCurrencies.forEach(function (cur) {
      summary += `  • ${cur} ${receivedByCurrency[cur].toFixed(2)}\n`;
    });
  }

  var catKeys = Object.keys(categoryBreakdown).sort(function (a, b) {
    return categoryBreakdown[b] - categoryBreakdown[a];
  });
  if (catKeys.length > 0) {
    summary += `\n📂 *Category breakdown:*\n`;
    catKeys.forEach(function (catKey) {
      var parts = catKey.split("|||");
      var cat = parts[0];
      var cur = parts[1];
      summary += `• ${cat}: ${cur} ${categoryBreakdown[catKey].toFixed(2)}\n`;
    });
  }

  sendTelegramMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: buildReplyMarkup(
      "📋 Show Details",
      `details_${Utilities.formatDate(startDate, Session.getScriptTimeZone(), "yyyy-MM-dd")}_${Utilities.formatDate(endDate, Session.getScriptTimeZone(), "yyyy-MM-dd")}`
    )
  });
}
