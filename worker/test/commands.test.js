import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { testContext, seedTenant, seedGroup, NOW } from "./helpers/app.js";
import { handleUpdate } from "../src/app/webhook.js";
import { parseBackfillArgs, formatDurationMs, handleBackfillProgress } from "../src/app/backfill.js";
import { signedHeaders, hmacHex } from "../src/app/auth.js";
import { insertTransaction } from "../src/db/transactions.js";
import { createSplit, recordSettlement } from "../src/db/splits.js";
import { getTenant, getTenantEmails } from "../src/db/tenants.js";
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
      category: "Food & Dining",
      forwarder: "alice",
      ...o
    },
    { source: "sms", sourceRef: "s-" + Math.random() },
    NOW
  );
}

describe("onboarding commands", () => {
  it("/start welcomes strangers and shows help to active users", async () => {
    const ctx = testContext();
    await handleUpdate(ctx, msg("555", "/start"));
    expect(texts(ctx)[0]).toMatch(/^✌️ Hey Alice! Track your spends/);
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "/start"));
    expect(texts(ctx)[1]).toMatch(/^\*Commands\*/);
  });

  it("gates everything but onboarding for unknown and pending chats", async () => {
    const ctx = testContext();
    await handleUpdate(ctx, msg("555", "/recent"));
    expect(texts(ctx)[0]).toMatch(/I don't know this chat yet/);
    await seedTenant(ctx, "111", { status: "pending" });
    await handleUpdate(ctx, msg("111", "/stats"));
    expect(texts(ctx)[1]).toMatch(/setup isn't active yet/);
    await handleUpdate(ctx, msg("111", "/account"));
    expect(texts(ctx)[2]).toMatch(/^\*Your account\*\nStatus: `pending`/);
  });

  it("dormant users can use commands", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111", { status: "dormant" });
    await handleUpdate(ctx, msg("111", "/help"));
    expect(texts(ctx)[0]).toMatch(/^\*Commands\*/);
  });

  it("/register <email> creates a pending tenant and asks Apps Script to send the setup email", async () => {
    const ctx = testContext();
    await handleUpdate(ctx, msg("111", "/register Alice@X.com"));
    expect(await getTenant(ctx.db, "111")).toMatchObject({ status: "pending", name: "Alice" });
    expect(ctx.asCalls).toEqual([
      expect.objectContaining({ action: "send_setup_email", payload: { chatId: "111", emails: ["alice@x.com"] } })
    ]);
    expect(texts(ctx)[0]).toMatch(/^📬 Auto-forwarding setup emailed to `alice@x.com`/);
    const { body } = ctx.asCalls[0];
    expect(body.sig).toBe(await hmacHex("int", body.ts + ".send_setup_email." + body.payload));
  });

  it("bare /register waits for the address; invalid and taken addresses are refused", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "222", { email: "taken@x.com" });
    await handleUpdate(ctx, msg("111", "/register"));
    expect(texts(ctx)[0]).toMatch(/What's the Gmail address/);
    await handleUpdate(ctx, msg("111", "not-an-email"));
    expect(texts(ctx)[1]).toMatch(/doesn't look like a valid email/);
    await handleUpdate(ctx, msg("111", "/register taken@x.com"));
    expect(texts(ctx)[2]).toBe("❌ That email is already registered to another account.");
  });

  it("active users adding an email get the list and a setup email for just the new one", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111", { email: "a@x.com" });
    await handleUpdate(ctx, msg("111", "/register b@x.com"));
    expect(texts(ctx)[0]).toMatch(/Added `b@x.com`.*\n\nRegistered emails:\n• `a@x.com`\n• `b@x.com`/s);
    expect(ctx.asCalls[0].payload.emails).toEqual(["b@x.com"]);
    expect(await getTenantEmails(ctx.db, "111")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("tells the user when the setup email couldn't be sent", async () => {
    const ctx = testContext({ appsScript: () => ({ ok: false, error: "quota" }) });
    await handleUpdate(ctx, msg("111", "/register a@x.com"));
    expect(texts(ctx)[0]).toMatch(/Couldn't email setup instructions/);
  });

  it("/account shows status, emails and a resend button that works for pending users", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111", { email: "a@x.com", status: "pending" });
    await handleUpdate(ctx, msg("111", "/account"));
    const [, text, opts] = ctx.tg.of("sendMessage")[0].args;
    expect(text).toMatch(/Emails: `a@x.com`\nData: stored with the bot/);
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("resend_setup");

    await handleUpdate(ctx, tap("111", "resend_setup"));
    expect(ctx.tg.of("answerCallbackQuery")[0].args[1]).toBe("📬 Sending...");
    expect(ctx.asCalls[0].action).toBe("send_setup_email");
  });

  it("unknown commands get a hint; group chats ignore non-commands and unknown commands", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "/nope"));
    expect(texts(ctx)[0]).toMatch(/Unknown command/);
    const group = (text) => ({ message: { chat: { id: -100, type: "group" }, from: { id: 111 }, text } });
    await handleUpdate(ctx, group("hello"));
    await handleUpdate(ctx, group("/othercmd@otherbot"));
    expect(texts(ctx)).toHaveLength(1);
  });

  it("/sheet points to /export", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "/sheet"));
    expect(texts(ctx)[0]).toMatch(/\/export/);
  });
});

describe("/recent and /stats", () => {
  it("/recent lists confirmed transactions newest first, with a user filter", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await addTxn(ctx, "111", { merchant: "Old", occurredOn: "2026-10-01" });
    await addTxn(ctx, "111", { merchant: "Bob's", forwarder: "bob" });
    await addTxn(ctx, "111", { merchant: "Pending", status: "review" });
    await handleUpdate(ctx, msg("111", "/recent"));
    expect(texts(ctx)[0]).toMatch(
      /^📅 \*Recent Transactions\*\n\n🔴 \*Bob's\* ₹450 · Food\n {3}_07 Oct 2026, 13:30_\n\n🔴 \*Old\*/
    );
    expect(texts(ctx)[0]).not.toMatch(/Pending/);
    await handleUpdate(ctx, msg("111", "/recent 10 bob"));
    expect(texts(ctx)[1]).toMatch(/\(user: bob\)/);
    expect(texts(ctx)[1]).not.toMatch(/Old/);
  });

  it("/stats opens the menu; Trends edits in place and toggles weekly/monthly", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await addTxn(ctx, "111");
    await handleUpdate(ctx, msg("111", "/stats"));
    expect(ctx.tg.of("sendMessage")[0].args[2].reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      "stats_recent",
      "stats_trends"
    ]);
    await handleUpdate(ctx, tap("111", "stats_trends"));
    const [, mid, text, opts] = ctx.tg.of("editMessageText")[0].args;
    expect(mid).toBe(50);
    expect(text).toMatch(/Weekly/);
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("stats_trendsmonthly");
    await handleUpdate(ctx, tap("111", "stats_trendsmonthly"));
    expect(ctx.tg.of("editMessageText")[1].args[2]).toMatch(/Monthly/);
    await handleUpdate(ctx, tap("111", "stats_back"));
    expect(ctx.tg.of("editMessageText")[2].args[2]).toBe("📊 *Stats* — pick a view:");
  });
});

describe("analytics", () => {
  it("counts only spend, and only your share of split / none of settled transactions", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"]);
    await addTxn(ctx, "111", { amountMinor: 10000 });
    await addTxn(ctx, "111", { amountMinor: 99900, kind: "card_payment", category: "CC Bill Payment" });
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
    await addTxn(ctx, "111", { amountMinor: 800000, direction: "credit", kind: "income", category: "Salary" });

    const weeks = await weeklyTrends(ctx.db, "111", NOW);
    const last = weeks.at(-1);
    expect(last.label).toBe("Sep 30");
    expect(last.debitByCurrency).toEqual({ INR: 400 });
    expect(last.creditByCurrency).toEqual({ INR: 8000 });
    expect(last.categorySpend).toEqual({ "Food & Dining": 400 });
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

  it("records the job, asks Apps Script to run it, and refuses a second one", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111", { email: "a@x.com" });
    await handleUpdate(ctx, msg("111", "/backfill 2d"));
    expect(ctx.asCalls[0]).toMatchObject({
      action: "backfill_range",
      payload: { chatId: "111", emails: ["a@x.com"], startMs: NOW - 2 * 86400000, endMs: NOW }
    });
    expect(texts(ctx)[0]).toMatch(/^⏳ \*Backfill started\* _\(2d\)_/);
    await handleUpdate(ctx, msg("111", "/backfill 1d"));
    expect(texts(ctx)[1]).toMatch(/already running/);
  });

  it("drops the job if Apps Script can't start it", async () => {
    const ctx = testContext({ appsScript: () => ({ ok: false }) });
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "/backfill 1d"));
    expect(texts(ctx)[0]).toMatch(/Couldn't start the backfill/);
    expect(await ctx.db.prepare("SELECT COUNT(*) AS n FROM backfill_jobs").first("n")).toBe(0);
  });

  it("progress reports update the job; the final one summarises and clears it", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    await handleUpdate(ctx, msg("111", "/backfill 1d"));
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

describe("native webhook route", () => {
  it("checks Telegram's secret header and processes in the background", async () => {
    const waits = [];
    const env = { MODE: "native", WEBHOOK_SECRET: "k1" };
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

  it("stays in proxy mode unless MODE=native", async () => {
    const res = await worker.fetch(
      new Request("https://w/internal/backfill", { method: "POST", body: "{}" }),
      {},
      { waitUntil() {} }
    );
    expect(res.status).toBe(409);
  });
});
