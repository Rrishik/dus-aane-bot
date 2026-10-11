import { describe, it, expect } from "vitest";
import { createTelegram } from "../src/telegram/client.js";
import { setWebhook, ALLOWED_UPDATES } from "../scripts/set-webhook.mjs";

function fakeApi(fail) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    calls.push({ method, body: JSON.parse(init.body) });
    if (fail === method)
      return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    const result = { getMe: { username: "dusaanebot" }, getWebhookInfo: { pending_update_count: 2 } }[method] || true;
    return new Response(JSON.stringify({ ok: true, result }));
  };
  return { calls, tg: createTelegram({ token: "t", fetchImpl, maxAttempts: 1 }) };
}

describe("set-webhook", () => {
  it("points the webhook at the Worker root with the secret and registers both menus", async () => {
    const { calls, tg } = fakeApi();
    const out = await setWebhook(tg, "https://bot.example.workers.dev/some/path", { secret: "s3cret" });
    expect(out).toEqual({ username: "dusaanebot", pending: 2, lastError: null });
    expect(calls[0]).toEqual({
      method: "setWebhook",
      body: {
        url: "https://bot.example.workers.dev/",
        secret_token: "s3cret",
        allowed_updates: ALLOWED_UPDATES,
        drop_pending_updates: false
      }
    });
    const menus = calls.filter((c) => c.method === "setMyCommands").map((c) => c.body.scope.type);
    expect(menus).toEqual(["all_private_chats", "all_group_chats"]);
    for (const c of calls.filter((x) => x.method === "setMyCommands")) {
      for (const cmd of c.body.commands) expect(cmd.command).toMatch(/^[a-z]{1,32}$/);
    }
  });

  it("refuses to run without a secret and surfaces Telegram errors", async () => {
    await expect(setWebhook(fakeApi().tg, "https://w", {})).rejects.toThrow(/WEBHOOK_SECRET/);
    await expect(setWebhook(fakeApi("setWebhook").tg, "https://w", { secret: "s" })).rejects.toThrow(/Unauthorized/);
  });
});
