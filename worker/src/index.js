import { proxyToAppsScript } from "./proxy.js";

// GET /healthz reports whether the D1 binding answers. Everything else keeps
// the pre-migration behaviour: POST → Apps Script proxy, other methods 405.
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return healthz(env);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return proxyToAppsScript(request, env, ctx);
  }
};
