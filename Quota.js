// /ask quota — hard cap of FREE_ASK_LIMIT successful calls per tenant per
// IST calendar day. Counters live on the Tenants tab:
//   ask_used_today      — successful /ask calls today
//   ask_used_date       — IST "YYYY-MM-DD" the counter applies to
//   ask_lifetime_count  — all-time successful /ask calls
//   ask_cap_hit_count   — days that hit the cap
//
// ask_cap_hit_count increments on the 4→5 transition (not on blocked
// attempts) — a clean "user-days at cap" signal. Refunds reverse it.
// Read-modify-write is wrapped in a 5s script lock; on contention we fail
// open (allow the ask) rather than hard-block a real user.

// IST calendar date for `now` as "YYYY-MM-DD".
function _istDateString(now) {
  return Utilities.formatDate(now, IST_TIMEZONE, "yyyy-MM-dd");
}

// Minutes to the next IST midnight (the cap reset boundary). Returns ≥1.
function _minutesUntilIstMidnight(now) {
  // Compute purely from IST wall-clock; the raw `now` may be in any tz.
  var istNow = Utilities.formatDate(now, IST_TIMEZONE, "HH:mm:ss");
  var parts = istNow.split(":");
  var hours = parseInt(parts[0], 10);
  var minutes = parseInt(parts[1], 10);
  var seconds = parseInt(parts[2], 10);
  var minutesElapsed = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
  var minutesLeft = 24 * 60 - minutesElapsed;
  return Math.max(1, minutesLeft);
}

// Human-readable "Xh Ym" / "Ym" for a minute count.
function formatTimeUntilIstMidnight(now) {
  var mins = _minutesUntilIstMidnight(now);
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  if (h === 0) return m + "m";
  if (m === 0) return h + "h";
  return h + "h " + m + "m";
}

// Cap-hit chat message. Pure; no I/O.
function formatAskCapHitMessage(now) {
  return (
    "🔒 *Daily /ask limit reached*\n\n" +
    "You've used today's " +
    FREE_ASK_LIMIT +
    " /ask questions.\n" +
    "Resets at midnight IST (in " +
    formatTimeUntilIstMidnight(now) +
    ")."
  );
}

// Reply markup with the "Premium coming soon" upsell button.
function buildAskCapHitKeyboard() {
  return { inline_keyboard: [[{ text: "💎 Upgrade to Premium", callback_data: "premium_info" }]] };
}

// Consume one /ask slot. Returns {allowed, usedToday[, resetInMinutes]}.
// Atomic via getScriptLock — this is a standalone script (not bound to a
// document) so getDocumentLock() returns null. Edge cases: no tenant row
// or lock contention → fail open with no writes.
function consumeAskQuota(chatId, now) {
  now = now || new Date();
  var todayIst = _istDateString(now);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    // Couldn't acquire the lock; let the call through rather than hard-block.
    return { allowed: true, usedToday: 0 };
  }
  try {
    var rowNum = _findRowIndexByChatId(chatId);
    if (rowNum === -1) {
      return { allowed: true, usedToday: 0 };
    }
    var tab = _getOrCreateTenantsTab();
    var row = tab.getRange(rowNum, 1, 1, TENANT_COL_COUNT).getValues()[0];

    var usedDate = String(row[TENANT_COLS.ASK_USED_DATE - 1] || "");
    var used = parseInt(row[TENANT_COLS.ASK_USED_TODAY - 1], 10) || 0;
    var lifetime = parseInt(row[TENANT_COLS.ASK_LIFETIME_COUNT - 1], 10) || 0;
    var capHits = parseInt(row[TENANT_COLS.ASK_CAP_HIT_COUNT - 1], 10) || 0;

    // Day rollover — reset the per-day counter when the stored date isn't today.
    if (usedDate !== todayIst) {
      used = 0;
      usedDate = todayIst;
    }

    if (used >= FREE_ASK_LIMIT) {
      // Still write the date so a midnight rollover lands even on blocked taps.
      tab.getRange(rowNum, TENANT_COLS.ASK_USED_DATE).setValue(usedDate);
      tab.getRange(rowNum, TENANT_COLS.ASK_USED_TODAY).setValue(used);
      invalidateTenantCache();
      return { allowed: false, usedToday: used, resetInMinutes: _minutesUntilIstMidnight(now) };
    }

    var newUsed = used + 1;
    var newLifetime = lifetime + 1;
    var newCapHits = capHits + (newUsed === FREE_ASK_LIMIT ? 1 : 0);

    tab.getRange(rowNum, TENANT_COLS.ASK_USED_TODAY).setValue(newUsed);
    tab.getRange(rowNum, TENANT_COLS.ASK_USED_DATE).setValue(usedDate);
    tab.getRange(rowNum, TENANT_COLS.ASK_LIFETIME_COUNT).setValue(newLifetime);
    if (newCapHits !== capHits) {
      tab.getRange(rowNum, TENANT_COLS.ASK_CAP_HIT_COUNT).setValue(newCapHits);
    }
    invalidateTenantCache();
    return { allowed: true, usedToday: newUsed };
  } finally {
    lock.releaseLock();
  }
}

// Refund a previously-consumed /ask slot. Called when runAskLoop throws,
// so a failed call doesn't burn the quota or pollute lifetime/cap metrics.
// Clamped at 0; cap-hit reversal only when used-was-at-limit before refund.
function refundAskQuota(chatId, now) {
  now = now || new Date();
  var todayIst = _istDateString(now);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var rowNum = _findRowIndexByChatId(chatId);
    if (rowNum === -1) return;
    var tab = _getOrCreateTenantsTab();
    var row = tab.getRange(rowNum, 1, 1, TENANT_COL_COUNT).getValues()[0];

    var usedDate = String(row[TENANT_COLS.ASK_USED_DATE - 1] || "");
    var used = parseInt(row[TENANT_COLS.ASK_USED_TODAY - 1], 10) || 0;
    var lifetime = parseInt(row[TENANT_COLS.ASK_LIFETIME_COUNT - 1], 10) || 0;
    var capHits = parseInt(row[TENANT_COLS.ASK_CAP_HIT_COUNT - 1], 10) || 0;

    // Only reverse a same-day consume — stale failures from a prior day are no-ops.
    if (usedDate !== todayIst || used <= 0) {
      return;
    }

    var wasAtCap = used === FREE_ASK_LIMIT;
    var newUsed = used - 1;
    var newLifetime = Math.max(0, lifetime - 1);
    var newCapHits = wasAtCap ? Math.max(0, capHits - 1) : capHits;

    tab.getRange(rowNum, TENANT_COLS.ASK_USED_TODAY).setValue(newUsed);
    tab.getRange(rowNum, TENANT_COLS.ASK_LIFETIME_COUNT).setValue(newLifetime);
    if (newCapHits !== capHits) {
      tab.getRange(rowNum, TENANT_COLS.ASK_CAP_HIT_COUNT).setValue(newCapHits);
    }
    invalidateTenantCache();
  } finally {
    lock.releaseLock();
  }
}
