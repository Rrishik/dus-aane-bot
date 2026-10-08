// SMS paste: a private-chat message that looks like bank SMS text becomes
// transaction cards. The parser reads it first; the LLM only runs when the
// parser can't. Each SMS gets a content-hash id (sms-<16 hex>) so pasting the
// same text twice is a no-op, and the raw text is kept in the hidden Source
// Text column so 🔄 Re-read can use it later.

var SMS_PASTE_MAX = 10;
var SMS_DUPLICATE_SCAN_ROWS = 500;

// Returns true when the message was handled as a paste (caller stops).
// Text with no amount at all isn't a paste — stays silent, as before.
// `now` is injectable for tests.
function handleSmsPaste(chatId, text, now) {
  if (!looksLikeTransactionText(text)) return false;
  if (!gateTenantForCommand(chatId)) return true;
  ensureSheetHeaders();
  try {
    sendChatAction(chatId, "typing");
  } catch (_) {}

  var smsList = splitSmsPaste(text).slice(0, SMS_PASTE_MAX);
  var resolutions = getMerchantResolutionsForTenant();
  now = now || new Date();
  var tally = { saved: 0, review: 0, duplicate: 0, none: 0 };
  smsList.forEach(function (sms) {
    var outcome = "none";
    try {
      outcome = processPastedSms(chatId, sms, resolutions, now);
    } catch (e) {
      console.error("[handleSmsPaste] " + e.message, e.stack);
    }
    tally[outcome]++;
  });

  var notes = [];
  if (tally.duplicate) notes.push(tally.duplicate === 1 ? "Already recorded." : tally.duplicate + " already recorded.");
  if (tally.none)
    notes.push(smsList.length === 1 ? "No transaction found in that." : tally.none + " had no transaction.");
  if (notes.length) sendTelegramMessage(chatId, "ℹ️ " + notes.join(" "));
  if (tally.saved) markTenantActivity(chatId);
  return true;
}

// One SMS → "saved" | "review" | "duplicate" | "none".
function processPastedSms(chatId, sms, resolutions, now) {
  var messageId = SMS_ID_PREFIX + smsContentHash(sms);
  if (findRowByColumnValue(MESSAGE_ID_COLUMN, messageId) > 0) return "duplicate";

  var parsed = parseTransactionText(sms, { channel: "sms", receivedAt: now });
  // OTPs never go to the LLM. Other rejections (promo/declined/reminder
  // wording) get a second opinion — a false positive would drop a real txn.
  if (parsed && parsed.kind === "ignored" && parsed.reason === "otp") return "none";

  var extracted;
  var parsedBy;
  var lowConfidence = false;
  var usable =
    parsed &&
    parsed.kind === "transaction" &&
    parsed.confidence >= PARSER_REVIEW_CONFIDENCE &&
    !isParserTemplateDisabled(parsed.templateId);
  if (usable) {
    extracted = parsed;
    parsedBy = parsed.templateId;
    lowConfidence = parsed.confidence < PARSER_AUTO_SAVE_CONFIDENCE;
  } else {
    extracted = extractWithLLM(sms, resolutions, "sms");
    if (!extracted || extracted.not_a_transaction) return "none";
    parsedBy = PARSED_BY_LLM;
  }

  var check = validateExtraction(extracted, sms, now);
  var noDate = check.issues.indexOf("date_fallback") !== -1;
  var dup = findNearDuplicate(check.data);
  var reviewNote = "";
  if (dup) reviewNote = "looks like a duplicate of " + dup;
  else if (noDate) reviewNote = "no date in the SMS, used today's";

  var tenant = getCurrentTenant();
  var userLabel = (tenant && tenant.emails && tenant.emails[0]) || (tenant && tenant.name) || "sms";
  var saved = saveExtractedTransaction(extracted, {
    sourceText: sms,
    receivedAt: now,
    userEmail: userLabel,
    messageId: messageId,
    silent: false,
    resolutions: resolutions,
    parsedBy: parsedBy,
    storeSourceText: true,
    forceReview: lowConfidence || noDate || !!dup,
    reviewNote: reviewNote
  });

  if (parsedBy !== PARSED_BY_LLM) {
    logParserEvent({
      chatId: chatId,
      channel: "sms",
      templateId: parsedBy,
      event: PARSER_EVENT.SAVED,
      messageId: messageId
    });
  }
  return saved.status === TXN_STATUS_REVIEW ? "review" : "saved";
}

// Same transaction already on the sheet from another source (usually the
// bank email): same amount, currency and type, dated within a day. Returns a
// short description of the existing row, or "".
function findNearDuplicate(data) {
  var sheet = getSpreadsheet().getSheets()[0];
  var last = sheet.getLastRow();
  if (last <= 1) return "";
  var start = Math.max(2, last - SMS_DUPLICATE_SCAN_ROWS + 1);
  var rows = sheet.getRange(start, 1, last - start + 1, CURRENCY_COLUMN).getValues();
  var target = toIsoDate(data.transaction_date);
  if (!target) return "";
  var targetDay = Date.UTC(+target.slice(0, 4), +target.slice(5, 7) - 1, +target.slice(8, 10));
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    if (Math.abs((Number(r[AMOUNT_COLUMN - 1]) || 0) - data.amount) >= 0.01) continue;
    if (String(r[CURRENCY_COLUMN - 1] || "INR").toUpperCase() !== data.currency) continue;
    if (String(r[TRANSACTION_TYPE_COLUMN - 1] || "").toLowerCase() !== data.transaction_type.toLowerCase()) continue;
    var iso = toIsoDate(r[TRANSACTION_DATE_COLUMN - 1]);
    if (!iso) continue;
    var day = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    if (Math.abs(day - targetDay) > 86400000) continue;
    return (
      (r[MERCHANT_COLUMN - 1] || "a transaction") +
      " " +
      currencySymbol(data.currency) +
      formatAmount(data.amount) +
      " on " +
      Utilities.formatDate(new Date(day + 43200000), "UTC", "d MMM")
    );
  }
  return "";
}

function smsContentHash(sms) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    normalizeTransactionText(sms).toLowerCase(),
    Utilities.Charset.UTF_8
  );
  var hex = "";
  for (var i = 0; i < 8; i++) hex += ((bytes[i] & 0xff) < 16 ? "0" : "") + (bytes[i] & 0xff).toString(16);
  return hex;
}

// Fresh activity (forwarded email, saved SMS) undoes a dormant verdict and
// keeps nudges away. Best-effort.
function markTenantActivity(chatId) {
  try {
    stampLastForward(chatId);
    reactivateIfDormant(chatId);
  } catch (e) {
    console.error("[markTenantActivity] " + e.message);
  }
}
