export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Telegram echoes the secret registered via setWebhook in this header.
    // Rejected requests get a 401; real Telegram updates that arrive before
    // setTelegramWebhook() is re-run are retried by Telegram, not lost.
    const secret = env.WEBHOOK_SECRET || "";
    if (secret && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const body = await request.text();
      const target = new URL(env.APPS_SCRIPT_URL);
      if (secret) target.searchParams.set("k", secret);
      // Forward to Apps Script in the background. We MUST return 200 to
      // Telegram fast: the Apps Script Web App can take 5-15s for /ask (LLM
      // round-trips) and longer for other commands. If we await the fetch,
      // Telegram's webhook may time out and retry, causing duplicate command
      // execution. ctx.waitUntil keeps the subrequest alive after we return.
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
};
