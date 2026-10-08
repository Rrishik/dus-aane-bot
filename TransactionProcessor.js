// Tool definition for extraction tool calling
var EXTRACTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_merchant_category",
      description:
        "Look up the default category for a merchant. Call this when you are unsure about the category for a merchant. Do NOT call for well-known merchants where the category is obvious (e.g., Amazon=Shopping, Swiggy=Food & Dining).",
      parameters: {
        type: "object",
        properties: {
          merchant: {
            type: "string",
            description: "The merchant name extracted from the email"
          }
        },
        required: ["merchant"]
      }
    }
  }
];

function getExtractionSystemPrompt() {
  var categoryList = CATEGORIES.join(", ");
  var creditCategoryList = CREDIT_CATEGORIES.join(", ");

  return (
    "You are a transaction extraction assistant. Extract structured transaction details from emails.\n\n" +
    "Return a JSON object with fields:\n" +
    "- transaction_date (YYYY-MM-DD)\n" +
    '- merchant (if identifiable; use empty string "" if generic bank alert with no merchant/payee)\n' +
    "- amount (numeric only, no currency symbols)\n" +
    "- currency (3-letter ISO code, default INR)\n" +
    "- category\n" +
    "- transaction_type (Debit or Credit)\n\n" +
    "Rules for transaction_type:\n" +
    '- Money spent (purchase, bill payment) = "Debit"\n' +
    '- Money received (refund, salary, cashback) = "Credit"\n\n' +
    "Rules for merchant:\n" +
    "- Extract the actual merchant/payee name, NOT the bank name\n" +
    '- Generic bank debit/credit alert with no merchant info = ""\n\n' +
    "Rules for category:\n" +
    "- Debit: must be one of: " +
    categoryList +
    "\n" +
    "- Credit: must be one of: " +
    creditCategoryList +
    "\n\n" +
    "If the email is NOT a transaction (surveys, OTPs, marketing, feedback, declined transactions, alerts with no monetary value), return:\n" +
    '{"not_a_transaction": true, "reason": "brief reason"}\n\n' +
    "Use the get_merchant_category tool ONLY when you are unsure about the category. " +
    "For well-known merchants (Amazon, Flipkart, Swiggy, Zomato, Uber, etc.) categorize directly."
  );
}

// Execute the get_merchant_category tool call
function executeExtractionTool(toolName, args, resolutions) {
  if (toolName === "get_merchant_category") {
    var result = lookupMerchantCategory(args.merchant, resolutions);
    if (result) {
      return JSON.stringify(result);
    }
    return JSON.stringify({
      merchant: args.merchant,
      category: null,
      message: "No mapping found, use your best guess"
    });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

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
 * the next history.list (overlap is handled by Sheets dedup).
 */
function bootstrapHistoryState() {
  var profile = Gmail.Users.getProfile("me");
  PropertiesService.getScriptProperties().setProperty("gmail.lastHistoryId", profile.historyId);
  return profile.historyId;
}

/**
 * Main function to orchestrate the email processing flow.
 *
 * Steady state: history.list returns only deltas since the last successful
 * run, so per-run work is proportional to actual new mail (not lookback
 * width). The cursor is advanced only after the loop finishes; a mid-run
 * crash means the next run replays the same range and Sheets dedup absorbs
 * the overlap.
 *
 * Multi-tenant: each message is routed to the tenant whose registered
 * forwarder email matches the message's From: address. Unmatched messages
 * are skipped (logged but not processed).
 */
function extractTransactions() {
  var props = PropertiesService.getScriptProperties();
  // A 5-minute trigger can fire while a slow run (big backlog, LLM latency)
  // is still going; two runs on the same history range would race past the
  // sheet dedup. A stale stamp (crashed run) expires after the 6-min cap.
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

  // D1 mode: the Worker routes, dedups and saves.
  if (isNativeMode()) {
    var stats = ingestBatchViaWorker(messagesToProcess);
    console.log("[extractTransactions] worker " + JSON.stringify(stats));
    if (newHistoryIdToSave) props.setProperty("gmail.lastHistoryId", newHistoryIdToSave);
    return;
  }

  var resolutionsByTenant = {};
  var skipped = 0;

  messagesToProcess.forEach((entry) => {
    var message = entry.msg;
    var userEmail = extractForwarderFromHeaders(entry.headers);
    if (!userEmail) {
      skipped++;
      console.log("[extractTransactions] No forwarder on " + message.getId() + "; skipping");
      return;
    }

    var tenant = findTenantByEmail(userEmail);
    if (!tenant) {
      // Maybe this is a pending tenant's first forward — provision + activate.
      tenant = activatePendingTenantForEmail(userEmail);
    }
    if (!tenant) {
      skipped++;
      console.log("[extractTransactions] No tenant for " + userEmail + "; skipping " + message.getId());
      return;
    }

    setCurrentTenant(tenant);
    try {
      ensureSheetHeaders();
      if (!resolutionsByTenant[tenant.chat_id]) {
        resolutionsByTenant[tenant.chat_id] = getMerchantResolutionsForTenant();
      }
      var result = processSingleEmail(message, userEmail, false, resolutionsByTenant[tenant.chat_id]);
      if (result && result.saved) {
        // Only real saves count as activity — duplicates and parse failures don't.
        markTenantActivity(tenant.chat_id);
      }
    } finally {
      setCurrentTenant(null);
    }
  });

  if (skipped > 0) {
    console.log("[extractTransactions] Skipped " + skipped + " messages with no matching tenant.");
  }

  // Advance the cursor only after the loop finishes without throwing. If we
  // bail mid-run, the next run replays the same history range — Sheets dedup
  // catches the duplicates. (The bootstrap branches already wrote a fresh
  // cursor inside bootstrapHistoryState, so they leave newHistoryIdToSave
  // null here intentionally.)
  if (newHistoryIdToSave) {
    props.setProperty("gmail.lastHistoryId", newHistoryIdToSave);
  }
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
 * Cache layer in front of the Sheets dedup. The Gmail label filter inside
 * fetchAndFilterMessages catches the common case at search time; this exists
 * for the (rare) gap where a prior run saved a row but its label-add failed.
 */
function isAlreadyProcessed(messageId) {
  var cache = CacheService.getScriptCache();
  if (cache.get("processed:" + messageId)) return true;
  if (findRowByColumnValue(MESSAGE_ID_COLUMN, messageId) > 0) {
    cache.put("processed:" + messageId, "1", 21600);
    return true;
  }
  return false;
}

/**
 * Marks a Gmail message as handled: writes to script cache and applies the
 * `processed-by-bot` label via the Advanced Gmail Service.
 *
 * Per-message (not thread-level) is required because some banks reuse
 * subjects across alerts so Gmail bundles them into one thread — labelling
 * the thread would silently mask siblings from any future search filter.
 *
 * If a batch is active (see beginProcessedBatch), the Gmail label modify
 * is deferred and flushed in a single `messages.batchModify` on end. The
 * cache write still happens inline so `isAlreadyProcessed` sees it.
 *
 * All failures are non-fatal: the messageId already lives in the sheet
 * (truth of "processed"), so the label is purely a visual breadcrumb in the
 * user's Gmail.
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
  try {
    CacheService.getScriptCache().put("processed:" + id, "1", 21600);
  } catch (e) {
    console.warn("[markProcessed] cache put failed: " + e.message);
  }
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

/**
 * Runs the extraction LLM (with the get_merchant_category tool) on one email
 * body or SMS. Returns the parsed JSON object — a transaction or
 * { not_a_transaction, reason } — or null when the call or JSON parse fails.
 */
function extractWithLLM(sourceText, resolutions, channel) {
  var messages = [
    { role: "system", content: getExtractionSystemPrompt() },
    {
      role: "user",
      content: "Extract transaction details from this " + (channel === "sms" ? "SMS" : "email") + ":\n\n" + sourceText
    }
  ];

  // Max 2 iterations: initial + one tool response.
  for (var iter = 0; iter < 2; iter++) {
    var apiResponse = callAIWithTools(messages, EXTRACTION_TOOLS, 300);
    if (!apiResponse) return null;
    var msg = apiResponse.choices[0].message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg);
      for (var t = 0; t < msg.tool_calls.length; t++) {
        var tc = msg.tool_calls[t];
        var args = JSON.parse(tc.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: executeExtractionTool(tc.function.name, args, resolutions)
        });
      }
      continue;
    }
    return msg.content ? parseLLMJson(msg.content) : null;
  }
  return null;
}

function parseLLMJson(rawText) {
  var clean = String(rawText || "")
    .replace(/```json|```/g, "")
    .trim();
  if (clean.charAt(0) !== "{") return null;
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("[parseLLMJson] JSON parse failed:", e.message);
    return null;
  }
}

function _parserCanAutoSave(parsed) {
  return (
    !!parsed &&
    parsed.kind === "transaction" &&
    parsed.confidence >= PARSER_AUTO_SAVE_CONFIDENCE &&
    !isParserTemplateDisabled(parsed.templateId)
  );
}

function _safeParse(text, channel, receivedAt) {
  try {
    return parseTransactionText(text, { channel: channel, receivedAt: receivedAt });
  } catch (e) {
    console.error("[parseTransactionText] " + e.message);
    return null;
  }
}

// Shadow mode: the LLM result is what gets saved; this only records whether
// the parser would have agreed.
function logShadowComparison(parsed, llm, sourceText, receivedAt, messageId) {
  if (!llm) return;
  var llmTxn = !llm.not_a_transaction;
  var parserTxn = !!parsed && parsed.kind === "transaction";
  if (!llmTxn && !parserTxn) return;
  var evt = { chatId: getTenantChatId(), channel: "email", messageId: messageId };
  if (parserTxn && llmTxn) {
    var changed = diffExtractions(
      validateExtraction(parsed, null, receivedAt).data,
      validateExtraction(llm, sourceText, receivedAt).data
    );
    evt.templateId = parsed.templateId;
    evt.event = changed.length ? PARSER_EVENT.SHADOW_MISMATCH : PARSER_EVENT.SHADOW_MATCH;
    evt.fieldsChanged = changed;
  } else if (parserTxn) {
    evt.templateId = parsed.templateId;
    evt.event = PARSER_EVENT.SHADOW_EXTRA;
  } else {
    evt.templateId = parsed && parsed.kind === "ignored" ? "ignored:" + parsed.reason : "(none)";
    evt.event = PARSER_EVENT.SHADOW_NOMATCH;
  }
  logParserEvent(evt);
}

/**
 * Processes a single email: parser and/or LLM per `parser.mode`, then
 * validate + save + notify. Returns { saved, duplicate, data }.
 */
function processSingleEmail(message, userEmail, silent, resolutions) {
  var messageId = message.getId();

  // Dedup first — before the body fetch — so already-saved messages (whose
  // label add failed in a prior run) cost only a cache+sheet lookup.
  if (isAlreadyProcessed(messageId)) {
    markProcessed(message); // re-apply the label so we filter at source next time
    return { saved: false, duplicate: true, data: null };
  }

  var emailText = message.getPlainBody();
  var emailDate = message.getDate();
  var ctx = {
    sourceText: emailText,
    receivedAt: emailDate,
    userEmail: userEmail,
    messageId: messageId,
    silent: silent,
    resolutions: resolutions
  };

  try {
    var mode = getParserMode();
    var parsed = mode === "off" ? null : _safeParse(emailText, "email", emailDate);

    if (mode === "on" && _parserCanAutoSave(parsed)) {
      ctx.parsedBy = parsed.templateId;
      var saved = saveExtractedTransaction(parsed, ctx);
      logParserEvent({
        chatId: getTenantChatId(),
        channel: "email",
        templateId: parsed.templateId,
        event: PARSER_EVENT.SAVED,
        messageId: messageId
      });
      markProcessed(message);
      return { saved: true, duplicate: false, data: saved.data };
    }

    var llm = extractWithLLM(emailText, resolutions, "email");
    if (mode === "shadow") logShadowComparison(parsed, llm, emailText, emailDate, messageId);
    if (!llm) return { saved: false, duplicate: false, data: null };

    if (llm.not_a_transaction) {
      markProcessed(message);
      return { saved: false, duplicate: false, data: null };
    }
    ctx.parsedBy = PARSED_BY_LLM;
    var result = saveExtractedTransaction(llm, ctx);
    markProcessed(message);
    return { saved: true, duplicate: false, data: result.data };
  } catch (e) {
    console.error("[processSingleEmail] Error:", e.message);
  }
  return { saved: false, duplicate: false, data: null };
}

/**
 * Shared tail for every extraction source (email parser, email LLM, SMS).
 * Validates, resolves merchant + category, picks review vs confirmed, saves.
 *
 * ctx: { sourceText, receivedAt, userEmail, messageId, silent, resolutions,
 *        parsedBy, storeSourceText, forceReview, reviewNote }
 * Returns { data, status }.
 */
function saveExtractedTransaction(extracted, ctx) {
  var v = validateExtraction(extracted, ctx.sourceText, ctx.receivedAt);
  var data = v.data;
  data.category = String((extracted && extracted.category) || "").trim();

  var categories = getCategoryListForType(data.transaction_type);
  if (data.merchant && ctx.resolutions) {
    var resolved = resolveMerchant(data.merchant, ctx.resolutions);
    data.merchant = resolved.merchant;
    var fits = resolved.category && categories.indexOf(resolved.category) !== -1;
    // The user's own correction always wins; shared defaults only fill gaps.
    if (fits && (resolved.personalCategory || !data.category || data.category === "Uncategorized")) {
      data.category = resolved.category;
    }
  }
  if (!data.category || categories.indexOf(data.category) === -1) {
    data.category = guessCategory(data.merchant, data.transaction_type);
  }

  // Review needs a card to confirm from; silent (backfill) saves have none,
  // so they keep the pre-review behaviour and save as confirmed.
  var status = !ctx.silent && (v.needsReview || ctx.forceReview) ? TXN_STATUS_REVIEW : "";
  saveTransaction(data, ctx.receivedAt, ctx.userEmail, ctx.messageId, ctx.silent, {
    parsedBy: ctx.parsedBy || "",
    sourceText: ctx.storeSourceText ? ctx.sourceText : "",
    status: status,
    reviewNote: ctx.reviewNote || ""
  });
  return { data: data, status: status };
}

/**
 * Appends the row and (unless silent) sends the transaction card.
 * extra: { parsedBy, sourceText, status, reviewNote }
 */
function saveTransaction(data, emailDate, userEmail, messageId, silent, extra) {
  extra = extra || {};
  var transactionDate = data.transaction_date || "N/A";
  var merchant = data.merchant || "Unknown";
  var amount = data.amount || 0;
  var category = data.category || "Uncategorized";
  var type = data.transaction_type || "Unknown";
  var currency = data.currency || "INR";
  var user = String(userEmail || "").split("@")[0];

  appendRowToGoogleSheet([
    emailDate,
    transactionDate,
    merchant,
    amount,
    category,
    type,
    user,
    messageId,
    currency,
    "",
    "",
    extra.parsedBy || "",
    extra.sourceText || "",
    extra.status || ""
  ]);

  if (!silent) {
    data.email_date = emailDate;
    data.status = extra.status || "";
    data.reviewNote = extra.reviewNote || "";
    // The 👤 line only helps tenants with more than one forwarder email.
    var tenant = findTenantByChatId(getTenantChatId());
    var displayUser = tenant && tenant.emails && tenant.emails.length > 1 ? user : null;
    sendTransactionMessage(data, messageId, displayUser, { parsedBy: extra.parsedBy || "" });
  }
}
/**
 * Backfill transactions for a date range with time-based execution limit.
 * Returns { savedCount, duplicateCount, failedCount, totalEmails, timedOut }
 *
 * Wraps the loop in beginProcessedBatch/endProcessedBatch so all of the
 * per-message label additions collapse into one `messages.batchModify`
 * call at the end (the Advanced Service caps batches at 1000 ids).
 *
 * Cross-chunk dedup comes for free: fetchAndFilterMessages already excludes
 * label:processed-by-bot server-side, so each chunk's fetch only returns
 * messages from previous timeouts that haven't been labeled yet.
 */
function backfillTransactions(startDate, endDate, timeLimitMs) {
  // Scope backfill to the current tenant only. If no tenant is in context,
  // fall back to whatever getSpreadsheet() resolves to (tenant 0 defaults).
  var tenant = getCurrentTenant();
  ensureSheetHeaders();

  var messagesToProcess = fetchAndFilterMessages(startDate, endDate);

  // If we have a tenant in context, restrict to messages forwarded by that
  // tenant's registered emails. Prevents cross-tenant contamination.
  if (tenant) {
    messagesToProcess = messagesToProcess.filter(function (entry) {
      var userEmail = extractForwarderFromHeaders(entry.headers);
      return userEmail && tenant.emails.indexOf(userEmail) !== -1;
    });
  }

  var resolutions = getMerchantResolutionsForTenant();
  var savedCount = 0;
  var duplicateCount = 0;
  var failedCount = 0;
  var timedOut = false;
  var startTime = new Date().getTime();

  beginProcessedBatch();
  try {
    for (var i = 0; i < messagesToProcess.length; i++) {
      if (timeLimitMs && new Date().getTime() - startTime > timeLimitMs) {
        timedOut = true;
        break;
      }

      var entry = messagesToProcess[i];
      var userEmail = extractForwarderFromHeaders(entry.headers) || "unknown";
      var result = processSingleEmail(entry.msg, userEmail, true, resolutions);

      if (result.duplicate) {
        duplicateCount++;
      } else if (result.saved && result.data) {
        savedCount++;
      } else {
        failedCount++;
      }

      if (!result.duplicate) {
        Utilities.sleep(500);
      }
    }
  } finally {
    endProcessedBatch();
  }

  return {
    savedCount: savedCount,
    duplicateCount: duplicateCount,
    failedCount: failedCount,
    totalEmails: messagesToProcess.length,
    timedOut: timedOut
  };
}
