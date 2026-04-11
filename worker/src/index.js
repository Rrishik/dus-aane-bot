export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.text();
      const response = await fetch(env.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        redirect: "follow"
      });

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Proxy error:", error.message);
      return new Response("OK", { status: 200 });
    }
  }
};
