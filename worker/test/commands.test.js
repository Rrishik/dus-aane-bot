import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { testContext, seedTenant, seedGroup, NOW } from "./helpers/app.js";
import { handleUpdate } from "../src/app/webhook.js";
import { parseBackfillArgs, formatDurationMs, handleBackfillProgress } from "../src/app/backfill.js";
import { signedHeaders, hmacHex } from "../src/app/auth.js";
import { insertTransaction } from "../src/db/transactions.js";
import { createSplit, recordSettlement } from "../src/db/splits.js";
import { getTenant, getTenantEmails } from "../src/db/tenants.js";
import { createTestD1 } from "./helpers/d1.js";
import {
  weeklyTrends,
  monthlyTrends,
  formatTrendsMessage,
  weeklyDigestData,
  formatWeeklyMessage
} from "../src/app/analytics.js";

const msg = (chatId, text, extra = {}) => ({
  message: {
    chat: { id: Number(chatId), type: "private" },
    from: { id: Number(chatId), first_name: "Alice" },
    text,
    ...extra
  }
});
const tap = (chatId, data, messageId = 50) => ({
  callback_query: {
    id: "cb1",
    data,
    from: { id: Number(chatId) },
    message: { chat: { id: Number(chatId) }, message_id: messageId }
  }
});
const texts = (ctx) => ctx.tg.of("sendMessage").map((c) => c.args[1]);

async function addTxn(ctx, tenantId, o = {}) {
  return insertTransaction(
    ctx.db,
    tenantId,
    {
      occurredOn: "2026-10-06",
      amountMinor: 45000,
      currency: "INR",
      direction: "debit",
      kind: "spend",
      merchant: "Swiggy",
      category: "Food",
      forwarder: "alice",
      ...o
    },
    { source: "sms", sourceRef: "s-" + Math.random() },
    NOW
  );
}

describe("commandless onboarding & account ops", () => {
  const toolCall = (name, args = {}) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "tc-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }]
  });

  it("/start welcomes strangers and pins + shows plain-English guide to active users", async () => {
    const ctx = testContext();
    await handleUpdate(ctx, msg("555", "/start"));
    expect(texts(ctx)[0]).toMatch(/^✌️ Hey Alice! Track your spends/);
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "/start"));
    // First message is the pinned live summary, second is the plain-English guide.
    expect(texts(ctx)[1]).toMatch(/^📌 \*Oct 2026\*/);
    expect(texts(ctx)[2]).toMatch(/^\*Just type in plain English\*/);
    expect(ctx.tg.of("pinChatMessage")).toHaveLength(1);
  });

  it("guards unregistered chats from burning LLM tokens while routing pending chats to AccountOpsAgent", async () => {
    const replies = [];
    const ctx = testContext({ llmReplies: replies });
    await handleUpdate(ctx, msg("555", "how much did I spend?"));
    expect(texts(ctx)[0]).toMatch(/I don't know this chat yet/);
    expect(ctx.llm.calls).toHaveLength(0);

    await seedTenant(ctx, "111", { email: "a@x.com", status: "pending" });
    replies.push(toolCall("get_account_status"), "Your setup is pending for a@x.com.");
    await handleUpdate(ctx, msg("111", "what is my account status?"));
    expect(texts(ctx)[1]).toBe("Your setup is pending for a@x.com.");
  });

  it("dormant users can chat with the orchestrator", async () => {
    const ctx = testContext({ llmReplies: ["Welcome back."] });
    await seedTenant(ctx, "111", { status: "dormant" });
    await handleUpdate(ctx, msg("111", "how much this month?"));
    expect(texts(ctx)[0]).toBe("Welcome back.");
  });

  it("bare email reply deterministically creates a pending tenant (0 LLM calls) and sends setup email", async () => {
    const ctx = testContext();
    await handleUpdate(ctx, msg("111", "Alice@X.com"));
    expect(ctx.llm.calls).toHaveLength(0);
    expect(await getTenant(ctx.db, "111")).toMatchObject({ status: "pending", name: "Alice" });
    expect(ctx.asCalls).toEqual([
      expect.objectContaining({ action: "send_setup_email", payload: { chatId: "111", emails: ["alice@x.com"] } })
    ]);
    expect(texts(ctx)[0]).toMatch(/^📬 Auto-forwarding setup emailed to `alice@x.com`/);
    const { body } = ctx.asCalls[0];
    expect(body.sig).toBe(await hmacHex("int", body.ts + ".send_setup_email." + body.payload));
  });

  it("refuses invalid and taken addresses cleanly", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "222", { email: "taken@x.com" });
    await handleUpdate(ctx, msg("111", "register not-an-email"));
    expect(texts(ctx)[0]).toMatch(/doesn't look like a valid email/);
    await handleUpdate(ctx, msg("111", "taken@x.com"));
    expect(texts(ctx)[1]).toBe("❌ That email is already registered to another account.");
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it("active users adding an email get the list and a setup email for just the new one", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111", { email: "a@x.com" });
    await handleUpdate(ctx, msg("111", "register b@x.com"));
    expect(texts(ctx)[0]).toMatch(/Added `b@x.com`.*\n\nRegistered emails:\n• `a@x.com`\n• `b@x.com`/s);
    expect(ctx.asCalls[0].payload.emails).toEqual(["b@x.com"]);
    expect(await getTenantEmails(ctx.db, "111")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("tells the user when the setup email couldn't be sent", async () => {
    const ctx = testContext({ appsScript: () => ({ ok: false, error: "quota" }) });
    await handleUpdate(ctx, msg("111", "a@x.com"));
    expect(texts(ctx)[0]).toMatch(/Couldn't email setup instructions/);
  });

  it("resend_setup button works for pending users; group chats ignore non-commands and unknown commands", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111", { email: "a@x.com", status: "pending" });
    await handleUpdate(ctx, tap("111", "resend_setup"));
    expect(ctx.tg.of("answerCallbackQuery")[0].args[1]).toBe("📬 Sending setup email…");
    expect(ctx.asCalls[0].action).toBe("send_setup_email");

    const group = (text) => ({ message: { chat: { id: -100, type: "group" }, from: { id: 111 }, text } });
    await handleUpdate(ctx, group("hello"));
    await handleUpdate(ctx, group("/othercmd@otherbot"));
    expect(texts(ctx)).toHaveLength(1);
  });

  it("unlisted /sms escape hatch forces SMS parsing on loose text", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "/sms Rs. 92.50 was spent on your card"));
    expect(texts(ctx)[0]).toContain("₹93");
    await handleUpdate(ctx, msg("111", "/sms nothing here"));
    expect(texts(ctx).at(-1)).toBe("ℹ️ No transaction found in that.");
  });
});

describe("pinned dashboard callbacks (Recent & Trends)", () => {
  it("Recent lists confirmed transactions newest first; Trends toggles weekly/monthly", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await addTxn(ctx, "111", { merchant: "Old", occurredOn: "2026-10-01" });
    await addTxn(ctx, "111", { merchant: "Bob's", forwarder: "bob" });
    await addTxn(ctx, "111", { merchant: "Pending", status: "review" });

    await handleUpdate(ctx, tap("111", "stats_recent"));
    const recentEdit = ctx.tg.of("editMessageText")[0].args[2];
    expect(recentEdit).toMatch(
      /^📅 \*Recent Transactions\*\n\n🔴 \*Bob's\* ₹450 · Food\n {3}_6 Oct 2026_\n\n🔴 \*Old\* ₹450 · Food\n {3}_1 Oct 2026_/
    );
    expect(recentEdit).not.toMatch(/Pending/);

    await handleUpdate(ctx, tap("111", "stats_trends"));
    const [, mid, text, opts] = ctx.tg.of("editMessageText")[1].args;
    expect(mid).toBe(50);
    expect(text).toMatch(/Weekly/);
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("stats_trendsmonthly");
    await handleUpdate(ctx, tap("111", "stats_trendsmonthly"));
    expect(ctx.tg.of("editMessageText")[2].args[2]).toMatch(/Monthly/);
    await handleUpdate(ctx, tap("111", "stats_back"));
    expect(ctx.tg.of("editMessageText")[3].args[2]).toBe("📊 *Stats* — pick a view:");
  });
});

describe("analytics", () => {
  it("counts only spend, and only your share of split / none of settled transactions", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"]);
    await addTxn(ctx, "111", { amountMinor: 10000 });
    await addTxn(ctx, "111", { amountMinor: 99900, kind: "transfer", category: "Transfer" });
    const split = await addTxn(ctx, "111", { amountMinor: 60000 });
    await createSplit(ctx.db, {
      transactionId: split,
      groupId: "-100",
      payerId: "111",
      mode: "50",
      shares: [
        { holderId: "111", amountMinor: 30000 },
        { holderId: "222", amountMinor: 30000 }
      ]
    });
    const settle = await addTxn(ctx, "111", { amountMinor: 5000 });
    await recordSettlement(ctx.db, {
      groupId: "-100",
      fromId: "111",
      toId: "222",
      amountMinor: 5000,
      currency: "INR",
      transactionId: settle
    });
    await addTxn(ctx, "111", { amountMinor: 800000, direction: "credit", kind: "income", category: "Income" });

    const weeks = await weeklyTrends(ctx.db, "111", NOW);
    const last = weeks.at(-1);
    expect(last.label).toBe("Sep 30");
    expect(last.debitByCurrency).toEqual({ INR: 400 });
    expect(last.creditByCurrency).toEqual({ INR: 8000 });
    expect(last.categorySpend).toEqual({ Food: 400 });
    const months = await monthlyTrends(ctx.db, "111", NOW);
    expect(months.map((m) => m.label)).toEqual(["May 26", "Jun 26", "Jul 26", "Aug 26", "Sep 26", "Oct 26"]);
    expect(formatTrendsMessage(weeks, { title: "T" })).toMatch(/`Sep 30  ████████  ₹400`/);
  });

  it("weekly digest data and message", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await addTxn(ctx, "111", { amountMinor: 120000, merchant: "Zepto", category: "Groceries" });
    await addTxn(ctx, "111", { amountMinor: 50000, occurredOn: "2026-09-29" });
    const range = { start: "2026-09-30", end: "2026-10-06" };
    const data = await weeklyDigestData(ctx.db, "111", range);
    expect(data.spentByCurrency).toEqual({ INR: 1200 });
    expect(data.prevSpentByCurrency).toEqual({ INR: 500 });
    const text = formatWeeklyMessage(range, data);
    expect(text).toMatch(/^📅 \*Last Week\* — Sep 30–Oct 6\n🔴 ₹1200  _\(vs ₹500, ↑140%\)_/);
    expect(await weeklyDigestData(ctx.db, "111", { start: "2026-01-01", end: "2026-01-07" })).toBeNull();
  });
});

describe("/backfill", () => {
  it("parses compact, spaced and absolute ranges", () => {
    expect(parseBackfillArgs("/backfill 10m", NOW)).toEqual({ ok: true, startMs: NOW - 600000, endMs: NOW });
    expect(parseBackfillArgs("/backfill 3 days", NOW).startMs).toBe(NOW - 3 * 86400000);
    expect(parseBackfillArgs("/backfill 2026-10-01 2026-10-02", NOW)).toEqual({
      ok: true,
      startMs: Date.UTC(2026, 8, 30, 18, 30),
      endMs: Date.UTC(2026, 9, 2, 18, 30) - 1
    });
    expect(parseBackfillArgs("/backfill", NOW).error).toBe("usage");
    expect(parseBackfillArgs("/backfill 5 fortnights", NOW).error).toBe("unknown_unit");
    expect(parseBackfillArgs("/backfill nope bad", NOW).error).toBe("invalid_dates");
    expect(parseBackfillArgs("/backfill 2026-10-05 2026-10-01", NOW).error).toBe("invalid_range");
    expect(formatDurationMs(90061000)).toBe("1d 1h 1m");
  });

  it("records the job via AccountOpsAgent, asks Apps Script to run it, and refuses a second one", async () => {
    const tc = (range) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "bf", type: "function", function: { name: "start_backfill", arguments: JSON.stringify({ range }) } }
      ]
    });
    const ctx = testContext({ llmReplies: [tc("2d"), "", tc("1d"), ""] });
    await seedTenant(ctx, "111", { email: "a@x.com" });
    await handleUpdate(ctx, msg("111", "backfill last 2 days"));
    expect(ctx.asCalls[0]).toMatchObject({
      action: "backfill_range",
      payload: { chatId: "111", emails: ["a@x.com"], startMs: NOW - 2 * 86400000, endMs: NOW }
    });
    expect(texts(ctx)[0]).toMatch(/^⏳ \*Backfill started\* _\(2d\)_/);
    await handleUpdate(ctx, msg("111", "backfill 1 day"));
    expect(texts(ctx)[1]).toMatch(/already running/);
  });

  it("drops the job if Apps Script can't start it", async () => {
    const tc = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "bf", type: "function", function: { name: "start_backfill", arguments: '{"range":"1d"}' } }]
    };
    const ctx = testContext({ appsScript: () => ({ ok: false }), llmReplies: [tc, ""] });
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "backfill 1 day"));
    expect(texts(ctx)[0]).toMatch(/Couldn't start the backfill/);
    expect(await ctx.db.prepare("SELECT COUNT(*) AS n FROM backfill_jobs").first("n")).toBe(0);
  });

  it("progress reports update the job; the final one summarises and clears it", async () => {
    const tc = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "bf", type: "function", function: { name: "start_backfill", arguments: '{"range":"1d"}' } }]
    };
    const ctx = testContext({ llmReplies: [tc, ""] });
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "backfill 1 day"));
    const post = async (payload, secret = "int") => {
      const body = JSON.stringify(payload);
      const headers = await signedHeaders(secret, body, ctx.now());
      return handleBackfillProgress(ctx, new Request("https://w/internal/backfill", { method: "POST", headers, body }));
    };
    expect((await post({ chatId: "111" }, "bad")).status).toBe(401);
    await post({ chatId: "111", saved: 3, dupes: 1, failed: 0 });
    expect(texts(ctx).at(-1)).toMatch(/^⏳ \*Backfill chunk 1 done\*\n💾 Saved so far: 3\n🔁 Dupes: 1/);
    await post({ chatId: "111", saved: 2, dupes: 0, failed: 1, totalEmails: 7, done: true });
    expect(texts(ctx).at(-1)).toMatch(
      /Backfill Complete.*Emails processed:\* 7.*Transactions saved:\* 5.*Failed:\* 1.*Chunks:\* 2/s
    );
    expect(await ctx.db.prepare("SELECT COUNT(*) AS n FROM backfill_jobs").first("n")).toBe(0);
    expect((await post({ chatId: "111", saved: 1 })).status).toBe(404);
  });
});

describe("webhook route", () => {
  it("checks Telegram's secret header and processes in the background", async () => {
    const waits = [];
    const env = { WEBHOOK_SECRET: "k1" };
    const req = (h) =>
      new Request("https://w/", { method: "POST", headers: h, body: JSON.stringify({ update_id: 1 }) });
    expect((await worker.fetch(req({}), env, { waitUntil: (p) => waits.push(p) })).status).toBe(401);
    const res = await worker.fetch(req({ "X-Telegram-Bot-Api-Secret-Token": "k1" }), env, {
      waitUntil: (p) => waits.push(p)
    });
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
    await waits[0];
  });

  it("accepts nothing when no webhook secret is configured", async () => {
    const req = new Request("https://w/", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "" },
      body: "{}"
    });
    expect((await worker.fetch(req, {}, { waitUntil() {} })).status).toBe(401);
  });

  it("internal routes need a signature", async () => {
    const env = { DB: createTestD1(), INTERNAL_SECRET: "int" };
    for (const path of ["/internal/backfill", "/ingest/email"]) {
      const res = await worker.fetch(new Request("https://w" + path, { method: "POST", body: "{}" }), env, {
        waitUntil() {}
      });
      expect(res.status).toBe(401);
    }
  });
});
