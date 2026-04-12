// Webhook endpoint for the Telegram bot
// Process most commands inline for instant responses; defer /backfill to async trigger
function doPost(e) {
  try {
    var contents = e.postData.contents;
    var update = JSON.parse(contents);

    // Check if this is a /backfill command — defer to async trigger
    var isBackfill =
      update.message && update.message.text && update.message.text.split("@")[0].toLowerCase().startsWith("/backfill");

    if (isBackfill) {
      // Send immediate acknowledgment
      var chatId = update.message.chat.id;
      sendTelegramMessage(chatId, "⏳ *Backfill started...* This may take a few minutes.");

      var props = PropertiesService.getScriptProperties();
      props.setProperty("pending_update", contents);
      ScriptApp.newTrigger("processWebhookUpdate").timeBased().after(1000).create();
    } else {
      if (update.callback_query) {
        handleCallbackQuery(update);
      } else if (update.message) {
        handleMessage(update);
      }
    }
  } catch (error) {
    console.error("Error in doPost:", error.message);
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}

// Process the stored webhook update (runs async via trigger, only for /backfill)
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
    return;
  }

  try {
    var update = JSON.parse(contents);
    if (update.message) {
      handleMessage(update);
    }
  } catch (error) {
    console.error("Error processing webhook update:", error.message, error.stack);
  }
}

// Function for time based triggers
function triggerEmailProcessing() {
  extractTransactions();
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
