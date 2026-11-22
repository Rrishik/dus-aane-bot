// Scheduled jobs. One daily cron (08:00 IST) dispatches by IST weekday:
// Friday weekly digest, Tuesday dormant nudges, Monday parser digest to the
// admin, and an ephemeral-state purge every day.
import { listTenants, recordNag, setTenantStatus } from "../db/tenants.js";
import { purgeExpired } from "../db/ephemeral.js";
import { getParserMode, getDisabledTemplates, parserEventSummary } from "../db/settings.js";
import { getMerchantRules, promoteConsensusMerchantRules, recentLearnedRules } from "../db/merchantRules.js";
import { listEffectiveTransactions } from "../db/analytics.js";
import { countUntaggedTransactions, listUntaggedWithSignals } from "../db/transactions.js";
import { weekRangeFor, weeklyDigestData, formatWeeklyMessage } from "./analytics.js";
import { normalizeTenantMerchants } from "./merchants.js";
import { refreshPersonalPin } from "./personalPin.js";
import { suggestTagsForBatch } from "./tagSuggester.js";
import { BATCH_SIZE, formatBatchSuggestionsSection, batchStepperKeyboard, saveStepperState } from "./tagStepper.js";
import { escapeMarkdown, money, formatDayMonth } from "./format.js";
import { istDate, shiftIsoDate, IST_OFFSET_MS } from "../util/dates.js";

const DAY_MS = 86400000;

export const NUDGE_CONFIG = { inactiveDays: 5, pendingDays: 2, cooldownDays: 7, maxNudges: 3 };

// null, or { kind: "pending" | "inactive", daysSilent }.
export function shouldNudge(t, nowMs, config = NUDGE_CONFIG) {
  if (!t || t.kind !== "personal") return null;
  if (t.status !== "active" && t.status !== "pending") return null;
  if ((t.nag_count || 0) >= config.maxNudges) return null;
  if (t.last_nag_at && nowMs - t.last_nag_at < config.cooldownDays * DAY_MS) return null;
  if (!t.last_activity_at) {
    const days = Math.floor((nowMs - t.created_at) / DAY_MS);
    return days >= config.pendingDays ? { kind: "pending", daysSilent: days } : null;
  }
  const days = Math.floor((nowMs - t.last_activity_at) / DAY_MS);
  return days >= config.inactiveDays ? { kind: "inactive", daysSilent: days } : null;
}

export function formatNudgeMessage(decision, name) {
  const greeting = name ? "Hi " + name + "! 👋" : "Hi! 👋";
  if (decision.kind === "pending") {
    return (
      greeting +
      "\n\nYou registered with Dus Aane Bot but haven't forwarded any bank emails yet. Open the setup email I sent and follow the 3 steps (~1 min on desktop) — or paste a bank SMS here to start. Tap below if you need the setup email again."
    );
  }
  return (
    greeting +
    "\n\nIt's been " +
    decision.daysSilent +
    " days since your last transaction. If your Gmail filter is still active, you should be all set. If not, tap below to resend the setup steps."
  );
}

export function formatParserDigest(summary, mode, disabled) {
  const lines = ["🧪 *Parser — last 7 days* (mode: `" + mode + "`)"];
  const ids = Object.keys(summary).sort();
  if (!ids.length) lines.push("_No parser activity._");
  for (const id of ids) {
    const s = summary[id];
    const saved = s.saved || 0;
    const wrong = s.reparse_accepted || 0;
    const parts = ["saved " + saved];
    if (s.reparse_requested) parts.push("re-read " + s.reparse_requested);
    if (wrong) parts.push("wrong " + wrong + (saved ? " (" + Math.round((wrong / saved) * 100) + "%)" : ""));
    const shadow = (s.shadow_match || 0) + (s.shadow_mismatch || 0);
    if (shadow) parts.push("shadow agree " + Math.round(((s.shadow_match || 0) / shadow) * 100) + "% of " + shadow);
    if (s.report) parts.push("reports " + s.report);
    if (s.user_fix) parts.push("user fixes " + s.user_fix);
    lines.push("• `" + id + "` — " + parts.join(", "));
  }
  if (disabled.length) lines.push("\nDisabled: " + disabled.map((d) => "`" + d + "`").join(", "));
  return lines.join("\n");
}

export async function sendWeeklyDigests(ctx) {
  const range = weekRangeFor(istDate(ctx.now()));
  const stats = { sent: 0, skipped: 0, failed: 0 };
  for (const t of await listTenants(ctx.db, { kind: "personal", statuses: ["active"] })) {
    try {
      const data = await weeklyDigestData(ctx.db, t.id, range);
      if (!data) {
        stats.skipped++;
        continue;
      }
      await ctx.tg.sendMessage(t.id, formatWeeklyMessage(range, data));
      stats.sent++;
    } catch (e) {
      stats.failed++;
      console.error("[digest] " + t.id + ":", e && e.message);
    }
  }
  console.log("[digest]", JSON.stringify(stats));
  return stats;
}

export async function nudgeDormantTenants(ctx) {
  const now = ctx.now();
  const stats = { nudged: 0, dormant: 0, skipped: 0, failed: 0 };
  for (const t of await listTenants(ctx.db, { kind: "personal", statuses: ["active", "pending"] })) {
    const decision = shouldNudge(t, now);
    if (!decision) {
      stats.skipped++;
      continue;
    }
    try {
      await ctx.tg.sendMessage(t.id, formatNudgeMessage(decision, t.name), {
        parse_mode: null,
        reply_markup: { inline_keyboard: [[{ text: "📬 Resend setup instructions", callback_data: "resend_setup" }]] }
      });
      const row = await recordNag(ctx.db, t.id, NUDGE_CONFIG.maxNudges, now);
      if (row && row.status === "dormant") stats.dormant++;
      stats.nudged++;
    } catch (e) {
      // Blocked the bot: stop nudging; a later forward reactivates them.
      if (e && e.code === 403) {
        await setTenantStatus(ctx.db, t.id, "dormant");
        stats.dormant++;
      } else {
        stats.failed++;
        console.error("[nudge] " + t.id + ":", e && e.message);
      }
    }
  }
  console.log("[nudge]", JSON.stringify(stats));
  return stats;
}

export async function sendParserDigest(ctx) {
  const now = ctx.now();
  const promoted = await promoteConsensusMerchantRules(ctx.db, now).catch(() => []);
  if (!ctx.adminChatId) return;
  const since = now - 7 * DAY_MS;
  const [summary, mode, disabled, learned] = await Promise.all([
    parserEventSummary(ctx.db, since),
    getParserMode(ctx.db),
    getDisabledTemplates(ctx.db),
    recentLearnedRules(ctx.db, since, 6).catch(() => [])
  ]);
  const parts = [formatParserDigest(summary, mode, disabled)];
  if (promoted.length > 0 || learned.length > 0) {
    parts.push("", "🏷 *Merchant flywheel — last 7d*");
    if (promoted.length > 0) {
      parts.push(
        "• Auto-promoted to shared: " +
          promoted
            .map((p) => "`" + escapeMarkdown(p.pattern) + "` → *" + escapeMarkdown(p.name || p.category) + "*")
            .join(", ")
      );
    }
    for (const r of learned.slice(0, 5)) {
      const target = (r.name ? "*" + escapeMarkdown(r.name) + "* · " : "") + escapeMarkdown(r.category);
      parts.push(
        "• `" + escapeMarkdown(r.pattern) + "` → " + target + (r.tenants > 1 ? " _(" + r.tenants + " users)_" : "")
      );
    }
  }
  await ctx.tg.sendMessage(ctx.adminChatId, parts.join("\n"));
}

// ─── 21:00 IST daily recap + untagged reminder ───────────────────────

export function formatDailyRecap(todayIso, todayRows, untaggedRows, { suggestions = null, totalUntagged = null } = {}) {
  const spendRows = todayRows.filter((r) => r.kind === "spend");
  const spendByCurrency = {};
  for (const r of spendRows) spendByCurrency[r.currency] = (spendByCurrency[r.currency] || 0) + r.effective_minor;
  const spendText = Object.keys(spendByCurrency)
    .map((c) => money(spendByCurrency[c], c))
    .join(" + ");

  const hasConfidentSuggestions = Array.isArray(suggestions) && suggestions.some((s) => s && s.confident && s.category);
  const count = totalUntagged != null ? totalUntagged : untaggedRows.length;

  const lines = [];
  if (todayRows.length > 0) {
    lines.push("🌙 *Today's Recap* _(" + escapeMarkdown(formatDayMonth(todayIso)) + ")_");
    lines.push(
      spendRows.length > 0
        ? "Spent *" + spendText + "* across " + spendRows.length + " transaction" + (spendRows.length === 1 ? "" : "s")
        : todayRows.length + " transaction" + (todayRows.length === 1 ? "" : "s") + " recorded today"
    );
    lines.push("");
    for (const r of todayRows.slice(0, 5)) {
      const label = escapeMarkdown(r.merchant || r.merchant_raw || "Untagged");
      const cat = r.category ? escapeMarkdown(r.category) : "_needs category_";
      lines.push("• *" + label + "* — " + money(r.effective_minor, r.currency) + " · " + cat);
    }
    if (todayRows.length > 5) lines.push("_+" + (todayRows.length - 5) + " more today_");
  } else if (!hasConfidentSuggestions) {
    lines.push("🏷 *Untagged Expenses*");
  }

  if (count > 0) {
    if (lines.length > 0) lines.push("");
    if (hasConfidentSuggestions) {
      lines.push(formatBatchSuggestionsSection(untaggedRows, suggestions, count, 0));
    } else {
      lines.push(
        "🏷 *" +
          count +
          " expense" +
          (count === 1 ? " needs" : "s need") +
          " a category* — tagging sharpens your category insights."
      );
      const earlier = untaggedRows.filter((u) => u.occurred_on !== todayIso).slice(0, 4);
      for (const u of earlier) {
        const label = escapeMarkdown(u.merchant || u.merchant_raw || "Untagged");
        lines.push(
          "• " +
            escapeMarkdown(formatDayMonth(u.occurred_on)) +
            " · *" +
            label +
            "* — " +
            money(u.amount_minor, u.currency)
        );
      }
      lines.push("", '_Tap below for 1-tap pills, or reply in plain English (e.g. "Rahul is Food")._');
    }
  }
  return lines.join("\n");
}

export async function sendDailyRecaps(ctx) {
  const today = istDate(ctx.now());
  const weekAgo = shiftIsoDate(today, -7);
  const stats = { sent: 0, skipped: 0, dormant: 0, failed: 0 };
  for (const t of await listTenants(ctx.db, { kind: "personal", statuses: ["active"] })) {
    try {
      await normalizeTenantMerchants(ctx.db, t.id, await getMerchantRules(ctx.db, t.id), ctx.now());
      await refreshPersonalPin(ctx, t.id);
      const [todayRows, totalUntagged] = await Promise.all([
        listEffectiveTransactions(ctx.db, t.id, { from: today, to: today }),
        countUntaggedTransactions(ctx.db, t.id, { from: weekAgo, to: today })
      ]);
      if (todayRows.length === 0 && totalUntagged === 0) {
        stats.skipped++;
        continue;
      }
      let batchRows = [];
      let suggestions = null;
      const opts = { disable_web_page_preview: true };
      if (totalUntagged > 0) {
        batchRows = await listUntaggedWithSignals(ctx.db, t.id, {
          from: weekAgo,
          to: today,
          limit: BATCH_SIZE
        });
        suggestions = await suggestTagsForBatch(ctx, t.id, batchRows);
        const hasConfident = suggestions.some((s) => s.confident && s.category);
        opts.reply_markup = hasConfident
          ? batchStepperKeyboard(suggestions)
          : {
              inline_keyboard: [[{ text: "🏷 Categorize " + totalUntagged + " untagged", callback_data: "tagq_next" }]]
            };
      }
      const posted = await ctx.tg.sendMessage(
        t.id,
        formatDailyRecap(today, todayRows, batchRows, { suggestions, totalUntagged }),
        opts
      );
      if (posted && posted.message_id && suggestions && suggestions.some((s) => s.confident && s.category)) {
        await saveStepperState(ctx, t.id, posted.message_id, {
          mode: "batch",
          windowFrom: weekAgo,
          windowTo: today,
          skippedIds: [],
          doneCount: 0,
          items: suggestions
        });
      }
      stats.sent++;
    } catch (e) {
      if (e && e.code === 403) {
        await setTenantStatus(ctx.db, t.id, "dormant");
        stats.dormant++;
      } else {
        stats.failed++;
        console.error("[daily_recap] " + t.id + ":", e && e.message);
      }
    }
  }
  console.log("[daily_recap]", JSON.stringify(stats));
  return stats;
}

export async function runScheduled(ctx, scheduledTime) {
  const ist = new Date(scheduledTime + IST_OFFSET_MS);
  const istHour = ist.getUTCHours();
  const weekday = ist.getUTCDay();
  const jobs =
    istHour >= 18 ? [["daily_recap", () => sendDailyRecaps(ctx)]] : [["purge", () => purgeExpired(ctx.db, ctx.now())]];
  if (istHour < 18) {
    if (weekday === 5) jobs.push(["digest", () => sendWeeklyDigests(ctx)]);
    if (weekday === 2) jobs.push(["nudge", () => nudgeDormantTenants(ctx)]);
    if (weekday === 1) jobs.push(["parser", () => sendParserDigest(ctx)]);
  }
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (e) {
      console.error("[cron] " + name + " failed:", e && e.stack);
    }
  }
  return jobs.map(([name]) => name);
}
