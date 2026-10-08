// Apps Script ↔ Worker bridge for D1 mode. NATIVE_MODE (AConfig) flips the
// Gmail poller to hand emails to the Worker and turns off the Apps Script
// crons; the Worker owns the bot and the data from then on.
//
// Worker → Apps Script: signed actions in the doPost body
//   { action, ts, payload: "<json>", sig: hex(HMAC(INTERNAL_SECRET, ts.action.payload)) }
// Apps Script → Worker: X-Dab-Timestamp / X-Dab-Signature headers over ts.body.

var WORKER_SIG_MAX_SKEW_MS = 5 * 60 * 1000;
var WORKER_BACKFILL_PREFIX = "wbackfill:";
var WORKER_BACKFILL_TRIGGER_PREFIX = "wbackfill_trigger:";
var WORKER_BACKFILL_CHUNK_MS = 5 * 60 * 1000;
// Emails the Worker fails on stay unlabelled and are retried by the next
// chunk; this bounds the chain if the Worker keeps failing.
var WORKER_BACKFILL_MAX_CHUNKS = 12;

function isNativeMode() {
  return typeof NATIVE_MODE !== "undefined" && String(NATIVE_MODE) === "1";
}

function _internalSecret() {
  return typeof INTERNAL_SECRET !== "undefined" && INTERNAL_SECRET ? String(INTERNAL_SECRET) : "";
}

function hmacHex(secret, message) {
  return Utilities.computeHmacSha256Signature(message, secret)
    .map(function (b) {
      return ((b + 256) % 256).toString(16).padStart(2, "0");
    })
    .join("");
}

// Is this doPost body a signed Worker action (vs. a Telegram update)?
function isWorkerActionBody(body) {
  return !!(body && typeof body.action === "string" && typeof body.sig === "string");
}

// → parsed payload, or null if the signature/timestamp doesn't check out.
function verifyWorkerAction(body, nowMs) {
  var secret = _internalSecret();
  if (!secret || !isWorkerActionBody(body) || typeof body.payload !== "string") return null;
  var ts = Number(body.ts);
  var now = nowMs == null ? Date.now() : nowMs;
  if (!isFinite(ts) || Math.abs(now - ts) > WORKER_SIG_MAX_SKEW_MS) return null;
  var expected = hmacHex(secret, String(body.ts) + "." + body.action + "." + body.payload);
  if (!_constantTimeEquals(expected, body.sig)) return null;
  try {
    return JSON.parse(body.payload) || {};
  } catch (_) {
    return null;
  }
}

var WORKER_ACTIONS = {
  send_setup_email: function (p) {
    if (!p.chatId || !p.emails || !p.emails.length) throw new Error("chatId and emails are required");
    mailSetupInstructions(p.chatId, p.emails, p.emails);
    return {};
  },
  get_email_body: function (p) {
    var msg = GmailApp.getMessageById(String(p.messageId || ""));
    if (!msg) throw new Error("message not found");
    return { text: msg.getPlainBody() || "", receivedAt: msg.getDate().getTime() };
  },
  // Rewrites the tenant's export sheet (created on first use) and shares it
  // with their registered emails.
  export_to_sheet: function (p) {
    if (!p.header || !p.rows) throw new Error("header and rows are required");
    var ss = null;
    if (p.sheetId) {
      try {
        ss = SpreadsheetApp.openById(String(p.sheetId));
      } catch (_) {}
    }
    if (!ss) ss = SpreadsheetApp.create(p.title || "Dus Aane Bot — export");
    var sheet = ss.getSheets()[0];
    sheet.clear();
    var values = [p.header].concat(p.rows);
    var range = sheet.getRange(1, 1, values.length, p.header.length);
    // Text columns as plain text: a merchant like "=HYPERLINK(...)" stays
    // text and "0042" keeps its zeros. Numeric columns stay numbers.
    var formats = p.header.map(function (_, c) {
      var numeric =
        p.rows.length > 0 &&
        p.rows.every(function (r) {
          return typeof r[c] === "number";
        });
      return numeric ? "#,##0.00" : "@";
    });
    range.setNumberFormats(
      values.map(function () {
        return formats;
      })
    );
    range.setValues(
      values.map(function (r) {
        return r.map(function (v) {
          return typeof v === "number" ? v : String(v == null ? "" : v);
        });
      })
    );
    sheet.setFrozenRows(1);
    (p.emails || []).forEach(function (email) {
      try {
        ss.addEditor(String(email));
      } catch (e) {
        console.warn("[export_to_sheet] share failed: " + e.message);
      }
    });
    return { sheetId: ss.getId(), url: ss.getUrl() };
  },
  // Everything the D1 importer needs (worker/scripts/import-sheets.mjs).
  export_dump: function () {
    return { dump: buildSheetsDump() };
  },
  backfill_range: function (p) {
    if (!p.chatId || !p.emails || !p.emails.length || !p.startMs || !p.endMs) throw new Error("invalid range");
    _saveWorkerBackfill(String(p.chatId), {
      emails: p.emails.map(function (e) {
        return String(e).toLowerCase();
      }),
      startMs: Number(p.startMs),
      endMs: Number(p.endMs),
      total: 0,
      chunks: 0
    });
    _scheduleWorkerBackfill(String(p.chatId), 1000);
    return {};
  }
};

function _jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handleWorkerAction(body) {
  var payload = verifyWorkerAction(body);
  if (!payload) return _jsonOutput({ ok: false, error: "unauthorized" });
  var handler = WORKER_ACTIONS[body.action];
  if (!handler) return _jsonOutput({ ok: false, error: "unknown action" });
  try {
    var out = handler(payload) || {};
    out.ok = true;
    return _jsonOutput(out);
  } catch (e) {
    console.error("[workerAction] " + body.action + ": " + e.message);
    return _jsonOutput({ ok: false, error: e.message });
  }
}

// Signed POST to the Worker. → { code, json }.
function postToWorker(path, payload) {
  var secret = _internalSecret();
  if (!secret || typeof WORKER_PROXY_URL === "undefined" || !WORKER_PROXY_URL) {
    throw new Error("Worker bridge not configured");
  }
  var body = JSON.stringify(payload);
  var ts = String(Date.now());
  var resp = UrlFetchApp.fetch(String(WORKER_PROXY_URL).replace(/\/+$/, "") + path, {
    method: "post",
    contentType: "application/json",
    payload: body,
    headers: { "X-Dab-Timestamp": ts, "X-Dab-Signature": hmacHex(secret, ts + "." + body) },
    muteHttpExceptions: true
  });
  var json = null;
  try {
    json = JSON.parse(resp.getContentText() || "null");
  } catch (_) {}
  return { code: resp.getResponseCode(), json: json };
}

// Hand one forwarded email to the Worker. 2xx means handled (saved,
// duplicate, ignored, no tenant) — label it; anything else is retried later.
// → the Worker's status string, or "failed".
function ingestEmailViaWorker(message, forwarder, silent) {
  var res;
  try {
    res = postToWorker("/ingest/email", {
      messageId: message.getId(),
      forwarder: forwarder,
      receivedAt: message.getDate().getTime(),
      text: message.getPlainBody() || "",
      silent: !!silent
    });
  } catch (e) {
    console.error("[ingestEmailViaWorker] " + message.getId() + ": " + e.message);
    return "failed";
  }
  if (res.code >= 200 && res.code < 300) {
    var status = (res.json && res.json.status) || "saved";
    // Unregistered forwarder: leave unlabelled so a /backfill after
    // registering can still pick it up.
    if (status !== "no_tenant") markProcessed(message);
    return status;
  }
  if (res.code === 400) markProcessed(message);
  console.warn("[ingestEmailViaWorker] " + message.getId() + " → HTTP " + res.code);
  return "failed";
}

// ─── Gmail poller (native mode) ─────────────────────────────────────

var WORKER_RETRY_PROP = "gmail.workerRetry";
var WORKER_RETRY_MAX_ATTEMPTS = 6;
var WORKER_RETRY_MAX_IDS = 200;

// Hand this run's emails to the Worker. Failures (Worker or LLM down) are
// kept in a small retry list and re-sent on the next runs, so the history
// cursor can always advance.
function ingestBatchViaWorker(entries) {
  var props = PropertiesService.getScriptProperties();
  var retry = {};
  try {
    retry = JSON.parse(props.getProperty(WORKER_RETRY_PROP) || "{}") || {};
  } catch (_) {}

  var queue = [];
  Object.keys(retry).forEach(function (id) {
    var headers = getMessageHeaders(id);
    var msg = null;
    try {
      msg = headers ? GmailApp.getMessageById(id) : null;
    } catch (_) {}
    if (msg) queue.push({ msg: msg, headers: headers, attempts: retry[id] });
  });
  entries.forEach(function (e) {
    if (!Object.prototype.hasOwnProperty.call(retry, e.msg.getId())) {
      queue.push({ msg: e.msg, headers: e.headers, attempts: 0 });
    }
  });

  var next = {};
  var stats = { handled: 0, failed: 0, skipped: 0 };
  queue.forEach(function (q) {
    var forwarder = extractForwarderFromHeaders(q.headers);
    if (!forwarder) {
      stats.skipped++;
      return;
    }
    if (ingestEmailViaWorker(q.msg, forwarder, false) === "failed") {
      stats.failed++;
      if (q.attempts + 1 < WORKER_RETRY_MAX_ATTEMPTS && Object.keys(next).length < WORKER_RETRY_MAX_IDS) {
        next[q.msg.getId()] = q.attempts + 1;
      }
    } else {
      stats.handled++;
    }
  });
  props.setProperty(WORKER_RETRY_PROP, JSON.stringify(next));
  return stats;
}

// ─── Sheets dump for the D1 import ──────────────────────────────────

// Dates travel as { $d: epoch ms } so the importer never guesses timezones.
function _dumpCell(v) {
  return v instanceof Date ? { $d: v.getTime() } : v;
}

function _dumpTab(tab, cols) {
  if (!tab || tab.getLastRow() <= 1) return [];
  return tab
    .getRange(2, 1, tab.getLastRow() - 1, cols)
    .getValues()
    .map(function (r) {
      return r.map(_dumpCell);
    });
}

function buildSheetsDump() {
  var tab = _getOrCreateTenantsTab();
  var tenants = [];
  if (tab.getLastRow() > 1) {
    tenants = tab
      .getRange(2, 1, tab.getLastRow() - 1, TENANT_COL_COUNT)
      .getValues()
      .filter(function (r) {
        return r[TENANT_COLS.CHAT_ID - 1];
      })
      .map(function (r) {
        var t = _rowToTenant(r);
        t.created_at = _dumpCell(t.created_at);
        t.last_forward_at = _dumpCell(t.last_forward_at);
        t.last_nag_at = _dumpCell(t.last_nag_at);
        return t;
      });
  }

  var personal = {};
  var groups = {};
  tenants.forEach(function (t) {
    if (!t.sheet_id) return;
    try {
      var ss = SpreadsheetApp.openById(t.sheet_id);
      if (t.chat_type === TENANT_CHAT_TYPE.GROUP) {
        groups[t.chat_id] = { rows: _dumpTab(ss.getSheets()[0], G_COL_COUNT) };
      } else {
        personal[t.chat_id] = {
          rows: _dumpTab(ss.getSheets()[0], PERSONAL_COL_COUNT),
          myMerchants: _dumpTab(ss.getSheetByName(MY_MERCHANTS_TAB), 3)
        };
      }
    } catch (e) {
      (t.chat_type === TENANT_CHAT_TYPE.GROUP ? groups : personal)[t.chat_id] = { error: e.message };
    }
  });

  return {
    version: 1,
    exportedAt: Date.now(),
    tenants: tenants,
    personal: personal,
    groups: groups,
    shared: {
      resolutions: _dumpTab(getOrCreateResolutionSheet(), 2),
      overrides: _dumpTab(getOrCreateOverridesSheet(), 2)
    },
    settings: {
      "parser.mode": getParserMode(),
      "parser.disabledTemplates": getDisabledParserTemplates().join(",")
    }
  };
}

// ─── /backfill (Worker-driven) ──────────────────────────────────────

function _loadWorkerBackfill(chatId) {
  var raw = PropertiesService.getScriptProperties().getProperty(WORKER_BACKFILL_PREFIX + chatId);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function _saveWorkerBackfill(chatId, state) {
  PropertiesService.getScriptProperties().setProperty(WORKER_BACKFILL_PREFIX + chatId, JSON.stringify(state));
}

function _scheduleWorkerBackfill(chatId, afterMs) {
  var trigger = ScriptApp.newTrigger("continueWorkerBackfill").timeBased().after(afterMs).create();
  PropertiesService.getScriptProperties().setProperty(WORKER_BACKFILL_TRIGGER_PREFIX + trigger.getUniqueId(), chatId);
}

// Pure: Worker ingest status → progress bucket (null = not counted).
function workerBackfillBucket(status) {
  if (status === "saved" || status === "review") return "saved";
  if (status === "duplicate" || status === "linked") return "dupes";
  if (status === "failed") return "failed";
  return null;
}

// One chunk: post each unprocessed email in range to the Worker (silent),
// report progress, and reschedule until the range is exhausted.
function continueWorkerBackfill(e) {
  var props = PropertiesService.getScriptProperties();
  var uid = e && e.triggerUid;
  deleteOwnTrigger(uid, "continueWorkerBackfill");
  if (!uid) return;
  var chatId = props.getProperty(WORKER_BACKFILL_TRIGGER_PREFIX + uid);
  props.deleteProperty(WORKER_BACKFILL_TRIGGER_PREFIX + uid);
  var state = chatId && _loadWorkerBackfill(chatId);
  if (!state) return;

  var counts = { saved: 0, dupes: 0, failed: 0 };
  var started = Date.now();
  var timedOut = false;
  var entries = fetchAndFilterMessages(new Date(state.startMs), new Date(state.endMs)).filter(function (entry) {
    var from = extractForwarderFromHeaders(entry.headers);
    return from && state.emails.indexOf(from) !== -1;
  });
  beginProcessedBatch();
  try {
    for (var i = 0; i < entries.length; i++) {
      if (Date.now() - started > WORKER_BACKFILL_CHUNK_MS) {
        timedOut = true;
        break;
      }
      var forwarder = extractForwarderFromHeaders(entries[i].headers);
      var bucket = workerBackfillBucket(ingestEmailViaWorker(entries[i].msg, forwarder, true));
      if (bucket) counts[bucket]++;
      state.total++;
    }
  } finally {
    endProcessedBatch();
  }

  var done = !timedOut || ++state.chunks >= WORKER_BACKFILL_MAX_CHUNKS;
  try {
    postToWorker("/internal/backfill", {
      chatId: chatId,
      saved: counts.saved,
      dupes: counts.dupes,
      failed: counts.failed,
      totalEmails: state.total,
      done: done
    });
  } catch (err) {
    console.error("[continueWorkerBackfill] progress post failed: " + err.message);
  }
  if (done) {
    props.deleteProperty(WORKER_BACKFILL_PREFIX + chatId);
    return;
  }
  _saveWorkerBackfill(chatId, state);
  _scheduleWorkerBackfill(chatId, 10000);
}
