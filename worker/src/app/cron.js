// Scheduled jobs. One daily cron (08:00 IST) dispatches by IST weekday:
// Friday weekly digest, Tuesday dormant nudges, Monday parser digest to the
// admin, and an ephemeral-state purge every day.
import { listTenants, recordNag, setTenantStatus } from "../db/tenants.js";
import { purgeExpired } from "../db/ephemeral.js";
import { getParserMode, getDisabledTemplates, parserEventSummary } from "../db/settings.js";
import { weekRangeFor, weeklyDigestData, formatWeeklyMessage } from "./analytics.js";
import { istDate } from "../util/dates.js";

const DAY_MS = 86400000;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

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
  if (!ctx.adminChatId) return;
  const summary = await parserEventSummary(ctx.db, ctx.now() - 7 * DAY_MS);
  const text = formatParserDigest(summary, await getParserMode(ctx.db), await getDisabledTemplates(ctx.db));
  await ctx.tg.sendMessage(ctx.adminChatId, text);
}

export async function runScheduled(ctx, scheduledTime) {
  const weekday = new Date(scheduledTime + IST_OFFSET_MS).getUTCDay();
  const jobs = [["purge", () => purgeExpired(ctx.db, ctx.now())]];
  if (weekday === 5) jobs.push(["digest", () => sendWeeklyDigests(ctx)]);
  if (weekday === 2) jobs.push(["nudge", () => nudgeDormantTenants(ctx)]);
  if (weekday === 1) jobs.push(["parser", () => sendParserDigest(ctx)]);
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (e) {
      console.error("[cron] " + name + " failed:", e && e.stack);
    }
  }
  return jobs.map(([name]) => name);
}
