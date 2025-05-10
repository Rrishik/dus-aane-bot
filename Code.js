// Webhook endpoint for the Telegram bot
// This function is triggered when a POST request is made to the script URL
function doPost(e) {
  console.log("Webhook data received:", e.postData.contents);
  var update = JSON.parse(e.postData.contents);
  
  if (update.callback_query) {
    handleCallbackQuery(update); // Keep as is, `update` is a common name for the whole object
    console.log("Callback processed!");
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}


// Method to handle the callback queries sent from the Telegram message reply buttons.
function handleCallbackQuery(update) {
  if (update.callback_query) {
    var callback_query_id = update.callback_query.id;
    var chat_id = update.callback_query.message.chat.id;
    var message_id = update.callback_query.message.message_id;
    var message_text = update.callback_query.message.text;
    var data = update.callback_query.data; // Example: "personal_5" or "split_8"
    console.log([chat_id, message_id, data]);
    if (data) {
      var action = data.split("_")[0]; // "personal" or "split"
      var toggle_action = action === "personal" ? "split" : "personal"; // Toggle between personal and split
      var row_number = parseInt(data.split("_")[1]); // Extract row number

      // Update the existing row in Google Sheets
      updateGoogleSheetCell(SHEET_ID, row_number, SPLIT_COLUMN, action === "personal" ? "Personal" : "Split");

      var options = {
        parse_mode: "Markdown", // Changed from parseMode
        reply_markup: getReplyMarkup(`🔄 Update to ${toggle_action}`, `${toggle_action}_${row_number}`), // Changed from replyMarkup
        message_id: message_id // Changed from messageId
      };
      var message = `✅ *Marked ${action}*

${message_text}`;
      sendTelegramMessage(chat_id, message, options);

      // Acknowledge callback to Telegram
      answerCallbackQuery(callback_query_id);
    }
  }
}


function getTransactionMessageAsString(transaction_details, user) {
  // Escape all transaction details
  var amount = escapeMarkdown(transaction_details.amount);
  var date = escapeMarkdown(transaction_details.transaction_date);
  var merchant = escapeMarkdown(transaction_details.merchant);
  var category = escapeMarkdown(transaction_details.category);
  var user_escaped = escapeMarkdown(user);

  var message = `💸 *INR ${amount} ${transaction_details.transaction_type}ed* :
🗓 *Date:* ${date}
🏪 *Merchant:* ${merchant}
${category ? `📂 *Category:* ${category}\n` : ""}
👤 *By:* ${user_escaped}

`;
  return message;
}


function sendTransactionMessage(transaction_details, row_number, user) {
  var message = getTransactionMessageAsString(transaction_details, user);
  var reply_markup_data = getReplyMarkup("✂️ Want to split ?", `split_${row_number}`);
  var options = {
    parse_mode: "Markdown",    // Changed from parseMode
    reply_markup: reply_markup_data // Changed from replyMarkup
  };
  sendTelegramMessage(CHAT_ID, message, options);
  console.log("Telegram message sent successfully.");
}

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


function extractTransactionsWithGemini() {
  var sheet = SpreadsheetApp.openById(SHEET_ID);
  var gmail_search_query = BACKFILL_FROM ? `label:${GMAIL_LABEL} after:${BACKFILL_FROM}` : `label:${GMAIL_LABEL} newer_than:${MAILS_LOOKBACK_PERIOD}`;
  var gmail_search_results = GmailApp.search(gmail_search_query).reverse();
  var user_email = Session.getActiveUser().getEmail();

  // Add headers if the sheet is empty
  ensureSheetHeaders(SHEET_ID);

  gmail_search_results.forEach(thread => {
    var messages = thread.getMessages();
    messages.forEach(message_item => { // Renamed message to message_item to avoid conflict with outer scope 'message' variable if any
      var email_text = message_item.getPlainBody();
      var email_date = message_item.getDate();

      var payload = {
        contents: [{
          role: "user",
          parts: [{ 
            text: getPromptforGemini(email_text),
          }]
        }]
      };

      var response = sendRequest(GEMINI_BASE_URL + "?key=" + GEMINI_API_KEY, "post", payload);
      var json_response = JSON.parse(response.getContentText()); // Renamed json to json_response

      if (json_response.candidates && json_response.candidates.length > 0 && json_response.candidates[0].content && json_response.candidates[0].content.parts && json_response.candidates[0].content.parts.length > 0) {
        var extracted_text = json_response.candidates[0].content.parts[0].text;
        
        try {
          let processed_text = extracted_text; 

          if (typeof processed_text !== 'string') {
            console.log("Error: extracted_text from Gemini is not a string. Value:", processed_text);
            return; 
          }

          if (processed_text.startsWith("```json") && processed_text.endsWith("```")) {
            processed_text = processed_text.replace(/```json|```/g, '').trim();
          }

          if (processed_text.trim().startsWith("{") && processed_text.trim().endsWith("}")) {
            var transaction_data = JSON.parse(processed_text);

            var transaction_date = transaction_data.transaction_date || "N/A";
            var merchant = transaction_data.merchant || "Unknown";
            var amount = transaction_data.amount || 0;
            var category = transaction_data.category || "Uncategorized";
            var transaction_type = transaction_data.transaction_type || "Unknown";
            var user = user_email.split("@")[0];
            var split_status = "personal"; // Renamed split to split_status

            appendRowToGoogleSheet(SHEET_ID, [email_date, transaction_date, merchant, amount, category, transaction_type, user, split_status]);

            var row_number = sheet.getLastRow(); 

            sendTransactionMessage(transaction_data, row_number, user);
          } else {
            console.log("Gemini response was not in the expected JSON format. Original response from Gemini: \n" + extracted_text);
            if (processed_text.toLowerCase().includes("no transaction details") ||
                processed_text.toLowerCase().includes("cannot provide a json output") ||
                processed_text.toLowerCase().includes("no transaction was found")) {
              console.log("Gemini explicitly stated no transaction details were found in the email.");
            }
          }
        } catch (e) {
          console.log("Failed to parse or process Gemini response. Original response from Gemini: \n" + extracted_text);
          console.log("Error details: " + e.toString() + (e.stack ? "\nStack: " + e.stack : ""));
        }
      } else {
        console.log("Gemini response did not contain candidates or parts. Full response: " + JSON.stringify(json_response));
      }
    });
  });
  
  console.log("Transactions parsed and formatted successfully.");
}


