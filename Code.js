// Webhook endpoint for the Telegram bot
// Store the update and process async to return 200 OK to Telegram immediately
function doPost(e) {
  try {
    var contents = e.postData.contents;
    console.log("Webhook data received, queuing for async processing");

    // Store update in cache to process async
    var cache = CacheService.getScriptCache();
    var updateId = JSON.parse(contents).update_id;

    // Dedup: skip if we already processed this update
    if (cache.get("processed_" + updateId)) {
      console.log("Skipping duplicate update_id:", updateId);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

    // Mark as processed (expires in 5 minutes)
    cache.put("processed_" + updateId, "1", 300);

    // Store the payload and schedule async processing
    var props = PropertiesService.getScriptProperties();
    props.setProperty("pending_update", contents);

    ScriptApp.newTrigger("processWebhookUpdate").timeBased().after(1000).create();
  } catch (error) {
    console.error("Error in doPost:", error.message);
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}

// Process the stored webhook update (runs async via trigger)
function processWebhookUpdate() {
  // Clean up this trigger
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "processWebhookUpdate") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  var props = PropertiesService.getScriptProperties();
  var contents = props.getProperty("pending_update");
  props.deleteProperty("pending_update");

  if (!contents) {
    console.log("processWebhookUpdate: no pending update found");
    return;
  }

  try {
    var update = JSON.parse(contents);
    console.log(
      "Processing update type:",
      update.callback_query ? "callback_query" : update.message ? "message" : "unknown"
    );

    if (update.callback_query) {
      handleCallbackQuery(update);
    } else if (update.message) {
      handleMessage(update);
    }
  } catch (error) {
    console.error("Error processing webhook update:", error.message, error.stack);
  }
}

// Function for time based triggers
function triggerEmailProcessing() {
  console.log("Triggered email processing started");
  extractTransactions();
  console.log("Triggered email processing completed");
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
