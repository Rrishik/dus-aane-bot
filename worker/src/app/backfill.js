// /backfill: the Worker validates and records the job; Apps Script walks the
// bot's Gmail for the range and posts each email to /ingest/email (silent),
// reporting progress to POST /internal/backfill.
import { getTenantEmails } from "../db/tenants.js";
import { callAppsScript } from "./appsScript.js";
import { verifySignedRequest } from "./auth.js";

const UNIT_MS = { minute: 60000, hour: 3600000, day: 86400000, week: 7 * 86400000 };
const UNIT_ALIASES = {
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  h: "hour",
  hour: "hour",
  hours: "hour",
  d: "day",
  day: "day",
  days: "day",
  w: "week",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month"
};
const STALE_JOB_MS = 30 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export const BACKFILL_USAGE =
  "❌ *Invalid format!*\n\nUse: `/backfill 10m` or `/backfill 3 days` or `/backfill 2 weeks`\nOr: `/backfill YYYY-MM-DD YYYY-MM-DD`";

// → { ok, startMs, endMs } | { ok: false, error: usage|unknown_unit|invalid_dates|invalid_range }
export function parseBackfillArgs(text, nowMs) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);
  if (parts.length < 2) return { ok: false, error: "usage" };
  let amount;
  let unit;
  const compact = parts[1].match(/^(\d+)([a-z]+)$/i);
  if (compact) {
    amount = parseInt(compact[1], 10);
    unit = compact[2].toLowerCase();
  } else if (/^\d+$/.test(parts[1]) && parts.length >= 3) {
    amount = parseInt(parts[1], 10);
    unit = parts[2].toLowerCase();
  }
  if (unit) {
    const u = UNIT_ALIASES[unit];
    if (!u) return { ok: false, error: "unknown_unit" };
    if (u === "month") {
      const d = new Date(nowMs);
      d.setUTCMonth(d.getUTCMonth() - amount);
      return { ok: true, startMs: d.getTime(), endMs: nowMs };
    }
    return { ok: true, startMs: nowMs - amount * UNIT_MS[u], endMs: nowMs };
  }
  if (parts.length < 3) return { ok: false, error: "usage" };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(parts[1]) || !iso.test(parts[2])) return { ok: false, error: "invalid_dates" };
  // Whole IST days: start 00:00, end 23:59:59.999.
  const startMs = Date.parse(parts[1] + "T00:00:00Z") - IST_OFFSET_MS;
  const endMs = Date.parse(parts[2] + "T00:00:00Z") - IST_OFFSET_MS + 86400000 - 1;
  if (isNaN(startMs) || isNaN(endMs)) return { ok: false, error: "invalid_dates" };
  if (startMs > endMs) return { ok: false, error: "invalid_range" };
  return { ok: true, startMs, endMs };
}

export function formatDurationMs(ms) {
  if (!ms || ms < 0) return "0s";
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  if (s && parts.length === 0) parts.push(s + "s");
  return parts.length ? parts.join(" ") : "<1m";
}

const ERRORS = {
  unknown_unit: "❌ *Unknown unit!* Use `min`, `hour`, `day`, `week`, or `month`.",
  invalid_dates: "❌ *Invalid dates!* Use format YYYY-MM-DD\n\nExample: `/backfill 2026-03-01 2026-03-31`",
  invalid_range: "❌ *Start date must be before end date.*",
  usage: BACKFILL_USAGE
};

function istLabel(ms, withTime) {
  const iso = new Date(ms + IST_OFFSET_MS).toISOString();
  return withTime ? iso.slice(0, 10) + " " + iso.slice(11, 16) : iso.slice(0, 10);
}

export async function handleBackfill(ctx, chatId, text) {
  const now = ctx.now();
  const parsed = parseBackfillArgs(text, now);
  if (!parsed.ok) {
    await ctx.tg.sendMessage(chatId, ERRORS[parsed.error]);
    return;
  }
  const running = await ctx.db
    .prepare("SELECT updated_at FROM backfill_jobs WHERE tenant_id = ?")
    .bind(String(chatId))
    .first();
  if (running && now - running.updated_at < STALE_JOB_MS) {
    await ctx.tg.sendMessage(chatId, "⏳ *A backfill is already running.* I'll post the summary when it finishes.");
    return;
  }
  await ctx.db
    .prepare(
      "INSERT INTO backfill_jobs (tenant_id, start_at, end_at, saved, dupes, failed, chunk, updated_at) VALUES (?, ?, ?, 0, 0, 0, 1, ?) " +
        "ON CONFLICT (tenant_id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at, saved = 0, dupes = 0, failed = 0, chunk = 1, updated_at = excluded.updated_at"
    )
    .bind(String(chatId), parsed.startMs, parsed.endMs, now)
    .run();
  try {
    await callAppsScript(ctx, "backfill_range", {
      chatId: String(chatId),
      emails: await getTenantEmails(ctx.db, chatId),
      startMs: parsed.startMs,
      endMs: parsed.endMs
    });
  } catch (e) {
    console.error("[backfill]", e && e.message);
    await ctx.db.prepare("DELETE FROM backfill_jobs WHERE tenant_id = ?").bind(String(chatId)).run();
    await ctx.tg.sendMessage(chatId, "❌ *Couldn't start the backfill.* Try again in a minute.");
    return;
  }
  const span = parsed.endMs - parsed.startMs;
  const subDay = span < 86400000;
  await ctx.tg.sendMessage(
    chatId,
    "⏳ *Backfill started* _(" +
      formatDurationMs(span) +
      ")_\n" +
      istLabel(parsed.startMs, subDay) +
      " → " +
      istLabel(parsed.endMs, subDay)
  );
}

// POST /internal/backfill from Apps Script after each chunk:
// { chatId, saved, dupes, failed, totalEmails, done }
export async function handleBackfillProgress(ctx, request) {
  const auth = await verifySignedRequest(request, ctx.env.INTERNAL_SECRET, ctx.now());
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });
  let p;
  try {
    p = JSON.parse(auth.body);
  } catch (_) {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const chatId = String(p.chatId || "");
  const job = await ctx.db
    .prepare(
      "UPDATE backfill_jobs SET saved = saved + ?, dupes = dupes + ?, failed = failed + ?, chunk = chunk + ?, updated_at = ? " +
        "WHERE tenant_id = ? RETURNING saved, dupes, failed, chunk"
    )
    .bind(Number(p.saved) || 0, Number(p.dupes) || 0, Number(p.failed) || 0, p.done ? 0 : 1, ctx.now(), chatId)
    .first();
  if (!job) return Response.json({ error: "no job" }, { status: 404 });

  if (!p.done) {
    await ctx.tg.sendMessage(
      chatId,
      "⏳ *Backfill chunk " +
        (job.chunk - 1) +
        " done*\n💾 Saved so far: " +
        job.saved +
        "\n🔁 Dupes: " +
        job.dupes +
        "\n⏭ Continuing..."
    );
    return Response.json({ ok: true });
  }
  let summary = "✅ *Backfill Complete!*\n\n";
  summary += "📧 *Emails processed:* " + (Number(p.totalEmails) || 0) + "\n";
  summary += "💾 *Transactions saved:* " + job.saved + "\n";
  if (job.dupes > 0) summary += "🔁 *Duplicates skipped:* " + job.dupes + "\n";
  if (job.failed > 0) summary += "❌ *Failed:* " + job.failed + "\n";
  if (job.chunk > 1) summary += "📦 *Chunks:* " + job.chunk + "\n";
  summary += "\n_Run_ /recent _to see the latest._";
  await ctx.tg.sendMessage(chatId, summary);
  await ctx.db.prepare("DELETE FROM backfill_jobs WHERE tenant_id = ?").bind(chatId).run();
  return Response.json({ ok: true });
}
