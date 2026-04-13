// Webhook endpoint for the Telegram bot
// Process most commands inline for instant responses; defer /backfill to async trigger
function doPost(e) {
  try {
    var contents = e.postData.contents;
    var update = JSON.parse(contents);

    // Check if this is a /backfill or /ask command — defer to async trigger
    var commandText = update.message && update.message.text ? update.message.text.split("@")[0].toLowerCase() : "";
    var isDeferred = commandText.startsWith("/backfill") || commandText.startsWith("/ask");

    if (isDeferred) {
      var chatId = update.message.chat.id;
      if (commandText.startsWith("/backfill")) {
        var ackResp = sendTelegramMessage(chatId, "⏳ *Backfill started...* This may take a few minutes.");
        try {
          var parsedAck = JSON.parse(ackResp);
          if (parsedAck.result && parsedAck.result.message_id) {
            var propsAck = PropertiesService.getScriptProperties();
            propsAck.setProperty("backfill_ack_msg_id", parsedAck.result.message_id.toString());
            propsAck.setProperty("backfill_ack_chat_id", chatId.toString());
          }
        } catch (e) {
          // ignore
        }
      } else if (commandText.startsWith("/ask")) {
        // Send thinking message immediately and store its ID for later editing
        var thinkingResp = sendTelegramMessage(chatId, "🤔 _Thinking..._");
        try {
          var parsed = JSON.parse(thinkingResp);
          if (parsed.result && parsed.result.message_id) {
            var props2 = PropertiesService.getScriptProperties();
            props2.setProperty("ask_thinking_msg_id", parsed.result.message_id.toString());
          }
        } catch (e) {
          // ignore
        }
      }

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

// Process the stored webhook update (runs async via trigger, for /backfill and /ask)
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

// Run from Apps Script editor to backfill for the logged-in user's Gmail
function manualBackfill() {
  var startDate = new Date("2026-01-01");
  var endDate = new Date("2026-04-12");
  startChunkedBackfill(startDate, endDate);
}

// Shared entry point for chunked backfill (used by both /backfill and manualBackfill)
function startChunkedBackfill(startDate, endDate) {
  endDate.setHours(23, 59, 59, 999);
  var tz = Session.getScriptTimeZone();
  var props = PropertiesService.getScriptProperties();
  props.setProperty("backfill_start", Utilities.formatDate(startDate, tz, "yyyy-MM-dd"));
  props.setProperty("backfill_end", Utilities.formatDate(endDate, tz, "yyyy-MM-dd"));
  props.setProperty("backfill_total_saved", "0");
  props.setProperty("backfill_total_dupes", "0");
  props.setProperty("backfill_total_failed", "0");
  props.setProperty("backfill_total_processed", "0");
  props.setProperty("backfill_chunk", "1");

  sendTelegramMessage(
    CHAT_ID,
    "⏳ *Backfill started*\n" +
      Utilities.formatDate(startDate, tz, "yyyy-MM-dd") +
      " → " +
      Utilities.formatDate(endDate, tz, "yyyy-MM-dd")
  );

  // Delete the initial ack message from doPost
  var ackMsgId = props.getProperty("backfill_ack_msg_id");
  var ackChatId = props.getProperty("backfill_ack_chat_id");
  if (ackMsgId && ackChatId) {
    deleteTelegramMessage(ackChatId, parseInt(ackMsgId, 10));
    props.deleteProperty("backfill_ack_msg_id");
    props.deleteProperty("backfill_ack_chat_id");
  }

  continueBackfill();
}

// Time-based chunking: processes until ~5 min elapsed, then self-schedules
var BACKFILL_TIME_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

function continueBackfill() {
  // Clean up trigger that invoked this
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "continueBackfill") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  var props = PropertiesService.getScriptProperties();
  var startStr = props.getProperty("backfill_start");
  var endStr = props.getProperty("backfill_end");

  if (!startStr || !endStr) return;

  var start = new Date(startStr);
  var end = new Date(endStr);
  end.setHours(23, 59, 59, 999);

  var chunk = parseInt(props.getProperty("backfill_chunk") || "1", 10);
  var skipCount = parseInt(props.getProperty("backfill_total_processed") || "0", 10);

  // Run backfill with time limit, skipping already-processed emails
  var result = backfillTransactions(start, end, BACKFILL_TIME_LIMIT_MS, skipCount);

  // Accumulate totals
  var totalSaved = parseInt(props.getProperty("backfill_total_saved") || "0", 10) + result.savedCount;
  var totalDupes = parseInt(props.getProperty("backfill_total_dupes") || "0", 10) + result.duplicateCount;
  var totalFailed = parseInt(props.getProperty("backfill_total_failed") || "0", 10) + result.failedCount;

  var totalProcessed = parseInt(props.getProperty("backfill_total_processed") || "0", 10) + result.processedCount;

  props.setProperty("backfill_total_saved", totalSaved.toString());
  props.setProperty("backfill_total_dupes", totalDupes.toString());
  props.setProperty("backfill_total_failed", totalFailed.toString());
  props.setProperty("backfill_total_processed", totalProcessed.toString());

  if (result.timedOut) {
    // Send progress update
    props.setProperty("backfill_chunk", (chunk + 1).toString());
    sendTelegramMessage(
      CHAT_ID,
      "⏳ *Backfill chunk " +
        chunk +
        " done*\n" +
        "💾 Saved so far: " +
        totalSaved +
        "\n🔁 Dupes: " +
        totalDupes +
        "\n⏭ Continuing..."
    );
    ScriptApp.newTrigger("continueBackfill").timeBased().after(10000).create();
  } else {
    // All done — send final summary
    var summary = "✅ *Backfill Complete!*\n\n";
    summary += "📧 *Emails processed:* " + result.totalEmails + "\n";
    summary += "💾 *Transactions saved:* " + totalSaved + "\n";
    if (totalDupes > 0) summary += "🔁 *Duplicates skipped:* " + totalDupes + "\n";
    if (totalFailed > 0) summary += "❌ *Failed:* " + totalFailed + "\n";
    if (chunk > 1) summary += "📦 *Chunks:* " + chunk + "\n";

    var sheetUrl = "https://docs.google.com/spreadsheets/d/" + SHEET_ID;
    sendTelegramMessage(CHAT_ID, summary, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "📋 Open Sheet", url: sheetUrl }]]
      }
    });

    // Clean up props
    props.deleteProperty("backfill_start");
    props.deleteProperty("backfill_end");
    props.deleteProperty("backfill_total_saved");
    props.deleteProperty("backfill_total_dupes");
    props.deleteProperty("backfill_total_failed");
    props.deleteProperty("backfill_total_processed");
    props.deleteProperty("backfill_chunk");
  }
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
