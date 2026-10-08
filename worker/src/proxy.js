// Telegram → Apps Script proxy (the Worker's only job until cutover).
//
// Telegram echoes the secret registered via setWebhook in
// X-Telegram-Bot-Api-Secret-Token. Rejected requests get a 401; real updates
// that arrive before setTelegramWebhook() is re-run are retried by Telegram.
export async function proxyToAppsScript(request, env, ctx) {
  const secret = env.WEBHOOK_SECRET || "";
  if (secret && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await request.text();
    const target = new URL(env.APPS_SCRIPT_URL);
    if (secret) target.searchParams.set("k", secret);
    // Return 200 to Telegram immediately: Apps Script can take 5-15s for /ask
    // and a slow ack makes Telegram retry (duplicate command execution).
    // ctx.waitUntil keeps the forward alive after we respond.
    ctx.waitUntil(
      fetch(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        redirect: "follow"
      }).catch((err) => {
        console.error("Background forward error:", err && err.message);
      })
    );
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Proxy error:", error.message);
    return new Response("OK", { status: 200 });
  }
}
