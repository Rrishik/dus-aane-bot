import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { testContext, seedTenant, seedGroup, llmTxn, NOW } from "./helpers/app.js";
import { handleSmsPaste, smsSourceRef } from "../src/app/sms.js";
import { handleIngestEmail } from "../src/app/ingestRoute.js";
import { signedHeaders, verifySignedRequest, hmacHex } from "../src/app/auth.js";
import { listTransactions } from "../src/db/transactions.js";
import { addGroupInvite, getGroupMembers, registerEmail } from "../src/db/tenants.js";

const HDFC_SMS =
  "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161";
const notes = (ctx) => ctx.tg.of("sendMessage").map((c) => c.args[1]);

describe("handleSmsPaste", () => {
  it("returns false for plain chat (no amount) and stays silent", async () => {
    const ctx = testContext();
    const t = await seedTenant(ctx, "111");
    expect(await handleSmsPaste(ctx, t, "111", "hey, what's up?")).toBe(false);
    expect(ctx.tg.calls).toEqual([]);
  });

  it("gates unknown chats", async () => {
    const ctx = testContext();
    expect(await handleSmsPaste(ctx, null, "555", HDFC_SMS)).toBe(true);
    expect(notes(ctx)).toEqual(["👋 I don't know this chat yet. Send `/start` to onboard."]);
  });

  it("saves, then reports a re-paste as already recorded", async () => {
    const ctx = testContext();
    const t = await seedTenant(ctx, "111");
    await handleSmsPaste(ctx, t, "111", HDFC_SMS);
    await handleSmsPaste(ctx, t, "111", "  " + HDFC_SMS.toLowerCase() + "  ");
    expect(await listTransactions(ctx.db, "111")).toHaveLength(1);
    expect(notes(ctx).at(-1)).toBe("ℹ️ Already recorded.");
  });

  it("handles several SMS at once and reports OTPs", async () => {
    const ctx = testContext();
    const t = await seedTenant(ctx, "111");
    const paste = HDFC_SMS + "\n\n" + HDFC_SMS.replace("250.00", "99.00").replace("628012345678", "628099999999");
    await handleSmsPaste(ctx, t, "111", paste + "\n\nOTP for txn of Rs 999 at AMAZON is 123456");
    expect(await listTransactions(ctx.db, "111")).toHaveLength(2);
    expect(notes(ctx).at(-1)).toBe("ℹ️ 1 had no transaction.");
  });

  it("a pending user's first pasted SMS activates them", async () => {
    const ctx = testContext();
    const t = await seedTenant(ctx, "111", { status: "pending" });
    await handleSmsPaste(ctx, t, "111", HDFC_SMS);
    expect((await ctx.db.prepare("SELECT status FROM tenants WHERE id='111'").first()).status).toBe("active");
    expect(notes(ctx).some((n) => /first transaction is in/.test(n))).toBe(true);
  });

  it("source refs ignore case and whitespace", async () => {
    expect(await smsSourceRef("Rs 100  debited\nat X")).toBe(await smsSourceRef("rs 100 debited at x"));
    expect(await smsSourceRef("Rs 100 debited")).toMatch(/^sms-[0-9a-f]{16}$/);
  });
});

describe("request signing", () => {
  it("round-trips and rejects tampering, staleness and missing secrets", async () => {
    const body = '{"a":1}';
    const headers = await signedHeaders("s3cret", body, NOW);
    const req = (b, h) => new Request("https://w/ingest/email", { method: "POST", headers: h, body: b });
    expect(await verifySignedRequest(req(body, headers), "s3cret", NOW + 1000)).toEqual({ ok: true, body });
    expect((await verifySignedRequest(req('{"a":2}', headers), "s3cret", NOW)).ok).toBe(false);
    expect((await verifySignedRequest(req(body, headers), "s3cret", NOW + 10 * 60000)).reason).toBe("stale");
    expect((await verifySignedRequest(req(body, headers), "", NOW)).reason).toBe("not configured");
  });

  it("matches Apps Script's computeHmacSha256Signature hex for the same input", async () => {
    // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog") — RFC test vector.
    expect(await hmacHex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    );
  });
});

describe("POST /ingest/email", () => {
  async function post(ctx, payload, secret = "ing") {
    const body = JSON.stringify(payload);
    const headers = await signedHeaders(secret, body, ctx.now());
    return handleIngestEmail(ctx, new Request("https://w/ingest/email", { method: "POST", headers, body }));
  }
  const EMAIL = "Rs.250.00 has been debited from account **1234 to VPA swiggy@ybl SWIGGY on 07-10-26.";

  it("routes by forwarder, saves, and labels-OK with 200", async () => {
    const ctx = testContext({ env: { INGEST_SECRET: "ing" }, llmReplies: [llmTxn()] });
    await seedTenant(ctx, "111", { email: "alice@x.com" });
    const res = await post(ctx, { messageId: "g1", forwarder: "Alice@x.com", receivedAt: NOW, text: EMAIL });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "saved" });
  });

  it("401 on a bad signature, 400 on a malformed body, no_tenant for strangers", async () => {
    const ctx = testContext({ env: { INGEST_SECRET: "ing" } });
    expect((await post(ctx, { messageId: "g1" }, "wrong")).status).toBe(401);
    expect((await post(ctx, { messageId: "g1" })).status).toBe(400);
    const res = await post(ctx, { messageId: "g1", forwarder: "nobody@x.com", text: EMAIL });
    expect(await res.json()).toEqual({ status: "no_tenant" });
  });

  it("503 when the LLM is down so the poller retries", async () => {
    const ctx = testContext({ env: { INGEST_SECRET: "ing" }, llmReplies: [new Error("down")] });
    await seedTenant(ctx, "111", { email: "alice@x.com" });
    const res = await post(ctx, { messageId: "g1", forwarder: "alice@x.com", text: EMAIL });
    expect(res.status).toBe(503);
  });

  it("a pending tenant's first forward activates them and consumes group invites", async () => {
    const ctx = testContext({ env: { INGEST_SECRET: "ing" }, llmReplies: [llmTxn()] });
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["222"], "Flat");
    await registerEmail(ctx.db, "111", "alice@x.com", "Alice", NOW);
    await addGroupInvite(ctx.db, "111", "-100", NOW);

    const res = await post(ctx, { messageId: "g1", forwarder: "alice@x.com", text: EMAIL });
    expect((await res.json()).status).toBe("saved");
    expect((await ctx.db.prepare("SELECT status FROM tenants WHERE id='111'").first()).status).toBe("active");
    expect(await getGroupMembers(ctx.db, "-100")).toEqual(["222", "111"]);
    expect(ctx.tg.of("sendMessage").map((c) => c.args[0])).toEqual(["111", "-100", "111"]);
  });
});

describe("router modes", () => {
  it("/ingest/email is refused until MODE=native", async () => {
    const res = await worker.fetch(
      new Request("https://w/ingest/email", { method: "POST", body: "{}" }),
      {},
      { waitUntil() {} }
    );
    expect(res.status).toBe(409);
  });
});
