// Post-deploy smoke test for a native Worker (staging or production).
//
//   node worker/scripts/smoke.mjs https://<worker>.workers.dev
//
// Env: INTERNAL_SECRET (required), WEBHOOK_SECRET (optional). Touches no
// user data: the signed email probe uses an unregistered forwarder.
import { signedHeaders } from "../src/app/auth.js";

const PROBE = {
  messageId: "smoke-probe",
  forwarder: "smoke@example.invalid",
  receivedAt: 0,
  text: "smoke test"
};

export async function runSmoke(baseUrl, { internalSecret, webhookSecret, fetchImpl = fetch, now = Date.now() }) {
  const base = new URL(baseUrl).origin;
  const checks = [];
  async function check(name, fn) {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
    } catch (e) {
      checks.push({ name, ok: false, detail: e.message });
    }
  }
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  await check("healthz: D1 reachable", async () => {
    const res = await fetchImpl(base + "/healthz");
    const body = await res.json();
    expect(body.ok === true && body.db === true, "got " + JSON.stringify(body));
  });

  await check("native mode on", async () => {
    const res = await fetchImpl(base + "/ingest/email", { method: "POST", body: "{}" });
    expect(res.status !== 409, "Worker is still in proxy mode (409)");
    expect(res.status === 401, "unsigned ingest returned " + res.status + ", expected 401");
  });

  await check("signed email ingest (Apps Script → Worker)", async () => {
    const body = JSON.stringify(PROBE);
    const res = await fetchImpl(base + "/ingest/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await signedHeaders(internalSecret, body, now)) },
      body
    });
    const json = await res.json().catch(() => null);
    expect(res.status === 200 && json && json.status === "no_tenant", "got " + res.status + " " + JSON.stringify(json));
  });

  if (webhookSecret) {
    await check("webhook rejects a wrong secret", async () => {
      const res = await fetchImpl(base + "/", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: "{}"
      });
      expect(res.status === 401, "got " + res.status);
    });
  }
  return checks;
}

async function main() {
  const url = process.argv[2];
  if (!url || !process.env.INTERNAL_SECRET) {
    console.error("usage: INTERNAL_SECRET=… node worker/scripts/smoke.mjs <worker url>");
    process.exit(2);
  }
  const checks = await runSmoke(url, {
    internalSecret: process.env.INTERNAL_SECRET,
    webhookSecret: process.env.WEBHOOK_SECRET
  });
  for (const c of checks) console.log((c.ok ? "✅ " : "❌ ") + c.name + (c.ok ? "" : " — " + c.detail));
  if (checks.some((c) => !c.ok)) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("smoke.mjs")) main();
