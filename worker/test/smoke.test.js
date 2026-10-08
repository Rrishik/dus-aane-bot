import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { runSmoke } from "../scripts/smoke.mjs";
import { createTestD1 } from "./helpers/d1.js";

const ctx = { waitUntil: () => {} };
const via = (env) => (url, init) => worker.fetch(new Request(url, init), env, ctx);

describe("smoke test", () => {
  it("passes against a native Worker", async () => {
    const env = { MODE: "native", DB: createTestD1(), INTERNAL_SECRET: "int", WEBHOOK_SECRET: "k1" };
    const checks = await runSmoke("https://w/", { internalSecret: "int", webhookSecret: "k1", fetchImpl: via(env) });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["healthz: D1 reachable", true],
      ["native mode on", true],
      ["signed email ingest (Apps Script → Worker)", true],
      ["webhook rejects a wrong secret", true]
    ]);
  });

  it("catches a Worker still in proxy mode and a wrong bridge secret", async () => {
    const proxy = { DB: createTestD1(), INTERNAL_SECRET: "int", APPS_SCRIPT_URL: "https://as/" };
    const p = await runSmoke("https://w", { internalSecret: "int", fetchImpl: via(proxy) });
    expect(p.find((c) => c.name === "native mode on")).toMatchObject({
      ok: false,
      detail: "Worker is still in proxy mode (409)"
    });

    const native = { MODE: "native", DB: createTestD1(), INTERNAL_SECRET: "other" };
    const n = await runSmoke("https://w", { internalSecret: "int", fetchImpl: via(native) });
    expect(n.find((c) => c.name.startsWith("signed")).ok).toBe(false);
  });
});
