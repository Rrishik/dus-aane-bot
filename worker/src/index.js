import { proxyToAppsScript } from "./proxy.js";
import { createContext } from "./app/context.js";
import { handleIngestEmail } from "./app/ingestRoute.js";

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

    if (url.pathname === "/ingest/email") {
      if (!isNative(env)) return Response.json({ error: "native mode is off" }, { status: 409 });
      return handleIngestEmail(createContext(env), request);
    }
    return proxyToAppsScript(request, env, ctx);
  }
};
