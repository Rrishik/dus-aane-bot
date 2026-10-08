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
// Tenant context: each chunk re-resolves the tenant from the per-chat state
// (see "Per-user backfill state" below).

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

// ─── Per-user backfill state ─────────────────────────────────────────
// One JSON property per chat (`backfill:<chatId>`) so two users can backfill
// at once. Each self-scheduled chunk trigger is mapped back to its chat via
// `backfill_trigger:<triggerUid>`.
var BACKFILL_STATE_PREFIX = "backfill:";
var BACKFILL_TRIGGER_PREFIX = "backfill_trigger:";
var BACKFILL_ACK_PREFIX = "backfill_ack:";
// A state untouched this long belongs to a crashed chain; a new /backfill
// may replace it.
var BACKFILL_STALE_MS = 30 * 60 * 1000;

function _loadBackfillState(chatId) {
  var raw = PropertiesService.getScriptProperties().getProperty(BACKFILL_STATE_PREFIX + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function _saveBackfillState(chatId, state) {
  state.updatedAt = Date.now();
  PropertiesService.getScriptProperties().setProperty(BACKFILL_STATE_PREFIX + chatId, JSON.stringify(state));
}

function _clearBackfillState(chatId) {
  PropertiesService.getScriptProperties().deleteProperty(BACKFILL_STATE_PREFIX + chatId);
}

// Remove the "⏳ Backfill started..." ack doPost posted before deferring.
function _deleteBackfillAck(chatId) {
  var props = PropertiesService.getScriptProperties();
  var ackMsgId = props.getProperty(BACKFILL_ACK_PREFIX + chatId);
  if (!ackMsgId) return;
  props.deleteProperty(BACKFILL_ACK_PREFIX + chatId);
  try {
    deleteTelegramMessage(chatId, parseInt(ackMsgId, 10));
  } catch (_) {}
}

function handleBackfillCommand(chatId, messageText) {
  var parsed = parseBackfillDuration(messageText);
  if (!parsed.ok) {
    _deleteBackfillAck(chatId);
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
  var running = _loadBackfillState(chatId);
  if (running && Date.now() - (running.updatedAt || 0) < BACKFILL_STALE_MS) {
    _deleteBackfillAck(chatId);
    sendTelegramMessage(chatId, "⏳ *A backfill is already running.* I'll post the summary when it finishes.");
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
  var chatId = String(getTenantChatId());
  _saveBackfillState(chatId, {
    start: Utilities.formatDate(startDate, tz, "yyyy-MM-dd'T'HH:mm:ss"),
    end: Utilities.formatDate(endDate, tz, "yyyy-MM-dd'T'HH:mm:ss"),
    saved: 0,
    dupes: 0,
    failed: 0,
    chunk: 1
  });

  // Pick format based on whether the range is sub-day (minute/hour) or multi-day.
  var spanMs = endDate.getTime() - startDate.getTime();
  var fmt = spanMs < 24 * 60 * 60 * 1000 ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd";
  var humanSpan = formatDurationMs(spanMs);

  sendTelegramMessage(
    chatId,
    "⏳ *Backfill started* _(" +
      humanSpan +
      ")_\n" +
      Utilities.formatDate(startDate, tz, fmt) +
      " → " +
      Utilities.formatDate(endDate, tz, fmt)
  );
  _deleteBackfillAck(chatId);

  continueBackfill(null, chatId);
}

// Time-based chunking: processes until ~5 min elapsed, then self-schedules
var BACKFILL_TIME_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

// Called inline by startChunkedBackfill (chatId given) or by a chunk
// trigger (event object; chat resolved from the trigger uid).
function continueBackfill(e, directChatId) {
  var props = PropertiesService.getScriptProperties();
  var chatId = directChatId || null;
  if (!chatId) {
    var uid = e && e.triggerUid;
    deleteOwnTrigger(uid, "continueBackfill");
    if (!uid) return;
    chatId = props.getProperty(BACKFILL_TRIGGER_PREFIX + uid);
    props.deleteProperty(BACKFILL_TRIGGER_PREFIX + uid);
    if (!chatId) return;
  }

  var t = findTenantByChatId(chatId);
  if (!isTenantUsable(t)) {
    console.warn("[continueBackfill] tenant gone or inactive for chat " + chatId + "; aborting backfill");
    _clearBackfillState(chatId);
    return;
  }
  setCurrentTenant(t);

  var state = _loadBackfillState(chatId);
  if (!state) return;

  // No skip count needed: fetchAndFilterMessages excludes label:processed-by-bot
  // server-side, so each chunk's fetch omits everything prior chunks handled.
  var result = backfillTransactions(new Date(state.start), new Date(state.end), BACKFILL_TIME_LIMIT_MS);
  state.saved += result.savedCount;
  state.dupes += result.duplicateCount;
  state.failed += result.failedCount;

  if (result.timedOut) {
    sendTelegramMessage(
      chatId,
      "⏳ *Backfill chunk " +
        state.chunk +
        " done*\n" +
        "💾 Saved so far: " +
        state.saved +
        "\n🔁 Dupes: " +
        state.dupes +
        "\n⏭ Continuing..."
    );
    state.chunk++;
    _saveBackfillState(chatId, state);
    var trigger = ScriptApp.newTrigger("continueBackfill").timeBased().after(10000).create();
    props.setProperty(BACKFILL_TRIGGER_PREFIX + trigger.getUniqueId(), chatId);
    return;
  }

  var summary = "✅ *Backfill Complete!*\n\n";
  summary += "📧 *Emails processed:* " + result.totalEmails + "\n";
  summary += "💾 *Transactions saved:* " + state.saved + "\n";
  if (state.dupes > 0) summary += "🔁 *Duplicates skipped:* " + state.dupes + "\n";
  if (state.failed > 0) summary += "❌ *Failed:* " + state.failed + "\n";
  if (state.chunk > 1) summary += "📦 *Chunks:* " + state.chunk + "\n";
  summary += "\n_Run_ `/sheet` _to inspect the rows._";

  sendTelegramMessage(chatId, summary, { parse_mode: "Markdown" });
  _clearBackfillState(chatId);
}
