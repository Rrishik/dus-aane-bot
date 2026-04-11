function getTransactionPrompt(email_text) {
  var prompt_text = `Extract structured transaction details from this email in JSON format with fields: 
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
${email_text}`;
  return prompt_text;
}

/**
 * Main function to orchestrate the email processing flow.
 */
function extractTransactions() {
  ensureSheetHeaders(SHEET_ID);

  var cutoffDate = getCutoffDate();
  console.log(`Processing messages after: ${cutoffDate.toString()}`);

  var messagesToProcess = fetchAndFilterMessages(cutoffDate);
  console.log(`Total emails to process: ${messagesToProcess.length}`);

  var userEmail = Session.getActiveUser().getEmail();

  messagesToProcess.forEach((message) => {
    processSingleEmail(message, userEmail);

    // Add a delay to prevent hitting API rate limits
    Utilities.sleep(2000);
  });

  console.log(`Transactions parsed and formatted successfully. Total emails processed: ${messagesToProcess.length}`);
}

/**
 * Calculates the cutoff date based on configuration.
 */
function getCutoffDate() {
  var cutoffDate = new Date();
  if (BACKFILL_FROM) {
    cutoffDate = new Date(BACKFILL_FROM);
  } else {
    // Parse lookback period (e.g., '1d', '1h')
    var value = parseInt(MAILS_LOOKBACK_PERIOD.slice(0, -1));
    var unit = MAILS_LOOKBACK_PERIOD.slice(-1);

    if (unit === "d") cutoffDate.setDate(cutoffDate.getDate() - value);
    else if (unit === "h") cutoffDate.setHours(cutoffDate.getHours() - value);
    else if (unit === "m") cutoffDate.setMinutes(cutoffDate.getMinutes() - value);
  }
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
  } else if (!BACKFILL_FROM) {
    // Use the simpler newer_than for the regular trigger flow
    query = `label:${GMAIL_LABEL} newer_than:${MAILS_LOOKBACK_PERIOD}`;
  }
  var threads = GmailApp.search(query).reverse();
  console.log(`Found ${threads.length} threads matching query: ${query}`);

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
function processSingleEmail(message, userEmail) {
  var emailText = message.getPlainBody();
  var emailDate = message.getDate();
  var messageId = message.getId();

  // Dedup: skip if this message was already processed
  if (findRowByColumnValue(SHEET_ID, MESSAGE_ID_COLUMN, messageId) > 0) {
    console.log("Skipping duplicate email, message ID: " + messageId);
    return { saved: false, duplicate: true, data: null };
  }

  try {
    var responseText = callAI(getTransactionPrompt(emailText));
    if (responseText) {
      return handleAIResponse(responseText, emailDate, userEmail, messageId);
    }
  } catch (e) {
    console.log("Error processing email: " + e.toString());
  }
  return { saved: false, duplicate: false, data: null };
}

/**
 * Handles the raw text response from the AI provider, attempts JSON parsing, and saves data.
 */
function handleAIResponse(rawText, emailDate, userEmail, messageId) {
  var cleanText = rawText;

  // Clean markdown code blocks
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/```json|```/g, "").trim();
  }

  try {
    if (cleanText.trim().startsWith("{")) {
      var data = JSON.parse(cleanText);
      saveTransaction(data, emailDate, userEmail, messageId);
      return { saved: true, duplicate: false, data: data };
    } else {
      console.log("AI response was not valid JSON. Response:\n" + rawText);
    }
  } catch (e) {
    console.log("Failed to parse AI JSON: " + e.message);
  }
  return { saved: false, duplicate: false, data: null };
}

/**
 * Saves the transaction structure to the sheet and sends a notification.
 */
function saveTransaction(data, emailDate, userEmail, messageId) {
  var transactionDate = data.transaction_date || "N/A";
  var merchant = data.merchant || "Unknown";
  var amount = data.amount || 0;
  var category = data.category || "Uncategorized";
  var type = data.transaction_type || "Unknown";
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
    messageId
  ]);

  console.log("Transaction saved with message ID:", messageId);
  sendTransactionMessage(data, messageId, user);
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
    "⏳ *Backfill in progress...*\nSearching for emails between " +
      Utilities.formatDate(startDate, Session.getScriptTimeZone(), "yyyy-MM-dd") +
      " and " +
      Utilities.formatDate(endDate, Session.getScriptTimeZone(), "yyyy-MM-dd")
  );

  var messagesToProcess = fetchAndFilterMessages(startDate, endDate);
  console.log("Backfill: found " + messagesToProcess.length + " emails");

  if (messagesToProcess.length === 0) {
    sendTelegramMessage(chatId, "📭 *No emails found* in the given date range.");
    return;
  }

  var userEmail = Session.getActiveUser().getEmail();
  var savedCount = 0;
  var duplicateCount = 0;
  var failedCount = 0;
  var totalAmount = 0;
  var categoryBreakdown = {};

  messagesToProcess.forEach((message) => {
    var result = processSingleEmail(message, userEmail);

    if (result.duplicate) {
      duplicateCount++;
    } else if (result.saved && result.data) {
      savedCount++;
      var amt = parseFloat(result.data.amount) || 0;
      totalAmount += amt;
      var cat = result.data.category || "Uncategorized";
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + amt;
    } else {
      failedCount++;
    }

    Utilities.sleep(2000);
  });

  // Build summary message
  var summary = "✅ *Backfill Complete*\n\n";
  summary += "📧 *Emails found:* " + messagesToProcess.length + "\n";
  summary += "💾 *Transactions saved:* " + savedCount + "\n";
  if (duplicateCount > 0) summary += "🔁 *Duplicates skipped:* " + duplicateCount + "\n";
  if (failedCount > 0) summary += "❌ *Failed:* " + failedCount + "\n";
  summary += "💰 *Total amount:* INR " + totalAmount.toFixed(2) + "\n";

  var categories = Object.keys(categoryBreakdown).sort(function (a, b) {
    return categoryBreakdown[b] - categoryBreakdown[a];
  });
  if (categories.length > 0) {
    summary += "\n📂 *Category breakdown:*\n";
    categories.forEach(function (cat) {
      summary += "• " + cat + ": INR " + categoryBreakdown[cat].toFixed(2) + "\n";
    });
  }

  sendTelegramMessage(chatId, summary);
}
