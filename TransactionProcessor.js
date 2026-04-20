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
    "If the email is NOT a transaction (surveys, OTPs, marketing, feedback, declined transactions, alerts with no monetary value), return:\n" +
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
 *
 * Multi-tenant: each message is routed to the tenant whose registered forwarder
 * email matches the message's From: address. Unmatched messages are skipped
 * (logged but not processed).
 */
function extractTransactions() {
  var cutoffDate = getCutoffDate();

  var messagesToProcess = fetchAndFilterMessages(cutoffDate);

  var resolutions = getMerchantResolutions();
  var skipped = 0;

  messagesToProcess.forEach((message) => {
    var userEmail = extractForwarderEmail(message);
    if (!userEmail) {
      skipped++;
      console.log("[extractTransactions] No forwarder on " + message.getId() + "; skipping");
      return;
    }

    var tenant = findTenantByEmail(userEmail);
    if (!tenant) {
      // Maybe this is a pending tenant's first forward — provision + activate.
      tenant = activatePendingTenantForEmail(userEmail);
    }
    if (!tenant) {
      skipped++;
      console.log("[extractTransactions] No tenant for " + userEmail + "; skipping " + message.getId());
      return;
    }

    setCurrentTenant(tenant);
    try {
      ensureSheetHeaders();
      processSingleEmail(message, userEmail, false, resolutions);
    } finally {
      setCurrentTenant(null);
    }

    Utilities.sleep(500);
  });

  if (skipped > 0) {
    console.log("[extractTransactions] Skipped " + skipped + " messages with no matching tenant.");
  }
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
 * Checks whether a Gmail message should be skipped based on IGNORE_SENDERS /
 * IGNORE_SUBJECTS from Constants.js. Works on both direct bank emails (where
 * `from` is the bank) and on manually-forwarded emails (where `from` is the
 * forwarder but the subject typically still contains the original subject
 * prefixed with "Fwd:").
 *
 * Ignore tokens with spaces must be surrounded by double-quotes in Constants;
 * this function strips those quotes and does a case-insensitive substring match.
 */
function shouldIgnoreMessage(msg) {
  var fromHeader = (msg.getFrom() || "").toLowerCase();
  var subject = (msg.getSubject() || "").toLowerCase();

  function norm(token) {
    return token.replace(/^"|"$/g, "").toLowerCase();
  }

  for (var i = 0; i < IGNORE_SENDERS.length; i++) {
    if (fromHeader.indexOf(norm(IGNORE_SENDERS[i])) !== -1) return true;
  }
  for (var j = 0; j < IGNORE_SUBJECTS.length; j++) {
    if (subject.indexOf(norm(IGNORE_SUBJECTS[j])) !== -1) return true;
  }
  return false;
}

/**
 * Extracts the original sender's email from a forwarded message's body.
 * Gmail's forward preamble format: "---------- Forwarded message ---------\nFrom: Name <addr@x>\n..."
 * Returns the extracted address (lowercase) or null if no preamble is found.
 */
function extractForwardedFrom(msg) {
  try {
    var body = msg.getPlainBody() || "";
    var preamble = body.match(/Forwarded message[\s\S]{0,200}?From:\s*([^\r\n]+)/i);
    if (!preamble) return null;
    var line = preamble[1];
    var addrMatch = line.match(/<([^>]+)>/) || line.match(/([^\s<>]+@[^\s<>]+)/);
    return addrMatch ? addrMatch[1].toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Extracts the forwarder's (tenant's) email address from a message.
 *
 * Priority:
 *  1. Gmail filter auto-forward adds `X-Forwarded-For: <forwarder> <destination>`.
 *     We grab the first address. This is how auto-forwarded bank mail is routed
 *     to the correct tenant (the bank's From: header stays as the bank, so we
 *     can't use that).
 *  2. Manual forwards use Gmail's "---------- Forwarded message ----------" body
 *     preamble; those keep bank as the `extractForwardedFrom` fallback? No —
 *     for manual forwards, From: is the human forwarder directly, so we fall
 *     back to From: next.
 *  3. From: header as the final fallback (for historical/manually forwarded
 *     mail where From was rewritten to the human user).
 *
 * Returns lowercase email or null if nothing matches.
 */
function extractForwarderEmail(msg) {
  // 1. X-Forwarded-For header (auto-forward)
  try {
    var raw = msg.getRawContent() || "";
    // Only scan the header portion (stop at first blank line between headers and body).
    var headerEnd = raw.indexOf("\r\n\r\n");
    if (headerEnd === -1) headerEnd = raw.indexOf("\n\n");
    var headers = headerEnd !== -1 ? raw.substring(0, headerEnd) : raw;
    // Unfold continuation lines (RFC 5322 folded headers start with whitespace).
    headers = headers.replace(/\r?\n[ \t]+/g, " ");
    var m = headers.match(/^X-Forwarded-For:\s*([^\r\n]+)/im);
    if (m) {
      // Value looks like: "alice@gmail.com dusaanebot.inbox@gmail.com" (space-separated)
      var first = m[1].trim().split(/[\s,]+/)[0];
      if (first && first.indexOf("@") !== -1) return first.toLowerCase();
    }
  } catch (e) {
    console.error("[extractForwarderEmail] header parse failed:", e.message);
  }

  // 2. From: header (manual forwards rewrite this to the human user)
  var fromHeader = msg.getFrom() || "";
  var fromMatch = fromHeader.match(/<([^>]+)>/);
  var fromEmail = (fromMatch ? fromMatch[1] : fromHeader.trim()).toLowerCase();
  if (fromEmail && fromEmail.indexOf("@") !== -1) return fromEmail;

  return null;
}

/**
 * Checks whether the message's effective sender is from an allowed bank domain.
 * For direct emails, checks `getFrom()`. For forwarded emails (subject starts
 * with "Fwd:" or similar), falls back to the original sender parsed from the
 * forward preamble in the body.
 */
function isFromAllowedBank(msg) {
  var fromHeader = (msg.getFrom() || "").toLowerCase();
  for (var i = 0; i < BANK_FROM_DOMAINS.length; i++) {
    if (fromHeader.indexOf(BANK_FROM_DOMAINS[i].toLowerCase()) !== -1) return true;
  }
  // Not directly from a bank — check the forwarded preamble.
  var origFrom = extractForwardedFrom(msg);
  if (origFrom) {
    for (var j = 0; j < BANK_FROM_DOMAINS.length; j++) {
      if (origFrom.indexOf(BANK_FROM_DOMAINS[j].toLowerCase()) !== -1) return true;
    }
  }
  return false;
}

/**
 * Fetches threads and filters individual messages by date + sender/subject ignore lists.
 * Accepts a start date, and an optional end date for range queries.
 */
function fetchAndFilterMessages(startDate, endDate) {
  var query;
  if (endDate) {
    // Use Unix timestamps (seconds) for exact precision. Gmail's date-form `before:`
    // is exclusive of the given day's midnight, which drops messages on the end date.
    var afterSec = Math.floor(startDate.getTime() / 1000);
    var beforeSec = Math.floor(endDate.getTime() / 1000);
    query = `${GMAIL_SEARCH_QUERY} after:${afterSec} before:${beforeSec}`;
  } else {
    // Regular trigger flow: simple lookback window
    query = `${GMAIL_SEARCH_QUERY} newer_than:${MAILS_LOOKBACK_PERIOD}`;
  }
  var threads = GmailApp.search(query).reverse();

  var filteredMessages = [];
  threads.forEach((thread) => {
    var messages = thread.getMessages();
    var validMessages = messages.filter((msg) => {
      var msgDate = msg.getDate();
      if (msgDate < startDate) return false;
      if (endDate && msgDate > endDate) return false;
      if (!isFromAllowedBank(msg)) return false;
      if (shouldIgnoreMessage(msg)) return false;
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
  if (findRowByColumnValue(MESSAGE_ID_COLUMN, messageId) > 0) {
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
      var apiResponse = callAIWithTools(messages, EXTRACTION_TOOLS, 300);
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
    console.error("[processSingleEmail] Error:", e.message);
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
          var user = (userEmail || "").split("@")[0] || "unknown";
          var skipMsg =
            "ℹ️ *New email detected but skipped*\n" +
            "👤 *By:* " +
            escapeMarkdown(user) +
            "\n" +
            "Reason: " +
            reason +
            "\n" +
            "[View email](" +
            emailLink +
            ")";
          sendTelegramMessage(getTenantChatId(), skipMsg, { parse_mode: "Markdown" });
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
      // Register new merchant for resolution review (must run BEFORE the transaction message
      // so the inline keyboard can include a one-tap "Save mapping" button when applicable)
      var isNewMerchant = !!(rawMerchant && addNewMerchantIfNeeded(rawMerchant));
      saveTransaction(data, emailDate, userEmail, messageId, emailLink, silent, isNewMerchant);
      return { saved: true, duplicate: false, data: data };
    } else {
      // AI response was not valid JSON
    }
  } catch (e) {
    console.error("[handleAIResponse] JSON parse failed:", e.message);
  }
  return { saved: false, duplicate: false, data: null };
}

/**
 * Saves the transaction structure to the sheet and sends a notification.
 */
function saveTransaction(data, emailDate, userEmail, messageId, emailLink, silent, isNewMerchant) {
  var transactionDate = data.transaction_date || "N/A";
  var merchant = data.merchant || "Unknown";
  var amount = data.amount || 0;
  var category = data.category || "Uncategorized";
  var type = data.transaction_type || "Unknown";
  var currency = data.currency || "INR";
  var user = userEmail.split("@")[0];
  var splitStatus = SPLIT_STATUS.PERSONAL; // Default to Personal

  appendRowToGoogleSheet([
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
    sendTransactionMessage(data, messageId, user, isNewMerchant);
  }
}

/**
 * Backfill transactions for a date range with time-based execution limit.
 * Returns { savedCount, duplicateCount, failedCount, totalEmails, timedOut }
 */
function backfillTransactions(startDate, endDate, timeLimitMs, skipCount) {
  // Scope backfill to the current tenant only. If no tenant is in context,
  // fall back to whatever getSpreadsheet() resolves to (tenant 0 defaults).
  var tenant = getCurrentTenant();
  ensureSheetHeaders();

  var messagesToProcess = fetchAndFilterMessages(startDate, endDate);

  // If we have a tenant in context, restrict to messages forwarded by that
  // tenant's registered emails. Prevents cross-tenant contamination.
  if (tenant) {
    messagesToProcess = messagesToProcess.filter(function (m) {
      var userEmail = extractForwarderEmail(m);
      return userEmail && tenant.emails.indexOf(userEmail) !== -1;
    });
  }

  var resolutions = getMerchantResolutions();
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

    // Forwarder's email, extracted per-message (auto-forward headers first).
    var userEmail = extractForwarderEmail(messagesToProcess[i]) || "unknown";

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
