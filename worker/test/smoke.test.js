import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { runSmoke } from "../scripts/smoke.mjs";
import { createTestD1 } from "./helpers/d1.js";

const ctx = { waitUntil: () => {} };
const via = (env) => (url, init) => worker.fetch(new Request(url, init), env, ctx);

describe("smoke test", () => {
  it("passes against a healthy Worker", async () => {
    const env = { DB: createTestD1(), INTERNAL_SECRET: "int", WEBHOOK_SECRET: "k1" };
    const checks = await runSmoke("https://w/", { internalSecret: "int", webhookSecret: "k1", fetchImpl: via(env) });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["healthz: D1 reachable", true],
      ["unsigned email ingest is rejected", true],
      ["signed email ingest (Apps Script → Worker)", true],
      ["webhook rejects a wrong secret", true]
    ]);
  });

  it("catches a missing D1 binding and a wrong bridge secret", async () => {
    const checks = await runSmoke("https://w", {
      internalSecret: "int",
      fetchImpl: via({ INTERNAL_SECRET: "other" })
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "healthz: D1 reachable",
      "signed email ingest (Apps Script → Worker)"
    ]);
  });
});
