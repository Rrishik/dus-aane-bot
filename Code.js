// Apps Script entry points. The bot itself runs on the Cloudflare Worker;
// this project only does what needs the bot's Google account:
//   doGet  — the forwarding-verify link in the setup email (Forwarding.js)
//   doPost — signed actions from the Worker (WorkerBridge.js)
//   triggerEmailProcessing — the 5-minute Gmail poller (Gmail.js)

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

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "null");
    if (isWorkerActionBody(body)) return handleWorkerAction(body);
  } catch (err) {
    console.error("Error in doPost:", err.message);
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
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

var LIVE_TRIGGER_HANDLERS = ["triggerEmailProcessing", "continueWorkerBackfill"];

// Remove triggers whose handler no longer exists (the weekly jobs moved to
// the Worker); they would otherwise fail on every run.
function pruneStaleTriggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (LIVE_TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) return;
    ScriptApp.deleteTrigger(trigger);
    removed++;
  });
  return removed;
}

var TRIGGERS_PRUNED_PROP = "triggers.prunedV1";

function triggerEmailProcessing() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(TRIGGERS_PRUNED_PROP)) {
    try {
      console.log("[triggers] removed " + pruneStaleTriggers() + " stale trigger(s)");
      props.setProperty(TRIGGERS_PRUNED_PROP, new Date().toISOString());
    } catch (e) {
      console.warn("[triggers] prune failed: " + e.message);
    }
  }
  extractTransactions();
}

// Run once from the script editor: replaces any existing email trigger with
// a 5-minute one. Each idle run is a single history.list call, well inside
// the consumer 90 min/day trigger-runtime quota.
function installEmailTrigger() {
  deleteOwnTrigger(null, "triggerEmailProcessing");
  ScriptApp.newTrigger("triggerEmailProcessing").timeBased().everyMinutes(5).create();
}
