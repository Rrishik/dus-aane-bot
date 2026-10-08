// Parser rollout controls + telemetry.
//
// Script properties (editable from the Apps Script console, no deploy):
//   parser.mode               "off" | "shadow" (default) | "on" — email path
//   parser.disabledTemplates  CSV of template ids routed back to the LLM
//
// Events go to a ParserEvents tab on the admin sheet. Only field *names* are
// logged, never amounts, merchants or message text; message_id leads back to
// the source when debugging. Logging never throws into the caller.

var PARSER_MODE_PROP = "parser.mode";
var PARSER_DISABLED_PROP = "parser.disabledTemplates";
var PARSER_EVENTS_TAB = "ParserEvents";
var PARSER_EVENTS_HEADERS = ["time", "chat_id", "channel", "template_id", "event", "fields_changed", "message_id"];
var PARSER_AUTO_DISABLE_ACCEPTED = 3;
var PARSER_AUTO_DISABLE_WINDOW_DAYS = 7;
var PARSER_EVENTS_SCAN_ROWS = 2000;

var PARSER_EVENT = {
  SAVED: "saved",
  SHADOW_MATCH: "shadow_match",
  SHADOW_MISMATCH: "shadow_mismatch",
  SHADOW_NOMATCH: "shadow_nomatch",
  SHADOW_EXTRA: "shadow_extra",
  REPARSE_REQUESTED: "reparse_requested",
  REPARSE_ACCEPTED: "reparse_accepted",
  REPARSE_KEPT: "reparse_kept_original",
  REPARSE_SAME: "reparse_same",
  REPORT: "report",
  AUTO_DISABLED: "auto_disabled"
};

function getParserMode() {
  var mode = PropertiesService.getScriptProperties().getProperty(PARSER_MODE_PROP);
  return mode === "off" || mode === "on" ? mode : "shadow";
}

function getDisabledParserTemplates() {
  var raw = PropertiesService.getScriptProperties().getProperty(PARSER_DISABLED_PROP) || "";
  return raw
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
}

function isParserTemplateDisabled(templateId) {
  return !!templateId && getDisabledParserTemplates().indexOf(templateId) !== -1;
}

function disableParserTemplate(templateId) {
  var list = getDisabledParserTemplates();
  if (!templateId || list.indexOf(templateId) !== -1) return false;
  list.push(templateId);
  PropertiesService.getScriptProperties().setProperty(PARSER_DISABLED_PROP, list.join(","));
  return true;
}

// Template id stored in PARSED_BY_COLUMN, without the Re-read marker.
function parserTemplateIdFrom(parsedBy) {
  return String(parsedBy || "").replace(REREAD_MARKER, "");
}

function _parserEventsTab() {
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var tab = ss.getSheetByName(PARSER_EVENTS_TAB);
  if (!tab) {
    tab = ss.insertSheet(PARSER_EVENTS_TAB);
    tab.appendRow(PARSER_EVENTS_HEADERS);
  }
  return tab;
}

// evt: { chatId, channel, templateId, event, fieldsChanged: string[], messageId }
function logParserEvent(evt) {
  try {
    _parserEventsTab().appendRow([
      new Date().toISOString(),
      String(evt.chatId || ""),
      evt.channel || "",
      evt.templateId || "",
      evt.event || "",
      (evt.fieldsChanged || []).join(","),
      evt.messageId || ""
    ]);
  } catch (e) {
    console.warn("[logParserEvent] " + e.message);
  }
}

function channelForMessageId(messageId) {
  return String(messageId || "").indexOf(SMS_ID_PREFIX) === 0 ? "sms" : "email";
}

function _recentParserEvents(sinceMs) {
  var tab = _parserEventsTab();
  var last = tab.getLastRow();
  if (last <= 1) return [];
  var start = Math.max(2, last - PARSER_EVENTS_SCAN_ROWS + 1);
  return tab
    .getRange(start, 1, last - start + 1, PARSER_EVENTS_HEADERS.length)
    .getValues()
    .filter(function (r) {
      var t = new Date(r[0]).getTime();
      return !isNaN(t) && t >= sinceMs;
    })
    .map(function (r) {
      return { templateId: String(r[3] || ""), event: String(r[4] || "") };
    });
}

// A template with PARSER_AUTO_DISABLE_ACCEPTED confirmed mistakes in the
// window goes back to the LLM until someone fixes and re-enables it.
function checkParserAutoDisable(templateId) {
  if (!templateId || templateId === PARSED_BY_LLM) return false;
  try {
    var since = Date.now() - PARSER_AUTO_DISABLE_WINDOW_DAYS * 86400000;
    var accepted = _recentParserEvents(since).filter(function (e) {
      return e.templateId === templateId && e.event === PARSER_EVENT.REPARSE_ACCEPTED;
    }).length;
    if (accepted < PARSER_AUTO_DISABLE_ACCEPTED) return false;
    if (!disableParserTemplate(templateId)) return false;
    logParserEvent({ templateId: templateId, event: PARSER_EVENT.AUTO_DISABLED });
    sendTelegramMessage(
      ADMIN_CHAT_ID,
      "⚠️ Parser template `" +
        templateId +
        "` auto-disabled after " +
        accepted +
        " accepted Re-reads in " +
        PARSER_AUTO_DISABLE_WINDOW_DAYS +
        " days. Its messages now go to the LLM. Re-enable via the `" +
        PARSER_DISABLED_PROP +
        "` script property.",
      { parse_mode: "Markdown" }
    );
    return true;
  } catch (e) {
    console.warn("[checkParserAutoDisable] " + e.message);
    return false;
  }
}

// Pure: per-template counts → digest text. Accepted Re-reads are confirmed
// parser mistakes, so accepted/saved is the real error rate.
function formatParserDigest(events, mode, disabled) {
  var byTpl = {};
  events.forEach(function (e) {
    if (!e.templateId) return;
    var s = byTpl[e.templateId] || (byTpl[e.templateId] = {});
    s[e.event] = (s[e.event] || 0) + 1;
  });
  var lines = ["🧪 *Parser — last 7 days* (mode: `" + mode + "`)"];
  var ids = Object.keys(byTpl).sort();
  if (ids.length === 0) lines.push("_No parser activity._");
  ids.forEach(function (id) {
    var s = byTpl[id];
    var saved = s[PARSER_EVENT.SAVED] || 0;
    var accepted = s[PARSER_EVENT.REPARSE_ACCEPTED] || 0;
    var parts = ["saved " + saved];
    if (s[PARSER_EVENT.REPARSE_REQUESTED]) parts.push("re-read " + s[PARSER_EVENT.REPARSE_REQUESTED]);
    if (accepted) parts.push("wrong " + accepted + (saved ? " (" + Math.round((accepted / saved) * 100) + "%)" : ""));
    var shadowTotal = (s[PARSER_EVENT.SHADOW_MATCH] || 0) + (s[PARSER_EVENT.SHADOW_MISMATCH] || 0);
    if (shadowTotal) {
      parts.push(
        "shadow agree " + Math.round(((s[PARSER_EVENT.SHADOW_MATCH] || 0) / shadowTotal) * 100) + "% of " + shadowTotal
      );
    }
    if (s[PARSER_EVENT.REPORT]) parts.push("reports " + s[PARSER_EVENT.REPORT]);
    lines.push("• `" + id + "` — " + parts.join(", "));
  });
  if (disabled.length) lines.push("\nDisabled: " + disabled.map((d) => "`" + d + "`").join(", "));
  return lines.join("\n");
}

// Weekly time-trigger handler (install from the Apps Script console).
function sendParserDigest() {
  if (isNativeMode()) return;
  var events = _recentParserEvents(Date.now() - 7 * 86400000);
  sendTelegramMessage(ADMIN_CHAT_ID, formatParserDigest(events, getParserMode(), getDisabledParserTemplates()), {
    parse_mode: "Markdown"
  });
}
