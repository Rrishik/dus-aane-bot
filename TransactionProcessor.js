function getTransactionPrompt(email_text, overrides) {
  var categoryList = CATEGORIES.join(", ");
  var creditCategoryList = CREDIT_CATEGORIES.join(", ");

  var overrideHints = "";
  if (!overrides) overrides = getCategoryOverrides(SHEET_ID);
  var merchants = Object.keys(overrides);
  if (merchants.length > 0) {
    var lines = merchants.map(function (m) {
      var cats = overrides[m];
      var parts = Object.keys(cats)
        .sort(function (a, b) {
          return cats[b] - cats[a];
        })
        .map(function (c) {
          return c + " (" + cats[c] + "x)";
        });
      return "- " + m + ": " + parts.join(", ");
    });
    overrideHints =
      "\n\nPast category history per merchant (use as hints, but prioritize email content for the final decision):\n" +
      lines.join("\n") +
      "\n";
  }

  var prompt_text = `Extract structured transaction details from this email in JSON format with fields: 
- transaction_date (YYYY-MM-DD)
- merchant (if identifiable from the email; use empty string "" if the email is a generic bank alert without a specific merchant/payee)
- amount (only numeric, no currency symbols)
- currency (3-letter ISO code, e.g. INR, JPY, USD. Default to INR if unclear)
- category
- transaction_type (Debit or Credit based on email content)

Rules for transaction_type:
- If money is spent (e.g., purchase, bill payment), mark it as "Debit".
- If money is received (e.g., refund, salary, cashback), mark it as "Credit".

Rules for merchant:
- Extract the actual merchant/payee name, NOT the bank name
- If the email is a generic bank debit/credit alert with no merchant info, set merchant to ""

Rules for category:
- For Debit transactions, category must be one of: ${categoryList}
- For Credit transactions, category must be one of: ${creditCategoryList}

If the email is NOT a transaction (e.g., surveys, OTPs, marketing, feedback requests, account alerts with no monetary transaction), return:
{"not_a_transaction": true, "reason": "brief reason why"}
${overrideHints}
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
  var overrides = getCategoryOverrides(SHEET_ID);
  var resolutions = getMerchantResolutions(SHEET_ID);

  messagesToProcess.forEach((message) => {
    processSingleEmail(message, userEmail, false, overrides, resolutions);

    Utilities.sleep(500);
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
function processSingleEmail(message, userEmail, silent, overrides, resolutions) {
  var emailText = message.getPlainBody();
  var emailDate = message.getDate();
  var messageId = message.getId();

  // Dedup: skip if this message was already processed
  if (findRowByColumnValue(SHEET_ID, MESSAGE_ID_COLUMN, messageId) > 0) {
    return { saved: false, duplicate: true, data: null };
  }

  try {
    var responseText = callAI(getTransactionPrompt(emailText, overrides));
    if (responseText) {
      var emailLink = "https://mail.google.com/mail/u/0/#all/" + messageId;
      return handleAIResponse(responseText, emailDate, userEmail, messageId, emailLink, silent, resolutions);
    }
  } catch (e) {
    // Error processing email
  }
  return { saved: false, duplicate: false, data: null };
}

/**
 * Handles the raw text response from the AI provider, attempts JSON parsing, and saves data.
 */
function handleAIResponse(rawText, emailDate, userEmail, messageId, emailLink, silent, resolutions) {
  var cleanText = rawText;

  // Clean markdown code blocks
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/```json|```/g, "").trim();
  }

  try {
    if (cleanText.trim().startsWith("{")) {
      var data = JSON.parse(cleanText);
      // Skip non-transaction emails but notify via Telegram
      if (data.not_a_transaction) {
        if (!silent) {
          var reason = data.reason || "Not a transaction";
          var skipMsg =
            "ℹ️ *New email detected but skipped*\n" + "Reason: " + reason + "\n" + "[View email](" + emailLink + ")";
          sendTelegramMessage(CHAT_ID, skipMsg, { parse_mode: "Markdown" });
        }
        return { saved: false, duplicate: false, data: null };
      }
      // Resolve merchant name before saving
      var rawMerchant = data.merchant;
      if (data.merchant && resolutions) {
        data.merchant = resolveMerchant(data.merchant, resolutions);
      }
      saveTransaction(data, emailDate, userEmail, messageId, emailLink, silent);
      // Register new merchant for resolution review
      if (rawMerchant && addNewMerchantIfNeeded(SHEET_ID, rawMerchant) && !silent) {
        var sheetUrl = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/edit";
        var newMerchantMsg =
          "\uD83C\uDD95 New merchant detected: *" +
          escapeMarkdown(rawMerchant) +
          "*\n" +
          "[Add resolved name in sheet](" +
          sheetUrl +
          ")";
        sendTelegramMessage(CHAT_ID, newMerchantMsg, { parse_mode: "Markdown" });
      }
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
function saveTransaction(data, emailDate, userEmail, messageId, emailLink, silent) {
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
    currency,
    emailLink
  ]);

  if (!silent) {
    data.email_date = emailDate;
    sendTransactionMessage(data, messageId, user);
  }
}

/**
 * Backfill transactions for a date range with time-based execution limit.
 * Returns { savedCount, duplicateCount, failedCount, totalEmails, timedOut }
 */
function backfillTransactions(startDate, endDate, timeLimitMs, skipCount) {
  ensureSheetHeaders(SHEET_ID);

  var messagesToProcess = fetchAndFilterMessages(startDate, endDate);

  var userEmail = Session.getEffectiveUser().getEmail();
  var overrides = getCategoryOverrides(SHEET_ID);
  var resolutions = getMerchantResolutions(SHEET_ID);
  var savedCount = 0;
  var duplicateCount = 0;
  var failedCount = 0;
  var timedOut = false;
  var startTime = new Date().getTime();
  var startIndex = skipCount || 0;
  var processed = 0;

  for (var i = startIndex; i < messagesToProcess.length; i++) {
    // Check time limit before processing a non-trivial email
    if (timeLimitMs) {
      var elapsed = new Date().getTime() - startTime;
      if (elapsed > timeLimitMs) {
        timedOut = true;
        break;
      }
    }

    var result = processSingleEmail(messagesToProcess[i], userEmail, true, overrides, resolutions);
    processed++;

    if (result.duplicate) {
      duplicateCount++;
    } else if (result.saved && result.data) {
      savedCount++;
    } else {
      failedCount++;
    }

    if (!result.duplicate) {
      Utilities.sleep(500);
    }
  }

  return {
    savedCount: savedCount,
    duplicateCount: duplicateCount,
    failedCount: failedCount,
    totalEmails: messagesToProcess.length,
    processedCount: processed,
    timedOut: timedOut
  };
}
