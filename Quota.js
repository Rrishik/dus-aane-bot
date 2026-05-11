// --- /ask quota ---
//
// Hard cap of FREE_ASK_LIMIT (Constants.js) successful /ask calls per tenant
// per IST calendar day. There is no premium tier yet — when the cap is hit
// we show a "Premium coming soon" upsell so we can measure who hits the
// limit before deciding pricing and quota for an eventual paid tier.
//
// Counters live on the Tenants tab (see TenantRegistry.js schema):
//   ask_used_today      — successful /ask calls today (0..FREE_ASK_LIMIT)
//   ask_used_date       — IST "YYYY-MM-DD" the ask_used_today applies to
//   ask_lifetime_count  — all-time successful /ask calls (never resets)
//   ask_cap_hit_count   — days on which ask_used_today reached FREE_ASK_LIMIT
//
// Definition note: ask_cap_hit_count increments on the transition from 4→5
// (i.e., the day's 5th successful call) — not on blocked attempts. Reasoning:
// it's a clean "user consumed all 5 quota slots today" signal, indexable
// directly off ask_used_today without an extra dedupe column. Per-day, not
// per-blocked-attempt — so the metric is "user-days at cap", not "blocked
// taps". Refunds (see refundAskQuota) reverse it for failed asks so we never
// count a day that never actually used 5 successful calls.
//
// Lock: a 5s document lock wraps the read-modify-write. If the lock can't
// be acquired we fail open (allow the ask) rather than block a real user
// over a phantom contention event.

// Returns the IST calendar date for `now` as "YYYY-MM-DD".
function _istDateString(now) {
  return Utilities.formatDate(now, IST_TIMEZONE, "yyyy-MM-dd");
}

// Minutes until the next IST midnight (00:00 IST) from `now`. Used to tell
// the user when their quota resets. Returns an integer ≥ 1.
function _minutesUntilIstMidnight(now) {
  // Get IST "yyyy-MM-dd HH:mm:ss" string, parse into IST-local components,
  // then compute minutes to the next midnight in IST. The raw `now` may be
  // in any wall-clock timezone (Apps Script runs in script-tz); IST is the
  // only thing that matters for the cap reset.
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

// Consume one /ask slot for `chatId`. Increments the per-day counter and
// (on the 5th successful call of the day) ask_cap_hit_count. Atomic via
// LockService.
//
// Returns:
//   { allowed: true,  usedToday: N }    when N ≤ FREE_ASK_LIMIT and the
//                                       caller should proceed.
//   { allowed: false, usedToday: FREE_ASK_LIMIT,
//     resetInMinutes: M }               when the caller should reject.
//
// Edge cases:
// - No tenant row found → allowed=true with no counter writes (we don't
//   want to silently block a legitimate user mid-onboarding). Lifetime
//   tracking only kicks in once they're in the registry.
// - Lock contention → fail open (allowed=true), no writes. Better than
//   blocking on a rare race.
function consumeAskQuota(chatId, now) {
  now = now || new Date();
  var todayIst = _istDateString(now);

  var lock = LockService.getDocumentLock();
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
      // Still write back the (possibly reset) date so a fresh midnight rollover
      // is reflected even on a blocked attempt.
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

// Refund a previously-consumed /ask slot (decrement counters). Called when
// runAskLoop throws or the content filter rejects, so a failed call doesn't
// burn a quota slot or pollute the lifetime/cap metrics.
//
// Clamped at 0 so a double-refund (defensive caller) can't push counters
// negative. Cap-hit reversal happens iff used-was-at-limit before this
// refund (i.e., we're undoing the very transition that incremented it).
function refundAskQuota(chatId, now) {
  now = now || new Date();
  var todayIst = _istDateString(now);

  var lock = LockService.getDocumentLock();
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

    // Only reverse if the consume happened today; a stale failure from a prior
    // day shouldn't touch today's counters.
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
