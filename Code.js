// HTTP GET endpoint for the script's web app. Currently used only for the
// forwarding-address verify click-link in the setup email. Anything else
// returns a generic 200 to keep curious crawlers quiet.
function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.action === "verify_forwarding") {
      return HtmlService.createHtmlOutput(handleVerifyForwardingClick(params)).setXFrameOptionsMode(
        HtmlService.XFrameOptionsMode.ALLOWALL
      );
    }
  } catch (err) {
    console.error("Error in doGet:", err.message, err.stack);
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}

// Webhook endpoint for the Telegram bot
// Process most commands inline for instant responses; defer /backfill to async trigger
function doPost(e) {
  try {
    var contents = e && e.postData ? e.postData.contents : "";
    var update = JSON.parse(contents);

    // Signed Worker actions carry their own HMAC (no ?k).
    if (isWorkerActionBody(update)) return handleWorkerAction(update);

    // The Worker forwards Telegram's verified updates with ?k=<secret>.
    // Anything else (someone POSTing to the public /exec URL) is dropped.
    var secret = getWebhookSecret();
    if (secret) {
      var provided = (e && e.parameter && e.parameter.k) || "";
      if (!_constantTimeEquals(String(provided), secret)) {
        console.warn("[doPost] rejected update with missing/invalid webhook secret");
        return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
      }
    } else {
      console.warn("[doPost] WEBHOOK_SECRET not configured — webhook auth is off");
    }

    // Resolve the incoming chat id (message or callback).
    var incomingChatId = null;
    if (update.message && update.message.chat) incomingChatId = update.message.chat.id;
    else if (update.callback_query && update.callback_query.message && update.callback_query.message.chat) {
      incomingChatId = update.callback_query.message.chat.id;
    }

    // Group lifecycle events. These don't carry a tenant context (the bot
    // may not even know about the chat yet), so dispatch before tenant
    // resolution and return.
    if (update.my_chat_member) {
      handleBotMembershipChange(update);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }
    if (update.chat_member) {
      handleChatMemberChange(update);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

    // Tenant resolution. Set context only for usable (active/dormant) tenants
    // — pending/disabled chats must NOT fall through to admin defaults
    // (would cross-tenant-leak).
    var incomingTenant = incomingChatId != null ? findTenantByChatId(incomingChatId) : null;
    var isActive = isTenantUsable(incomingTenant);
    if (isActive) setCurrentTenant(incomingTenant);

    // "📬 Resend setup" (on /account and nudges) must work for pending
    // tenants too — they're the ones who most need it.
    if (update.callback_query && update.callback_query.data === "resend_setup") {
      if (incomingTenant) handleResendSetupCallback(incomingChatId, update.callback_query.id);
      else answerCallbackQuery(update.callback_query.id, "Please /start to set up your account.", true);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

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
    // /backfill is the only deferred command — it runs in 5-minute chunks and
    // would easily exceed Telegram's 60s webhook budget. /ask used to defer
    // too, but it now runs inline: the round-trip is ~5-15s (sheet read + 1-3
    // LLM iterations) which is well under the limit, and skipping the trigger
    // queue saves the 1-30s schedule-wait that dominated /ask perceived
    // latency. A sendChatAction("typing") inside handleAskCommand replaces the
    // old "🤔 Thinking..." message.
    var isDeferred = commandText.startsWith("/backfill");

    // Deferred commands touch tenant data — only active tenants can use them.
    if (isDeferred && !isActive) {
      // Let handleMessage render the normal gate message.
      handleMessage(update);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

    if (isDeferred) {
      var chatId = update.message.chat.id;
      var props = PropertiesService.getScriptProperties();
      var ackMsgId = _parseSentMessageId(
        sendTelegramMessage(chatId, "⏳ *Backfill started...* This may take a few minutes.")
      );
      if (ackMsgId) props.setProperty("backfill_ack:" + chatId, String(ackMsgId));

      // Keyed by trigger id so concurrent users' deferred updates don't
      // overwrite each other.
      var trigger = ScriptApp.newTrigger("processWebhookUpdate").timeBased().after(1000).create();
      props.setProperty("pending_update:" + trigger.getUniqueId(), contents);
    } else if (update.message) {
      handleMessage(update);
    }
  } catch (error) {
    console.error("Error in doPost:", error.message);
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}

// Process a stored webhook update (runs async via a one-shot trigger, for /backfill)
function processWebhookUpdate(e) {
  var uid = e && e.triggerUid;
  deleteOwnTrigger(uid, "processWebhookUpdate");

  var props = PropertiesService.getScriptProperties();
  var key = uid ? "pending_update:" + uid : "pending_update";
  var contents = props.getProperty(key);
  props.deleteProperty(key);

  if (!contents) {
    return;
  }

  try {
    var update = JSON.parse(contents);
    // Re-resolve tenant context for this async execution.
    var chatId = update.message && update.message.chat ? update.message.chat.id : null;
    var t = chatId != null ? findTenantByChatId(chatId) : null;
    if (!isTenantUsable(t)) {
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

// One-shot time triggers stay listed (and count toward the 20-trigger cap)
// after firing. Delete only the trigger that invoked us so concurrent chains
// for other users survive; without a uid (manual run) fall back to all
// triggers for the handler.
function deleteOwnTrigger(uid, handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() !== handlerName) return;
    if (uid && trigger.getUniqueId() !== uid) return;
    ScriptApp.deleteTrigger(trigger);
  });
}

// Function for time based triggers
function triggerEmailProcessing() {
  extractTransactions();
}

// Run once from the script editor: replaces any existing email trigger with
// a 5-minute one. Each idle run is a single history.list call, well inside
// the consumer 90 min/day trigger-runtime quota.
function installEmailTrigger() {
  deleteOwnTrigger(null, "triggerEmailProcessing");
  ScriptApp.newTrigger("triggerEmailProcessing").timeBased().everyMinutes(5).create();
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
  if (isNativeMode()) return;
  var range = weekRangeFor(new Date());
  var tenants = loadTenants().filter(function (t) {
    // Personal tenants only. Group sheets use the β-schema (one row per
    // share) with different columns, so getAllTransactions reads garbage
    // off them — type, category, currency don't line up and every digest
    // came out as ₹0. Group digests need their own shape (settlement
    // balances per member), not category breakdowns. Build that
    // separately when needed.
    return t.status === TENANT_STATUS.ACTIVE && t.chat_type === TENANT_CHAT_TYPE.PERSONAL && t.sheet_id;
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
