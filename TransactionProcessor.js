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
