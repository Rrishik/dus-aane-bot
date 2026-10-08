import { proxyToAppsScript } from "./proxy.js";
import { createContext } from "./app/context.js";
import { handleIngestEmail } from "./app/ingestRoute.js";
import { handleBackfillProgress } from "./app/backfill.js";
import { handleUpdate } from "./app/webhook.js";
import { runScheduled } from "./app/cron.js";

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
  }
};

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
  ctx.waitUntil(handleUpdate(createContext(env), update));
  return new Response("OK", { status: 200 });
}
