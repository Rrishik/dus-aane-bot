// Admin dashboard Worker (admin.healthvault.online). Read-only: D1
// aggregates, single parser cases in full, parser replay over stored emails,
// and live checks of the Gmail poller (Apps Script) and the Telegram webhook.
// Every request must carry a valid Cloudflare Access token.
import { verifyAccess } from "./access.js";
import { collectSummary } from "./queries.js";
import { loadCase, loadSourceCase } from "./cases.js";
import { replayBatch } from "./replay.js";
import { HTML, CSS, JS } from "./page.js";
import { callAppsScript } from "../app/appsScript.js";

const POLLER_HOURS = 6;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow"
};

function respond(body, type, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": type, ...SECURITY_HEADERS } });
}

function positiveInt(v) {
  const n = Number(v);
  return v && Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function pollerStatus(env, fetchImpl, now) {
  try {
    const res = await callAppsScript({ env, now: () => now, fetch: fetchImpl }, "poller_status", {
      hours: POLLER_HOURS
    });
    delete res.ok;
    return { ...res, hours: POLLER_HOURS };
  } catch (e) {
    return { error: "Apps Script: " + ((e && e.message) || "unreachable") };
  }
}

async function webhookStatus(env, fetchImpl) {
  if (!env.BOT_TOKEN) return { error: "BOT_TOKEN not set" };
  try {
    const res = await fetchImpl("https://api.telegram.org/bot" + env.BOT_TOKEN + "/getWebhookInfo");
    const body = await res.json();
    if (!body.ok) return { error: "Telegram: " + (body.description || res.status) };
    const w = body.result || {};
    let pointsAtWorker = false;
    try {
      pointsAtWorker = !!w.url && !!env.BOT_ORIGIN && new URL(w.url).origin === new URL(env.BOT_ORIGIN).origin;
    } catch (_) {}
    return {
      pointsAtWorker,
      pending: w.pending_update_count || 0,
      lastError: w.last_error_message || null,
      lastErrorAt: w.last_error_date ? w.last_error_date * 1000 : null
    };
  } catch (e) {
    return { error: "Telegram unreachable" };
  }
}

export async function handleAdmin(request, env, { fetchImpl = (...a) => fetch(...a), now = Date.now() } = {}) {
  const auth = await verifyAccess(request, env, { fetchImpl, now });
  if (!auth.ok) {
    console.warn("[admin] denied:", auth.reason);
    // The reason names which check failed (never secret values); Access has
    // already stopped anyone who isn't on its policy.
    return respond("Forbidden: " + auth.reason, "text/plain; charset=utf-8", 403);
  }
  if (request.method !== "GET") return respond("Method not allowed", "text/plain; charset=utf-8", 405);

  const url = new URL(request.url);
  if (url.pathname === "/") return respond(HTML, "text/html; charset=utf-8");
  if (url.pathname === "/app.js") return respond(JS, "text/javascript; charset=utf-8");
  if (url.pathname === "/app.css") return respond(CSS, "text/css; charset=utf-8");
  if (url.pathname === "/api/summary") {
    const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
    const [summary, poller, webhook] = await Promise.all([
      collectSummary(env.DB, { now, days }),
      pollerStatus(env, fetchImpl, now),
      webhookStatus(env, fetchImpl)
    ]);
    return respond(JSON.stringify({ email: auth.email, summary, ops: { poller, webhook } }), "application/json");
  }
  if (url.pathname === "/api/case") {
    const id = positiveInt(url.searchParams.get("id"));
    const sourceId = positiveInt(url.searchParams.get("source"));
    if (!id && !sourceId) return respond('{"error":"bad id"}', "application/json", 400);
    const ctx = { env, now: () => now, fetch: fetchImpl };
    const fetchEmail = (messageId) => callAppsScript(ctx, "get_email_body", { messageId });
    const c = id ? await loadCase(env.DB, id, fetchEmail) : await loadSourceCase(env.DB, sourceId, fetchEmail);
    if (!c) return respond('{"error":"not found"}', "application/json", 404);
    console.log("[admin]", id ? "case " + id : "source " + sourceId, "viewed by", auth.email);
    return respond(JSON.stringify(c), "application/json");
  }
  if (url.pathname === "/api/replay") {
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = positiveInt(url.searchParams.get("limit")) || 15;
    const ctx = { env, now: () => now, fetch: fetchImpl };
    try {
      const res = await replayBatch(env.DB, { offset, limit }, async (messageIds) => {
        return (await callAppsScript(ctx, "get_email_bodies", { messageIds })).messages || {};
      });
      if (offset === 0) console.log("[admin] parser replay started by", auth.email);
      return respond(JSON.stringify(res), "application/json");
    } catch (e) {
      return respond(JSON.stringify({ error: (e && e.message) || "replay failed" }), "application/json", 502);
    }
  }
  return respond("Not found", "text/plain; charset=utf-8", 404);
}

export default {
  fetch(request, env) {
    return handleAdmin(request, env);
  }
};
