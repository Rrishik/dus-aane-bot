// Webhook endpoint for the Telegram bot
// Process most commands inline for instant responses; defer /backfill to async trigger
function doPost(e) {
  try {
    var contents = e.postData.contents;
    var update = JSON.parse(contents);

    // Resolve the incoming chat id (message or callback).
    var incomingChatId = null;
    if (update.message && update.message.chat) incomingChatId = update.message.chat.id;
    else if (update.callback_query && update.callback_query.message && update.callback_query.message.chat) {
      incomingChatId = update.callback_query.message.chat.id;
    }

    // Tenant resolution. Set context only for active tenants — pending/disabled
    // chats must NOT fall through to admin defaults (would cross-tenant-leak).
    var incomingTenant = incomingChatId != null ? findTenantByChatId(incomingChatId) : null;
    var isActive = incomingTenant && incomingTenant.status === TENANT_STATUS.ACTIVE;
    if (isActive) setCurrentTenant(incomingTenant);

    // Callbacks (inline button taps) require an active tenant — anything else
    // would hit admin data via the fallback accessors. Silently drop them.
    if (update.callback_query) {
      if (!isActive) {
        try {
          answerCallbackQuery(update.callback_query.id, "Please /start to set up your account.", true);
        } catch (_) {}
        return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
      }
      handleCallbackQuery(update);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

    // Text messages: onboarding commands are allowed for unknown/pending chats;
    // all other commands are gated inside handleMessage via gateTenantForCommand.
    var commandText = update.message && update.message.text ? update.message.text.split("@")[0].toLowerCase() : "";
    var isDeferred = commandText.startsWith("/backfill") || commandText.startsWith("/ask");

    // Deferred commands touch tenant data — only active tenants can use them.
    if (isDeferred && !isActive) {
      // Let handleMessage render the normal gate message.
      handleMessage(update);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

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
    } else if (update.message) {
      handleMessage(update);
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
    // Re-resolve tenant context for this async execution.
    var chatId = update.message && update.message.chat ? update.message.chat.id : null;
    var t = chatId != null ? findTenantByChatId(chatId) : null;
    if (!t || t.status !== TENANT_STATUS.ACTIVE) {
      console.warn("[processWebhookUpdate] skipping — no active tenant for chat " + chatId);
      return;
    }
    setCurrentTenant(t);
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

// ─── Weekly Summary ─────────────────────────────────────────────────────────────
//
// Time-based trigger handler. Runs once per week (Friday morning) and walks
// every active tenant sequentially, sending a digest of the prior 7 days
// (rolling, ending yesterday). Skips tenants with no transactions in that
// window. One trigger drives all tenants — install manually from the Apps
// Script console (Triggers panel → Add Trigger → function:
// sendWeeklySummaries, event: time-driven, week timer, Friday, 8–9am).
function sendWeeklySummaries() {
  var range = weekRangeFor(new Date());
  var tenants = loadTenants().filter(function (t) {
    return t.status === TENANT_STATUS.ACTIVE && t.sheet_id;
  });

  var sentCount = 0;
  var skipCount = 0;
  var failCount = 0;

  tenants.forEach(function (t) {
    try {
      setCurrentTenant(t);
      var data = getWeeklyAnalytics(range.start, range.end);
      if (!data) {
        skipCount++;
        return;
      }
      var msg = formatWeeklyMessage(range, data);
      sendTelegramMessage(t.chat_id, msg, { parse_mode: "Markdown" });
      sentCount++;
    } catch (e) {
      failCount++;
      console.error("[sendWeeklySummaries] tenant " + t.chat_id + ": " + e.message);
    } finally {
      setCurrentTenant(null);
    }
  });

  console.log("[sendWeeklySummaries] sent=" + sentCount + " skipped=" + skipCount + " failed=" + failCount);
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
