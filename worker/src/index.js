import { proxyToAppsScript } from "./proxy.js";
import { createContext } from "./app/context.js";
import { handleIngestEmail } from "./app/ingestRoute.js";
import { handleBackfillProgress } from "./app/backfill.js";
import { handleUpdate } from "./app/webhook.js";
import { runScheduled } from "./app/cron.js";
import { looksLikeTransactionText } from "./parser/index.js";

// GET /healthz reports whether the D1 binding answers.
export async function healthz(env) {
  if (!env.DB) return Response.json({ ok: true, db: null });
  try {
    const one = await env.DB.prepare("SELECT 1 AS one").first("one");
    return Response.json({ ok: one === 1, db: one === 1 });
  } catch (e) {
    console.error("[healthz] D1 check failed:", e && e.message);
    return Response.json({ ok: false, db: false }, { status: 503 });
  }
}

// MODE=native switches the Worker from proxying to Apps Script to running
// the bot itself. Native-only routes refuse requests until then so Apps
// Script stays the single writer.
export function isNative(env) {
  return env.MODE === "native";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return healthz(env);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    if (url.pathname === "/ingest/email" || url.pathname === "/internal/backfill") {
      if (!isNative(env)) return Response.json({ error: "native mode is off" }, { status: 409 });
      const app = createContext(env);
      return url.pathname === "/ingest/email" ? handleIngestEmail(app, request) : handleBackfillProgress(app, request);
    }
    if (!isNative(env)) return proxyToAppsScript(request, env, ctx);
    return handleTelegramWebhook(request, env, ctx);
  },

  // Apps Script owns the scheduled jobs until cutover.
  async scheduled(event, env, ctx) {
    if (!isNative(env)) return;
    ctx.waitUntil(runScheduled(createContext(env), event.scheduledTime));
  },

  async queue(batch, env) {
    await handleQueue(batch, env);
  }
};

// Updates that wait on the LLM or Apps Script can outlive waitUntil's 30s,
// so they go through the queue; everything else is handled straight away.
const SLOW_COMMANDS = ["/ask", "/register", "/backfill", "/export"];
export function isSlowUpdate(update) {
  const cb = update.callback_query;
  if (cb) return /^(rr|export)_/.test(cb.data || "") || cb.data === "resend_setup";
  const m = update.message;
  if (!m || !m.text || !m.chat || m.chat.type !== "private") return false;
  // Plain text: /ask replies and pasted SMS hit the LLM; a 🏷 tag reply doesn't.
  if (!m.text.startsWith("/")) return !!m.reply_to_message || looksLikeTransactionText(m.text);
  const command = m.text.split(/\s+/)[0].split("@")[0].toLowerCase();
  return SLOW_COMMANDS.includes(command);
}

// Native Telegram webhook: verify Telegram's secret header, ack at once and
// process in the background (a slow ack makes Telegram retry).
export async function handleTelegramWebhook(request, env, ctx) {
  const secret = env.WEBHOOK_SECRET || "";
  if (secret && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }
  let update;
  try {
    update = await request.json();
  } catch (_) {
    return new Response("OK", { status: 200 });
  }
  if (env.UPDATES && isSlowUpdate(update)) {
    try {
      await env.UPDATES.send(update);
      return new Response("OK", { status: 200 });
    } catch (e) {
      console.error("[queue] send failed, handling inline:", e && e.message);
    }
  }
  ctx.waitUntil(handleUpdate(createContext(env), update));
  return new Response("OK", { status: 200 });
}

// Queue consumer for slow updates. handleUpdate never throws, so a message
// is never retried (retries could double-post).
export async function handleQueue(batch, env) {
  for (const msg of batch.messages) {
    if (isNative(env)) await handleUpdate(createContext(env), msg.body);
    msg.ack();
  }
}
