// ─── /backfill command — orchestration & parsing ────────────────────
//
// User-facing command that re-walks Gmail for a date range and inserts any
// missing transactions. The actual Gmail walker lives in TransactionProcessor
// (`backfillTransactions`); this file owns:
//
//   - argument parsing (`parseBackfillDuration`)
//   - command handler (`handleBackfillCommand`)
//   - chunked execution + progress reporting (`startChunkedBackfill`,
//     `continueBackfill`) — self-reschedules every 5 minutes via time-based
//     triggers so a long backfill stays under the 6-min execution cap.
//
// Tenant context: `startChunkedBackfill` stashes the tenant chat_id in script
// properties so the async `continueBackfill` re-resolves the right tenant on
// each chunk.

// Backfill duration unit alias map (module-scope so it isn't rebuilt per call,
// and so tests can inspect it).
var BACKFILL_UNIT_MAP = {
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  h: "hour",
  hour: "hour",
  hours: "hour",
  d: "day",
  day: "day",
  days: "day",
  w: "week",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month"
};

var BACKFILL_USAGE_MSG =
  "❌ *Invalid format!*\n\n" +
  "Use: `/backfill 10m` or `/backfill 3 days` or `/backfill 2 weeks`\n" +
  "Or: `/backfill YYYY-MM-DD YYYY-MM-DD`";

// Pure parser for /backfill arguments. Pulled out for unit-testability.
//   Input:  messageText (the full command), optional `now` Date for tests.
//   Output: { ok:true, startDate, endDate } | { ok:false, error: 'usage' | 'unknown_unit' | 'invalid_dates' | 'invalid_range' }
//
// Supported forms:
//   /backfill 10m | 2h | 3d | 1w           (compact)
//   /backfill 10 min | 3 days | 2 weeks    (spaced)
//   /backfill YYYY-MM-DD YYYY-MM-DD        (absolute range)
function parseBackfillDuration(messageText, now) {
  var parts = (messageText || "").split(" ");
  if (parts.length < 2) return { ok: false, error: "usage" };

  var amount, unit;
  var compactMatch =
    parts[1] && parts[1].match(/^(\d+)(m|h|d|w|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months)$/i);
  if (compactMatch) {
    amount = parseInt(compactMatch[1], 10);
    unit = compactMatch[2].toLowerCase();
  } else {
    amount = parseInt(parts[1], 10);
    if (!isNaN(amount) && parts.length >= 3 && parts[1].indexOf("-") < 0) {
      unit = parts[2].toLowerCase();
    }
  }

  var startDate, endDate;
  if (unit) {
    var normalized = BACKFILL_UNIT_MAP[unit];
    if (!normalized) return { ok: false, error: "unknown_unit" };
    var nowMs = now ? now.getTime() : Date.now();
    endDate = new Date(nowMs);
    startDate = new Date(nowMs);
    if (normalized === "minute") startDate.setMinutes(startDate.getMinutes() - amount);
    else if (normalized === "hour") startDate.setHours(startDate.getHours() - amount);
    else if (normalized === "day") startDate.setDate(startDate.getDate() - amount);
    else if (normalized === "week") startDate.setDate(startDate.getDate() - amount * 7);
    else if (normalized === "month") startDate.setMonth(startDate.getMonth() - amount);
  } else if (parts.length >= 3) {
    startDate = new Date(parts[1]);
    endDate = new Date(parts[2]);
  } else {
    return { ok: false, error: "usage" };
  }

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { ok: false, error: "invalid_dates" };
  }
  if (startDate > endDate) return { ok: false, error: "invalid_range" };
  return { ok: true, startDate: startDate, endDate: endDate };
}

// Method to handle the /backfill command
function handleBackfillCommand(chatId, messageText) {
  var parsed = parseBackfillDuration(messageText);
  if (!parsed.ok) {
    if (parsed.error === "unknown_unit") {
      sendTelegramMessage(chatId, "❌ *Unknown unit!* Use `min`, `hour`, `day`, `week`, or `month`.");
    } else if (parsed.error === "invalid_dates") {
      sendTelegramMessage(
        chatId,
        "❌ *Invalid dates!* Use format YYYY-MM-DD\n\nExample: `/backfill 2026-03-01 2026-03-31`"
      );
    } else if (parsed.error === "invalid_range") {
      sendTelegramMessage(chatId, "❌ *Start date must be before end date.*");
    } else {
      sendTelegramMessage(chatId, BACKFILL_USAGE_MSG);
    }
    return;
  }
  startChunkedBackfill(parsed.startDate, parsed.endDate);
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
  // Persist tenant chat_id so the async continueBackfill can restore context.
  props.setProperty("backfill_tenant_chat_id", String(getTenantChatId()));

  // Pick format based on whether the range is sub-day (minute/hour) or multi-day.
  var spanMs = endDate.getTime() - startDate.getTime();
  var fmt = spanMs < 24 * 60 * 60 * 1000 ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd";
  var humanSpan = formatDurationMs(spanMs);

  sendTelegramMessage(
    getTenantChatId(),
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
  // Restore tenant context stashed by startChunkedBackfill.
  var savedChatId = props.getProperty("backfill_tenant_chat_id");
  if (savedChatId) {
    var t = findTenantByChatId(savedChatId);
    if (!t || t.status !== TENANT_STATUS.ACTIVE) {
      console.warn("[continueBackfill] tenant gone or inactive for chat " + savedChatId + "; aborting backfill");
      // Clean up so a stale backfill doesn't linger.
      props.deleteProperty("backfill_start");
      props.deleteProperty("backfill_end");
      props.deleteProperty("backfill_total_saved");
      props.deleteProperty("backfill_total_dupes");
      props.deleteProperty("backfill_total_failed");
      props.deleteProperty("backfill_total_processed");
      props.deleteProperty("backfill_chunk");
      props.deleteProperty("backfill_tenant_chat_id");
      return;
    }
    setCurrentTenant(t);
  }
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
      getTenantChatId(),
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

    var url = sheetUrl(getTenantSheetId());
    sendTelegramMessage(getTenantChatId(), summary, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "📋 Open Sheet", url: url }]]
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
    props.deleteProperty("backfill_tenant_chat_id");
  }
}
