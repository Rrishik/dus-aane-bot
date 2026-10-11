import { describe, it, expect, beforeEach } from "vitest";
import { handleAdmin } from "../src/admin/index.js";
import { resetAccessCache } from "../src/admin/access.js";
import { summarizeTemplate } from "../src/admin/queries.js";
import { testContext, seedTenant, seedGroup, llmTxn, NOW } from "./helpers/app.js";
import { ingest } from "../src/app/ingest.js";
import { createSplit } from "../src/db/splits.js";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-tag-123";
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  return { ...pair, jwk, kid };
}

async function sign(kp, claims, header = {}) {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: kp.kid, typ: "JWT", ...header }));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(h + "." + p));
  return h + "." + p + "." + b64url(new Uint8Array(sig));
}

const claims = (o = {}) => ({
  aud: [AUD],
  iss: "https://" + TEAM,
  email: "Admin@Example.com",
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000),
  ...o
});

let kp;
let other;
const calls = [];
function fetchStub({ appsScript, telegram } = {}) {
  return async (url, init) => {
    calls.push(String(url));
    if (String(url) === "https://" + TEAM + "/cdn-cgi/access/certs") return Response.json({ keys: [kp.jwk] });
    if (String(url).startsWith("https://script.example")) {
      if (appsScript === "down") return new Response("nope", { status: 500 });
      return Response.json({
        ok: true,
        lastRun: { at: new Date(NOW - 120000).toISOString(), found: 1, stats: { handled: 1, failed: 0, skipped: 0 } },
        retryCount: 0,
        triggers: ["triggerEmailProcessing"],
        recent: [{ minutesAgo: 3, labelled: true, allowedBank: true, forwarderDomain: "gmail.com" }]
      });
    }
    if (String(url).includes("api.telegram.org")) {
      return Response.json({
        ok: true,
        result: { url: "https://bot.example.workers.dev/", pending_update_count: 0, ...(telegram || {}) }
      });
    }
    throw new Error("unexpected fetch " + url);
  };
}

const ENV = (db) => ({
  DB: db,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ADMIN_EMAILS: "admin@example.com, other@example.com",
  APPS_SCRIPT_URL: "https://script.example/exec",
  INTERNAL_SECRET: "int",
  BOT_TOKEN: "t0k3n",
  BOT_ORIGIN: "https://bot.example.workers.dev"
});

async function get(path, { env, token, cookie, method = "GET", fetchImpl } = {}) {
  const headers = {};
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  if (cookie) headers.Cookie = cookie;
  return handleAdmin(new Request("https://admin.healthvault.online" + path, { method, headers }), env, {
    fetchImpl: fetchImpl || fetchStub(),
    now: NOW
  });
}

beforeEach(async () => {
  resetAccessCache();
  calls.length = 0;
  kp = kp || (await keyPair("k1"));
  other = other || (await keyPair("k1"));
});

describe("Access check", () => {
  it("fails closed when Access isn't configured", async () => {
    const env = { ...ENV(testContext().db), ACCESS_AUD: "" };
    expect((await get("/", { env, token: await sign(kp, claims()) })).status).toBe(403);
    expect((await get("/", { env: { ...ENV(null), ADMIN_EMAILS: "" }, token: await sign(kp, claims()) })).status).toBe(
      403
    );
  });

  it.each([
    ["no token", async () => null],
    ["garbage", async () => "a.b"],
    ["wrong signing key", async () => sign(other, claims())],
    ["unknown key id", async () => sign(kp, claims(), { kid: "nope" })],
    ["HS256", async () => sign(kp, claims(), { alg: "HS256" })],
    ["wrong audience", async () => sign(kp, claims({ aud: ["someone-else"] }))],
    ["wrong issuer", async () => sign(kp, claims({ iss: "https://evil.cloudflareaccess.com" }))],
    ["expired", async () => sign(kp, claims({ exp: Math.floor(NOW / 1000) - 3600 }))],
    ["not an admin", async () => sign(kp, claims({ email: "friend@example.com" }))]
  ])("rejects: %s", async (_name, makeToken) => {
    const res = await get("/api/summary", { env: ENV(testContext().db), token: await makeToken() });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  it("accepts a valid token from the header or the CF_Authorization cookie, and caches the keys", async () => {
    const env = ENV(testContext().db);
    const token = await sign(kp, claims());
    expect((await get("/", { env, token })).status).toBe(200);
    expect((await get("/", { env, cookie: "x=1; CF_Authorization=" + token })).status).toBe(200);
    expect(calls.filter((u) => u.endsWith("/certs"))).toHaveLength(1);
  });
});

describe("pages", () => {
  it("serves the page, script and styles with strict headers; GET only", async () => {
    const env = ENV(testContext().db);
    const token = await sign(kp, claims());
    const page = await get("/", { env, token });
    expect(page.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(page.headers.get("Content-Security-Policy")).toMatch(/script-src 'self'.*frame-ancestors 'none'/);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain('<script src="/app.js"></script>');
    expect(html).not.toMatch(/<script>|style="/);
    expect((await get("/app.js", { env, token })).headers.get("Content-Type")).toMatch(/javascript/);
    expect((await get("/app.css", { env, token })).headers.get("Content-Type")).toMatch(/css/);
    expect((await get("/api/summary", { env, token, method: "POST" })).status).toBe(405);
    expect((await get("/nope", { env, token })).status).toBe(404);
  });
});

describe("/api/summary", () => {
  async function seeded() {
    const ctx = testContext({ llmReplies: [llmTxn({ merchant: "Zomato", amount: 777 })] });
    const alice = await seedTenant(ctx, "111", { email: "alice@x.com", name: "Alice" });
    await seedTenant(ctx, "222", { email: "bob@x.com", name: "Bob" });
    await seedTenant(ctx, "333", { status: "pending" });
    await seedGroup(ctx, "-100", ["111", "222"], "Flat");
    const sms = await ingest(ctx, {
      tenant: alice,
      source: "sms",
      sourceRef: "s1",
      text: "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161"
    });
    await ingest(ctx, { tenant: alice, source: "email", sourceRef: "m1", text: "Your a/c was debited for INR 777" });
    await createSplit(ctx.db, {
      transactionId: sms.transactionId,
      groupId: "-100",
      payerId: "111",
      mode: "50",
      shares: [{ holderId: "222", amountMinor: 12500 }],
      now: NOW
    });
    return ctx;
  }

  it("returns counts, health and parser stats, with masked ids and no personal data", async () => {
    const ctx = await seeded();
    const res = await get("/api/summary?days=7", { env: ENV(ctx.db), token: await sign(kp, claims()) });
    const text = await res.text();
    const d = JSON.parse(text);

    expect(d.email).toBe("admin@example.com");
    expect(d.summary.days).toBe(7);
    expect(d.summary.tenants).toEqual(
      expect.arrayContaining([
        { kind: "personal", status: "active", n: 2 },
        { kind: "personal", status: "pending", n: 1 },
        { kind: "group", status: "active", n: 1 }
      ])
    );
    const users = d.summary.users;
    expect(users).toHaveLength(3);
    for (const u of users) expect(u.id).toMatch(/^u-[0-9a-f]{6}$/);
    expect(users[0]).toMatchObject({ status: "active", emails: 1, txns_total: 2, sms_window: 1, groups: 1 });
    expect(d.summary.groups).toEqual([
      expect.objectContaining({ members: 2, splits_total: 1, splits_window: 1, pinned: 0 })
    ]);
    expect(d.summary.groups[0].id).toMatch(/^g-[0-9a-f]{6}$/);

    const readers = Object.fromEntries(d.summary.parser.templates.map((t) => [t.template, t.saved]));
    expect(readers).toMatchObject({ hdfc_upi_sent_sms_v1: 1, llm: 1 });
    expect(d.summary.readers).toEqual(
      expect.arrayContaining([
        { source: "sms", reader: "parser", n: 1 },
        { source: "email", reader: "llm", n: 1 }
      ])
    );

    expect(d.ops.webhook).toMatchObject({ pointsAtWorker: true, pending: 0, lastError: null });
    expect(d.ops.poller).toMatchObject({ retryCount: 0, hours: 6, triggers: ["triggerEmailProcessing"] });

    for (const secret of [
      "Swiggy",
      "SWIGGY",
      "Zomato",
      "Alice",
      "Bob",
      "alice@x.com",
      "bob@x.com",
      '"111"',
      '"-100"',
      "777",
      "25000",
      "12500",
      "628012345678",
      "1234"
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reports Apps Script and Telegram problems instead of failing", async () => {
    const ctx = await seeded();
    const res = await get("/api/summary", {
      env: { ...ENV(ctx.db), BOT_TOKEN: "" },
      token: await sign(kp, claims()),
      fetchImpl: fetchStub({ appsScript: "down" })
    });
    const d = await res.json();
    expect(d.summary.days).toBe(30);
    expect(d.ops.poller.error).toMatch(/^Apps Script: /);
    expect(d.ops.webhook).toEqual({ error: "BOT_TOKEN not set" });
  });

  it("derives agreement and correction rates per reader", () => {
    expect(
      summarizeTemplate({
        saved: 200,
        shadow_match: 9,
        shadow_mismatch: 1,
        reparse_accepted: 1,
        user_fix: 1,
        report: 2
      })
    ).toMatchObject({
      reads: 210,
      shadowAgreement: 0.9,
      corrections: 2,
      correctionRate: 0.01,
      reports: 2
    });
    expect(summarizeTemplate({})).toMatchObject({ reads: 0, shadowAgreement: null, correctionRate: null });
  });
});
