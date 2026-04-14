// Tool definition for extraction tool calling
var EXTRACTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_merchant_category",
      description:
        "Look up the default category for a merchant. Call this when you are unsure about the category for a merchant. Do NOT call for well-known merchants where the category is obvious (e.g., Amazon=Shopping, Swiggy=Food & Dining).",
      parameters: {
        type: "object",
        properties: {
          merchant: {
            type: "string",
            description: "The merchant name extracted from the email"
          }
        },
        required: ["merchant"]
      }
    }
  }
];

function getExtractionSystemPrompt() {
  var categoryList = CATEGORIES.join(", ");
  var creditCategoryList = CREDIT_CATEGORIES.join(", ");

  return (
    "You are a transaction extraction assistant. Extract structured transaction details from emails.\n\n" +
    "Return a JSON object with fields:\n" +
    "- transaction_date (YYYY-MM-DD)\n" +
    '- merchant (if identifiable; use empty string "" if generic bank alert with no merchant/payee)\n' +
    "- amount (numeric only, no currency symbols)\n" +
    "- currency (3-letter ISO code, default INR)\n" +
    "- category\n" +
    "- transaction_type (Debit or Credit)\n\n" +
    "Rules for transaction_type:\n" +
    '- Money spent (purchase, bill payment) = "Debit"\n' +
    '- Money received (refund, salary, cashback) = "Credit"\n\n' +
    "Rules for merchant:\n" +
    "- Extract the actual merchant/payee name, NOT the bank name\n" +
    '- Generic bank debit/credit alert with no merchant info = ""\n\n' +
    "Rules for category:\n" +
    "- Debit: must be one of: " +
    categoryList +
    "\n" +
    "- Credit: must be one of: " +
    creditCategoryList +
    "\n\n" +
    "If the email is NOT a transaction (surveys, OTPs, marketing, feedback, alerts with no monetary value), return:\n" +
    '{"not_a_transaction": true, "reason": "brief reason"}\n\n' +
    "Use the get_merchant_category tool ONLY when you are unsure about the category. " +
    "For well-known merchants (Amazon, Flipkart, Swiggy, Zomato, Uber, etc.) categorize directly."
  );
}

// Execute the get_merchant_category tool call
function executeExtractionTool(toolName, args, resolutions) {
  if (toolName === "get_merchant_category") {
    var result = lookupMerchantCategory(args.merchant, resolutions);
    if (result) {
      return JSON.stringify(result);
    }
    return JSON.stringify({
      merchant: args.merchant,
      category: null,
      message: "No mapping found, use your best guess"
    });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

/**
 * Main function to orchestrate the email processing flow.
 */
function extractTransactions() {
  ensureSheetHeaders(SHEET_ID);

  var cutoffDate = getCutoffDate();

  var messagesToProcess = fetchAndFilterMessages(cutoffDate);

  var userEmail = Session.getEffectiveUser().getEmail();
  var resolutions = getMerchantResolutions(SHEET_ID);

  messagesToProcess.forEach((message) => {
    processSingleEmail(message, userEmail, false, resolutions);

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
 * Processes a single email message: calls the AI provider with tool calling, parses response, saves to sheet.
 * Returns { saved: true/false, duplicate: true/false, data: parsed transaction or null }.
 */
function processSingleEmail(message, userEmail, silent, resolutions) {
  var emailText = message.getPlainBody();
  var emailDate = message.getDate();
  var messageId = message.getId();

  // Dedup: skip if this message was already processed
  if (findRowByColumnValue(SHEET_ID, MESSAGE_ID_COLUMN, messageId) > 0) {
    return { saved: false, duplicate: true, data: null };
  }

  try {
    var messages = [
      { role: "system", content: getExtractionSystemPrompt() },
      { role: "user", content: "Extract transaction details from this email:\n\n" + emailText }
    ];

    // Tool-calling loop (max 2 iterations: initial + one tool response)
    var maxIterations = 2;
    for (var iter = 0; iter < maxIterations; iter++) {
      var apiResponse = callAIWithTools(messages, EXTRACTION_TOOLS);
      if (!apiResponse) break;

      var choice = apiResponse.choices[0];
      var msg = choice.message;

      // If the model made a tool call, execute it and continue
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push(msg);
        for (var t = 0; t < msg.tool_calls.length; t++) {
          var tc = msg.tool_calls[t];
          var args = JSON.parse(tc.function.arguments);
          var toolResult = executeExtractionTool(tc.function.name, args, resolutions);
          messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
        }
        continue;
      }

      // No tool call — we have the final response
      if (msg.content) {
        var emailLink = "https://mail.google.com/mail/u/0/#all/" + messageId;
        return handleAIResponse(msg.content, emailDate, userEmail, messageId, emailLink, silent, resolutions);
      }
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
        var resolved = resolveMerchant(data.merchant, resolutions);
        data.merchant = resolved.merchant;
        // If tool call didn't set category but resolution has a default, use it
        if (resolved.category && (!data.category || data.category === "Uncategorized")) {
          data.category = resolved.category;
        }
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

    var result = processSingleEmail(messagesToProcess[i], userEmail, true, resolutions);
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
