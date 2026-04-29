// ─── Dormant-tenant nudge ───────────────────────────────────────────
//
// Time-based handler that pokes tenants who set up the bot but have gone
// quiet. Two flavors of nudge:
//
//   - inactive: was forwarding, then stopped (>= NUDGE_INACTIVE_DAYS since
//     last_forward_at)
//   - pending : registered but never forwarded once (>= NUDGE_PENDING_DAYS
//     since created_at, last_forward_at empty). Includes both PENDING and
//     ACTIVE-with-no-stamp tenants.
//
// A nudge writes last_nag_at + increments nag_count. The maxNudges-th nudge
// flips the tenant to DORMANT in the same pass; subsequent runs skip them.
// reactivateIfDormant (called from extractTransactions on the next live
// forward) flips them back to ACTIVE and clears the counters.
//
// One trigger drives all tenants — install manually from the Apps Script
// console (Triggers panel → Add Trigger → function: nudgeDormantTenants,
// event: time-driven, week timer, Tuesday, 4–5pm).

var NUDGE_CONFIG = {
  inactiveDays: 5, // last_forward_at older than this -> nudge
  pendingDays: 2, // created_at older than this with no forwards -> nudge
  cooldownDays: 7, // min gap between nudges to same tenant
  maxNudges: 3 // after this many, mark DORMANT
};

// Pure decision function. Returns null if no nudge is warranted, otherwise
// { kind: "pending" | "inactive", daysSilent }. Extracted for unit-testability;
// nudgeDormantTenants is a thin loop around this.
//
//   tenant: object as returned by loadTenants() / _rowToTenant
//   now:    Date (the trigger fire time)
//   config: { inactiveDays, pendingDays, cooldownDays, maxNudges }
function shouldNudge(tenant, now, config) {
  if (!tenant) return null;
  // PENDING and ACTIVE qualify; DORMANT/DISABLED are explicitly out.
  if (tenant.status !== "active" && tenant.status !== "pending") return null;
  if ((tenant.nag_count || 0) >= config.maxNudges) return null;

  var nowMs = now.getTime();

  // Cooldown: if we nudged recently, hold off regardless of other signals.
  if (tenant.last_nag_at) {
    var lastNagMs = new Date(tenant.last_nag_at).getTime();
    if (!isNaN(lastNagMs) && nowMs - lastNagMs < config.cooldownDays * 24 * 60 * 60 * 1000) {
      return null;
    }
  }

  // Pending branch: never forwarded once.
  if (!tenant.last_forward_at) {
    if (!tenant.created_at) return null; // no signal at all — can't decide
    var createdMs = new Date(tenant.created_at).getTime();
    if (isNaN(createdMs)) return null;
    var daysSinceCreated = Math.floor((nowMs - createdMs) / (24 * 60 * 60 * 1000));
    if (daysSinceCreated >= config.pendingDays) {
      return { kind: "pending", daysSilent: daysSinceCreated };
    }
    return null;
  }

  // Inactive branch: was forwarding, then stopped.
  var lastFwdMs = new Date(tenant.last_forward_at).getTime();
  if (isNaN(lastFwdMs)) return null;
  var daysSinceForward = Math.floor((nowMs - lastFwdMs) / (24 * 60 * 60 * 1000));
  if (daysSinceForward >= config.inactiveDays) {
    return { kind: "inactive", daysSilent: daysSinceForward };
  }
  return null;
}

// Pure formatter. Returns a Markdown message body for sendTelegramMessage.
// The resend-setup inline button is attached by the caller (nudgeDormantTenants).
function formatNudgeMessage(decision, tenantName) {
  var greeting = tenantName ? "Hi " + tenantName + "! 👋" : "Hi! 👋";
  if (decision.kind === "pending") {
    return (
      greeting +
      "\n\nYou registered with Dus Aane Bot but haven't forwarded any bank " +
      "emails yet. Open the setup email I sent and follow the 3 steps " +
      "(~1 min on desktop) — or forward any bank email manually to start. " +
      "Tap below if you need the setup email again."
    );
  }
  // inactive
  return (
    greeting +
    "\n\nIt's been " +
    decision.daysSilent +
    " days since your last forwarded transaction. If your Gmail filter is " +
    "still active, you should be all set. If not, tap below to resend the " +
    "setup steps."
  );
}

// Time-based trigger handler. Walks every tenant sequentially and nudges the
// ones that shouldNudge() flags. Mirrors the sendWeeklySummaries shape: one
// trigger drives all tenants, per-tenant try/catch so one failure doesn't
// halt the run.
function nudgeDormantTenants() {
  var tenants = loadTenants();
  var now = new Date();
  var nowIso = now.toISOString();

  var nudgedCount = 0;
  var dormantCount = 0;
  var skipCount = 0;
  var failCount = 0;

  tenants.forEach(function (t) {
    try {
      var decision = shouldNudge(t, now, NUDGE_CONFIG);
      if (!decision) {
        skipCount++;
        return;
      }
      var msg = formatNudgeMessage(decision, t.name);
      sendTelegramMessage(t.chat_id, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "\uD83D\uDCEC Resend setup instructions", callback_data: "resend_setup" }]]
        }
      });

      // Record the nudge: stamp last_nag_at + bump nag_count. If we just
      // hit the cap, flip to DORMANT — they get one final nudge, then quiet.
      var newCount = (t.nag_count || 0) + 1;
      var rowNum = _findRowIndexByChatId(t.chat_id);
      if (rowNum !== -1) {
        var tab = _getOrCreateTenantsTab();
        tab.getRange(rowNum, TENANT_COLS.LAST_NAG_AT).setValue(nowIso);
        tab.getRange(rowNum, TENANT_COLS.NAG_COUNT).setValue(newCount);
        if (newCount >= NUDGE_CONFIG.maxNudges) {
          tab.getRange(rowNum, TENANT_COLS.STATUS).setValue(TENANT_STATUS.DORMANT);
          dormantCount++;
        }
      }
      invalidateTenantCache();
      nudgedCount++;
    } catch (e) {
      failCount++;
      console.error("[nudgeDormantTenants] tenant " + t.chat_id + ": " + e.message);
    }
  });

  console.log(
    "[nudgeDormantTenants] nudged=" +
      nudgedCount +
      " marked_dormant=" +
      dormantCount +
      " skipped=" +
      skipCount +
      " failed=" +
      failCount
  );
}
