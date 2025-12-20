// Webhook endpoint for the Telegram bot
// This function is triggered when a POST request is made to the script URL
function doPost(e) {
  try {
    console.log("Webhook data received:", e.postData.contents);
    var update = JSON.parse(e.postData.contents);
    console.log("Parsed update type:", update.callback_query ? "callback_query" : (update.message ? "message" : "unknown"));

    if (update.callback_query) {
      console.log("Processing callback query...");
      handleCallbackQuery(update);
      console.log("Callback processed!");
    } else if (update.message) {
      console.log("Processing message...");
      handleMessage(update);
      console.log("Message processed!");
    } else {
      console.log("Unknown update type:", JSON.stringify(update));
    }
    return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
  } catch (error) {
    console.error("Error in doPost:", error.message);
    console.error("Stack trace:", error.stack);
    return ContentService.createTextOutput("ERROR: " + error.message).setMimeType(ContentService.MimeType.TEXT);
  }
}

// Function for time based triggers
function triggerEmailProcessing() {
  console.log("Triggered email processing started");
  extractTransactionsWithGemini();
  console.log("Triggered email processing completed");
  testSplitTransactionUpdate(1296);
  console.log("Triggered split txn completed");
}

// Test function to manually test split transaction update
// Run this function from the Apps Script editor to test updating a specific row
function testSplitTransactionUpdate(testRowNumber) {
  // If no row number provided, use the last row
  if (!testRowNumber) {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    testRowNumber = sheet.getLastRow();
  }
  
  var result = updateGoogleSheetCellWithFeedback(SHEET_ID, testRowNumber, SPLIT_COLUMN, SPLIT_STATUS.SPLIT, "");
  
  // Send result to Telegram for visibility
  var message = "🧪 *Test Update Result*\n\n";
  message += "Row: " + testRowNumber + "\n";
  message += "Column: " + SPLIT_COLUMN + "\n";
  message += "Value: " + SPLIT_STATUS.SPLIT + "\n\n";
  message += result.success ? "✅ Success!" : "❌ Failed";
  message += "\n" + result.message;
  if (result.oldValue) message += "\nOld: " + result.oldValue;
  if (result.newValue) message += "\nNew: " + result.newValue;
  
  sendTelegramMessage(CHAT_ID, message);
  
  return result;
}
