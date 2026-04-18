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
          console.error("Backfill ack parse error:", e);
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
          console.error("Ask thinking msg parse error:", e);
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

// Shared entry point for chunked backfill (used by /backfill command)
function startChunkedBackfill(startDate, endDate) {
  // For day-granular backfills (endDate set to 00:00 of some day), extend to end-of-day.
  // For sub-day backfills (e.g. /backfill 10m), endDate already carries the intended time.
  var isMidnight =
    endDate.getHours() === 0 &&
    endDate.getMinutes() === 0 &&
    endDate.getSeconds() === 0 &&
    endDate.getMilliseconds() === 0;
  if (isMidnight) {
    endDate.setHours(23, 59, 59, 999);
  }
  var tz = Session.getScriptTimeZone();
  var props = PropertiesService.getScriptProperties();
  props.setProperty("backfill_start", Utilities.formatDate(startDate, tz, "yyyy-MM-dd'T'HH:mm:ss"));
  props.setProperty("backfill_end", Utilities.formatDate(endDate, tz, "yyyy-MM-dd'T'HH:mm:ss"));
  props.setProperty("backfill_total_saved", "0");
  props.setProperty("backfill_total_dupes", "0");
  props.setProperty("backfill_total_failed", "0");
  props.setProperty("backfill_total_processed", "0");
  props.setProperty("backfill_chunk", "1");

  // Pick format based on whether the range is sub-day (minute/hour) or multi-day.
  var spanMs = endDate.getTime() - startDate.getTime();
  var fmt = spanMs < 24 * 60 * 60 * 1000 ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd";
  var humanSpan = formatDurationMs(spanMs);

  sendTelegramMessage(
    CHAT_ID,
    "⏳ *Backfill started* _(" +
      humanSpan +
      ")_\n" +
      Utilities.formatDate(startDate, tz, fmt) +
      " → " +
      Utilities.formatDate(endDate, tz, fmt)
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
  // Only extend to end-of-day if the stored end is at midnight (multi-day backfill).
  // For sub-day backfills (e.g. /backfill 10m) the exact time was preserved and must be respected.
  var isMidnight =
    end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0;
  if (isMidnight) {
    end.setHours(23, 59, 59, 999);
  }

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

// Human-readable duration formatter: 90000 → "1m 30s", 3660000 → "1h 1m", 90061000 → "1d 1h".
function formatDurationMs(ms) {
  if (!ms || ms < 0) return "0s";
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400);
  s -= d * 86400;
  var h = Math.floor(s / 3600);
  s -= h * 3600;
  var m = Math.floor(s / 60);
  s -= m * 60;
  var parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  if (s && parts.length === 0) parts.push(s + "s"); // only show seconds for very short spans
  return parts.length ? parts.join(" ") : "<1m";
}
