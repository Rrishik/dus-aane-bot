function getPromptforGemini(email_text) {
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
function extractTransactionsWithGemini() {
  ensureSheetHeaders(SHEET_ID);

  var cutoffDate = getCutoffDate();
  console.log(`Filtering messages older than: ${cutoffDate.toString()}`);

  var messagesToProcess = fetchAndFilterMessages(cutoffDate);
  console.log(`Total emails to process: ${messagesToProcess.length}`);

  var processedCount = 0;
  var userEmail = Session.getActiveUser().getEmail();

  messagesToProcess.forEach(message => {
    processSingleEmail(message, userEmail);
    processedCount++;

    // Add a delay to prevent hitting API rate limits (15 RPM for Gemini Free Tier)
    Utilities.sleep(5000);
  });

  console.log(`Transactions parsed and formatted successfully. Total emails processed: ${processedCount}`);
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

    if (unit === 'd') cutoffDate.setDate(cutoffDate.getDate() - value);
    else if (unit === 'h') cutoffDate.setHours(cutoffDate.getHours() - value);
    else if (unit === 'm') cutoffDate.setMinutes(cutoffDate.getMinutes() - value);
  }
  return cutoffDate;
}

/**
 * Fetches threads and filters individual messages by date.
 */
function fetchAndFilterMessages(cutoffDate) {
  var query = BACKFILL_FROM ? `label:${GMAIL_LABEL} after:${BACKFILL_FROM}` : `label:${GMAIL_LABEL} newer_than:${MAILS_LOOKBACK_PERIOD}`;
  var threads = GmailApp.search(query).reverse();
  console.log(`Found ${threads.length} threads matching query.`);

  var filteredMessages = [];
  threads.forEach(thread => {
    var messages = thread.getMessages();
    var validMessages = messages.filter(msg => msg.getDate() >= cutoffDate);
    filteredMessages = filteredMessages.concat(validMessages);
  });

  return filteredMessages;
}

/**
 * Processes a single email message: calls Gemini, parses response, saves to sheet, and notifies Telegram.
 */
function processSingleEmail(message, userEmail) {
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

  try {
    var response = sendRequest(GEMINI_BASE_URL + "?key=" + GEMINI_API_KEY, "post", payload);
    var jsonResponse = JSON.parse(response.getContentText());

    if (jsonResponse.candidates && jsonResponse.candidates.length > 0) {
      var contentText = jsonResponse.candidates[0].content.parts[0].text;
      handleGeminiResponse(contentText, emailDate, userEmail);
    } else {
      console.log("Gemini response did not contain candidates. Full response: " + JSON.stringify(jsonResponse));
    }
  } catch (e) {
    console.log("Error processing email: " + e.toString());
  }
}

/**
 * Handles the raw text response from Gemini, attempts JSON parsing, and saves data.
 */
function handleGeminiResponse(rawText, emailDate, userEmail) {
  var cleanText = rawText;

  // Clean markdown code blocks
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/```json|```/g, '').trim();
  }

  try {
    if (cleanText.trim().startsWith("{")) {
      var data = JSON.parse(cleanText);
      saveTransaction(data, emailDate, userEmail);
    } else {
      console.log("Gemini response was not valid JSON. Response:\n" + rawText);
    }
  } catch (e) {
    console.log("Failed to parse Gemini JSON: " + e.message);
  }
}

/**
 * Saves the transaction structure to the sheet and sends a notification.
 */
function saveTransaction(data, emailDate, userEmail) {
  var transactionDate = data.transaction_date || "N/A";
  var merchant = data.merchant || "Unknown";
  var amount = data.amount || 0;
  var category = data.category || "Uncategorized";
  var type = data.transaction_type || "Unknown";
  var user = userEmail.split("@")[0];
  var splitStatus = "personal";

  appendRowToGoogleSheet(SHEET_ID, [emailDate, transactionDate, merchant, amount, category, type, user, splitStatus]);

  // Get the row number after appending - open sheet once and get last row
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  var rowNumber = sheet.getLastRow(); // This should be the row we just appended
  
  // Validate row number
  if (rowNumber <= 1) {
    console.log("Warning: Invalid row number after append:", rowNumber);
    // If no valid row, don't send message with split button
    sendTransactionMessage(data, null, user);
    return;
  }

  console.log("Transaction saved to row:", rowNumber);
  sendTransactionMessage(data, rowNumber, user);
}
