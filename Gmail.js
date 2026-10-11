// Gmail poller: finds new forwarded bank mail in the bot inbox and hands
// each email to the Worker (WorkerBridge.js), which parses and saves it.

/**
 * Returns the Gmail label resource ID for PROCESSED_LABEL_NAME, creating the
 * label if it doesn't exist. The ID is cached in ScriptProperties because
 * Gmail.Users.Messages.modify needs the ID (not the name) and looking it up
 * via labels.list on every trigger run would be wasteful.
 *
 * If the user manually deletes the label, the cached ID becomes stale. The
 * next markProcessed call will throw "invalid label" and the catch there
 * clears the cache so the subsequent run re-creates the label cleanly.
 */
function getProcessedLabelId() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty("gmail.processedLabelId");
  if (cached) return cached;

  var resp = Gmail.Users.Labels.list("me");
  var labels = (resp && resp.labels) || [];
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].name === PROCESSED_LABEL_NAME) {
      props.setProperty("gmail.processedLabelId", labels[i].id);
      return labels[i].id;
    }
  }

  var created = Gmail.Users.Labels.create(
    {
      name: PROCESSED_LABEL_NAME,
      labelListVisibility: "labelShow",
      messageListVisibility: "show"
    },
    "me"
  );
  props.setProperty("gmail.processedLabelId", created.id);
  return created.id;
}

/**
 * Reads the messages added to the mailbox since `startHistoryId`. Returns
 * `{ messageIds: string[], newHistoryId: string }` on success, or `null` if
 * Gmail rejected the cursor as expired/invalid (typical after ~7 days of
 * inactivity) so the caller can bootstrap.
 *
 * Pagination is followed in case a single run sees a large backlog (e.g. the
 * trigger fired after an hours-long Apps Script outage).
 */
function listNewMessageIdsViaHistory(startHistoryId) {
  var messageIds = [];
  var seen = {};
  var pageToken = null;
  var newHistoryId = startHistoryId;
  try {
    do {
      var params = {
        startHistoryId: startHistoryId,
        historyTypes: ["messageAdded"]
      };
      if (pageToken) params.pageToken = pageToken;
      var resp = Gmail.Users.History.list("me", params);
      if (resp.historyId) newHistoryId = resp.historyId;
      var records = resp.history || [];
      for (var i = 0; i < records.length; i++) {
        var added = records[i].messagesAdded || [];
        for (var j = 0; j < added.length; j++) {
          var id = added[j].message && added[j].message.id;
          if (id && !seen[id]) {
            seen[id] = true;
            messageIds.push(id);
          }
        }
      }
      pageToken = resp.nextPageToken;
    } while (pageToken);
  } catch (e) {
    // Gmail returns 404 with "Invalid startHistoryId" once the cursor expires.
    // Treat any failure as "needs bootstrap" — the caller will time-window
    // recover. Network/500s also land here; the bootstrap fallback for those
    // means a tiny re-scan, which is fine.
    console.warn("[listNewMessageIdsViaHistory] " + e.message + " — will bootstrap");
    return null;
  }
  return { messageIds: messageIds, newHistoryId: newHistoryId };
}

/**
 * Captures the mailbox's current historyId and stores it as the cursor for
 * future incremental runs. Used on first deploy and when the cursor expires.
 *
 * Important ordering: we save the historyId BEFORE the bootstrap-window scan
 * runs so that any mail arriving during the scan will still be captured by
 * the next history.list (the Worker dedups any overlap).
 */
function bootstrapHistoryState() {
  var profile = Gmail.Users.getProfile("me");
  PropertiesService.getScriptProperties().setProperty("gmail.lastHistoryId", profile.historyId);
  return profile.historyId;
}

/**
 * Poller entry point (5-minute trigger).
 *
 * Steady state: history.list returns only deltas since the last successful
 * run, so per-run work is proportional to actual new mail (not lookback
 * width). A mid-run crash replays the same range; the Worker dedups by
 * Gmail message id.
 */
function extractTransactions() {
  var props = PropertiesService.getScriptProperties();
  // A 5-minute trigger can fire while a slow run (big backlog) is still
  // going. A stale stamp (crashed run) expires after the 6-min cap.
  var runningSince = Number(props.getProperty(EMAIL_RUN_LOCK_PROP) || 0);
  if (runningSince && Date.now() - runningSince < EMAIL_RUN_LOCK_TTL_MS) {
    console.log("[extractTransactions] previous run still in progress; skipping");
    return;
  }
  props.setProperty(EMAIL_RUN_LOCK_PROP, String(Date.now()));
  try {
    _extractTransactionsLocked(props);
  } finally {
    props.deleteProperty(EMAIL_RUN_LOCK_PROP);
  }
}

var EMAIL_RUN_LOCK_PROP = "gmail.runStartedAt";
var EMAIL_RUN_LOCK_TTL_MS = 6 * 60 * 1000;

function _extractTransactionsLocked(props) {
  var lastHistoryId = props.getProperty("gmail.lastHistoryId");
  var messagesToProcess;
  var newHistoryIdToSave = null;

  if (!lastHistoryId) {
    // First deploy: seed the cursor and sweep the bootstrap window for
    // anything currently in flight.
    bootstrapHistoryState();
    console.log("[extractTransactions] Bootstrapping; sweeping last " + BOOTSTRAP_WINDOW_MINUTES + " min");
    messagesToProcess = fetchAndFilterMessages(getBootstrapCutoffDate());
  } else {
    var result = listNewMessageIdsViaHistory(lastHistoryId);
    if (!result) {
      // Cursor expired/invalid → reset and sweep the bootstrap window. Per the
      // configured recovery policy we accept any gap older than that window;
      // the user can manually backfill if needed.
      bootstrapHistoryState();
      console.log("[extractTransactions] History cursor invalid; bootstrap-window recovery");
      messagesToProcess = fetchAndFilterMessages(getBootstrapCutoffDate());
    } else {
      // Two-phase hydration: metadata fetch first (cheap), then drop on the
      // ignore-list; only the survivors get a full body fetch via GmailApp.
      // Most of the "bank-curated" inbox passes both gates, but this avoids
      // the multi-MB raw fetch on promo/OTP slip-throughs.
      messagesToProcess = [];
      for (var i = 0; i < result.messageIds.length; i++) {
        var id = result.messageIds[i];
        var headers = getMessageHeaders(id);
        if (!headers) continue;
        if (shouldIgnoreByHeaders(headers)) continue;
        var m;
        try {
          m = GmailApp.getMessageById(id);
        } catch (e) {
          // Deleted between history event and hydrate — skip.
          continue;
        }
        if (!m) continue;
        if (!isFromAllowedBank(m)) continue;
        messagesToProcess.push({ msg: m, headers: headers });
      }
      newHistoryIdToSave = result.newHistoryId;
    }
  }

  // The Worker routes, dedups and saves. Failures go on a retry list, so the
  // cursor always advances; the bootstrap branches already saved one.
  var stats = ingestBatchViaWorker(messagesToProcess);
  console.log("[extractTransactions] worker " + JSON.stringify(stats));
  recordPollerRun(messagesToProcess.length, stats);
  if (newHistoryIdToSave) props.setProperty("gmail.lastHistoryId", newHistoryIdToSave);
}
/**
 * Computes the bootstrap window cutoff used when no historyId is available
 * (first deploy, or after history-cursor invalidation). The steady-state
 * trigger flow does NOT use this — see extractTransactions.
 */
function getBootstrapCutoffDate() {
  var cutoffDate = new Date();
  cutoffDate.setMinutes(cutoffDate.getMinutes() - BOOTSTRAP_WINDOW_MINUTES);
  return cutoffDate;
}

/**
 * Fetches just the headers we filter on (no body, no MIME walk) via the
 * Advanced Gmail Service. ~500-byte response regardless of message size,
 * vs. the multi-MB RFC822 blob that GmailApp.getMessageById hydrates.
 *
 * Returns { id, from, subject, xForwardedFor, internalDate } or null on
 * any Gmail error (message deleted between history event and fetch is
 * the common case).
 */
function getMessageHeaders(messageId) {
  try {
    var resp = Gmail.Users.Messages.get("me", messageId, {
      format: "metadata",
      metadataHeaders: ["From", "Subject", "X-Forwarded-For"]
    });
    var map = {};
    var arr = (resp && resp.payload && resp.payload.headers) || [];
    for (var i = 0; i < arr.length; i++) {
      map[String(arr[i].name).toLowerCase()] = arr[i].value || "";
    }
    return {
      id: resp.id,
      internalDate: resp.internalDate ? Number(resp.internalDate) : null,
      from: map.from || "",
      subject: map.subject || "",
      xForwardedFor: map["x-forwarded-for"] || ""
    };
  } catch (e) {
    console.warn("[getMessageHeaders] " + messageId + ": " + e.message);
    return null;
  }
}

/**
 * Headers-only ignore filter. Used pre-hydration in the trigger and search
 * paths so promo/OTP/marketing mail is dropped without a body fetch.
 *
 * Ignore tokens with spaces are double-quoted in Constants.js; strip and do
 * a case-insensitive substring match.
 */
function shouldIgnoreByHeaders(headers) {
  var fromHeader = (headers.from || "").toLowerCase();
  var subject = (headers.subject || "").toLowerCase();

  function norm(token) {
    return token.replace(/^"|"$/g, "").toLowerCase();
  }

  for (var i = 0; i < IGNORE_SENDERS.length; i++) {
    if (fromHeader.indexOf(norm(IGNORE_SENDERS[i])) !== -1) return true;
  }
  for (var j = 0; j < IGNORE_SUBJECTS.length; j++) {
    if (subject.indexOf(norm(IGNORE_SUBJECTS[j])) !== -1) return true;
  }
  return false;
}

/**
 * Bank-domain check on a single From: header value. Pulled out so it can be
 * reused by both the header-only fast path and the body-preamble slow path.
 */
function isBankFromHeader(fromHeader) {
  var f = (fromHeader || "").toLowerCase();
  for (var i = 0; i < BANK_FROM_DOMAINS.length; i++) {
    if (f.indexOf(BANK_FROM_DOMAINS[i].toLowerCase()) !== -1) return true;
  }
  return false;
}

/**
 * Extracts the original sender's email from a forwarded message's body.
 * Gmail's forward preamble format: "---------- Forwarded message ---------\nFrom: Name <addr@x>\n..."
 * Slow-path only: used when the From: header doesn't match a bank, to catch
 * manual forwards (Gmail UI "Forward" button) where From is the human.
 */
function extractForwardedFrom(msg) {
  try {
    var body = msg.getPlainBody() || "";
    var preamble = body.match(/Forwarded message[\s\S]{0,200}?From:\s*([^\r\n]+)/i);
    if (!preamble) return null;
    var line = preamble[1];
    var addrMatch = line.match(/<([^>]+)>/) || line.match(/([^\s<>]+@[^\s<>]+)/);
    return addrMatch ? addrMatch[1].toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Extracts the forwarder's (tenant's) email address from a metadata-headers
 * object. Priority:
 *  1. X-Forwarded-For (Gmail auto-forward adds "<forwarder> <destination>";
 *     we take the first address).
 *  2. From: header — fallback for manual forwards, where Gmail rewrites
 *     From to the human user.
 *
 * Returns lowercase email or null.
 */
function extractForwarderFromHeaders(headers) {
  var xff = headers && headers.xForwardedFor;
  if (xff) {
    var first = String(xff)
      .trim()
      .split(/[\s,]+/)[0];
    if (first && first.indexOf("@") !== -1) return first.toLowerCase();
  }
  var fromHeader = (headers && headers.from) || "";
  var fromMatch = fromHeader.match(/<([^>]+)>/);
  var fromEmail = (fromMatch ? fromMatch[1] : fromHeader.trim()).toLowerCase();
  if (fromEmail && fromEmail.indexOf("@") !== -1) return fromEmail;
  return null;
}

/**
 * Full bank-domain check including the body-preamble slow path. Used after
 * a message has been hydrated (the survivor set). Most calls return on the
 * cheap header check; only manual-forwards reach the body parse.
 */
function isFromAllowedBank(msg) {
  if (isBankFromHeader(msg.getFrom())) return true;
  var origFrom = extractForwardedFrom(msg);
  return origFrom ? isBankFromHeader(origFrom) : false;
}

/**
 * Lists messages in [startDate, endDate] via Gmail.Users.Messages.list (with
 * the `q=` time-window predicate), then filters and hydrates the survivors.
 * Returns `{ msg, headers }[]`, oldest-first.
 *
 * Called only by:
 *   - extractTransactions' bootstrap / history-expiry fallback path.
 *   - backfillTransactions (user-initiated date-range scan).
 * The steady-state trigger flow uses Gmail.Users.History.list instead.
 *
 * Server-side `-label:processed-by-bot` means messages already handled in a
 * prior run never come back over the wire — cheaper than the client-side
 * dedup (which still runs as belt-and-braces).
 */
function fetchAndFilterMessages(startDate, endDate) {
  // `after:`/`before:` with Unix seconds give us minute-level precision,
  // unlike `newer_than:` which only supports hour/day/week/month units.
  var afterSec = Math.floor(startDate.getTime() / 1000);
  var query = `${GMAIL_SEARCH_QUERY} -label:${PROCESSED_LABEL_NAME} after:${afterSec}`;
  if (endDate) {
    query += ` before:${Math.floor(endDate.getTime() / 1000)}`;
  }

  var ids = [];
  var pageToken = null;
  try {
    do {
      var params = { q: query, maxResults: 500 };
      if (pageToken) params.pageToken = pageToken;
      var resp = Gmail.Users.Messages.list("me", params);
      var msgs = (resp && resp.messages) || [];
      for (var i = 0; i < msgs.length; i++) ids.push(msgs[i].id);
      pageToken = resp && resp.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error("[fetchAndFilterMessages] messages.list failed: " + e.message);
    return [];
  }

  // Gmail returns newest-first; flip so downstream processing is chronological
  // (matches the original `GmailApp.search(...).reverse()` behaviour).
  ids.reverse();

  var out = [];
  for (var j = 0; j < ids.length; j++) {
    var id = ids[j];
    var headers = getMessageHeaders(id);
    if (!headers) continue;
    if (shouldIgnoreByHeaders(headers)) continue;
    var msg;
    try {
      msg = GmailApp.getMessageById(id);
    } catch (e) {
      continue;
    }
    if (!msg) continue;
    if (!isFromAllowedBank(msg)) continue;
    out.push({ msg: msg, headers: headers });
  }
  return out;
}

/**
 * Marks a Gmail message as handled by applying the `processed-by-bot` label
 * via the Advanced Gmail Service. Handled mail then drops out of the
 * time-window searches (bootstrap, /backfill).
 *
 * Per-message (not thread-level) is required because some banks reuse
 * subjects across alerts so Gmail bundles them into one thread — labelling
 * the thread would silently mask siblings from any future search filter.
 *
 * If a batch is active (see beginProcessedBatch), the Gmail label modify
 * is deferred and flushed in a single `messages.batchModify` on end.
 *
 * Failures are non-fatal: the Worker dedups by message id, so an unlabelled
 * message that comes back is answered as a duplicate.
 */
var _processedIdBatch = null;

function beginProcessedBatch() {
  _processedIdBatch = [];
}

function endProcessedBatch() {
  var ids = _processedIdBatch;
  _processedIdBatch = null;
  if (!ids || !ids.length) return;
  try {
    var labelId = getProcessedLabelId();
    // batchModify accepts up to 1000 ids per call; chunk defensively.
    for (var i = 0; i < ids.length; i += 1000) {
      var chunk = ids.slice(i, i + 1000);
      Gmail.Users.Messages.batchModify({ ids: chunk, addLabelIds: [labelId] }, "me");
    }
  } catch (e) {
    console.warn("[endProcessedBatch] batchModify failed: " + e.message);
    if (/label/i.test(e.message || "")) {
      PropertiesService.getScriptProperties().deleteProperty("gmail.processedLabelId");
    }
  }
}

function markProcessed(message) {
  var id = message.getId();
  if (_processedIdBatch !== null) {
    _processedIdBatch.push(id);
    return;
  }
  try {
    var labelId = getProcessedLabelId();
    Gmail.Users.Messages.modify({ addLabelIds: [labelId] }, "me", id);
  } catch (e) {
    console.warn("[markProcessed] modify failed: " + e.message);
    // If the label was deleted by the user, the cached id is stale. Clear it
    // so the next run re-discovers/recreates the label on first call.
    if (/label/i.test(e.message || "")) {
      PropertiesService.getScriptProperties().deleteProperty("gmail.processedLabelId");
    }
  }
}
