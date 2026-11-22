import { describe, it, expect } from "vitest";
import { testContext, seedTenant, seedGroup, llmTxn, NOW } from "./helpers/app.js";
import { ingest } from "../src/app/ingest.js";
import {
  warmLatestFxRates,
  enrichTransactionFx,
  sweepPendingFxConversions,
  invertBaseInrRates
} from "../src/app/fx.js";
import { ensurePersonalPin, personalPinData, formatPersonalPin } from "../src/app/personalPin.js";
import { askToolExecutor } from "../src/app/orchestratorTools.js";
import { handleQueue } from "../src/index.js";
import { createSplit } from "../src/db/splits.js";
import { getTransaction, insertTransaction } from "../src/db/transactions.js";

describe("Async FX conversion (Option 1: Cron-warmed fx_rates + Queue miss-backfill)", () => {
  it("inverts ECB base-INR rates and derives USD-pegged GCC & fixed-INR currencies", () => {
    const map = invertBaseInrRates({ USD: 0.01, THB: 0.4 });
    expect(map.USD).toBe(100);
    expect(map.THB).toBe(2.5);
    expect(map.INR).toBe(1);
    expect(map.NPR).toBe(0.625);
    expect(map.AED).toBeCloseTo(100 / 3.6725, 4);
    expect(map.SAR).toBeCloseTo(100 / 3.75, 4);
  });

  it("0ms hot-path ingest converts foreign spends immediately when daily fx_rates cache is warm", async () => {
    const ctx = testContext({
      now: NOW,
      llmReplies: [
        llmTxn({
          transaction_date: "2026-10-07",
          merchant: "Firefly",
          amount: 521,
          currency: "THB",
          category: "Travel",
          transaction_type: "Debit"
        })
      ],
      fxReply: {
        amount: 1.0,
        base: "INR",
        date: "2026-10-06",
        rates: { THB: 0.4, USD: 0.01 }
      }
    });
    const alice = await seedTenant(ctx, "111");
    await ensurePersonalPin(ctx, "111");

    // 1. Morning 08:00 IST cron warms fx_rates in 1 HTTP GET (1 THB = 2.5 INR).
    const warmed = await warmLatestFxRates(ctx, "2026-10-07");
    expect(warmed.ok).toBe(true);
    expect(ctx.fxCalls).toHaveLength(1);

    // 2. Live THB ingest hits local D1 cache in 0ms (no extra fxCalls!) and renders (~₹1303) on the card + pin!
    const res = await ingest(ctx, {
      tenant: alice,
      source: "email",
      sourceRef: "e-thb-warm",
      text: "THB 521.00 spent on Card 2300 at FIREFLY on 2026-10-07."
    });
    expect(ctx.fxCalls).toHaveLength(1);
    const saved = await getTransaction(ctx.db, "111", res.transactionId);
    expect(saved).toMatchObject({
      amount_minor: 52100,
      currency: "THB",
      inr_minor: 130250,
      fx_rate: 2.5
    });

    const cardSent = ctx.tg.of("sendMessage").at(-1).args[1];
    expect(cardSent).toContain("฿521 (~₹1303)");

    const pin = formatPersonalPin(await personalPinData(ctx, "111"));
    expect(pin).toContain("~₹1.3K spent");
    expect(pin).toContain("🚕 Travel ₹1.3K");
  });

  it("enqueues fx_enrich on historical cache miss, updates card & pin asynchronously, prorates 50/50 splits, and falls back to open.er-api", async () => {
    const queued = [];
    const fxHandler = (url) => {
      if (url.includes("frankfurter.dev/v1/2026-10-02")) {
        return { base: "INR", date: "2026-10-02", rates: { THB: 0.4, USD: 0.01 } };
      }
      if (url.includes("frankfurter.dev")) {
        return { base: "INR", date: "2026-10-05", rates: { USD: 0.01 } };
      }
      if (url.includes("open.er-api.com")) {
        return { result: "success", base_code: "INR", rates: { VND: 250 } };
      }
      return null;
    };

    const ctx = testContext({
      now: NOW,
      env: {
        UPDATES: {
          async send(msg) {
            queued.push(msg);
          }
        }
      },
      llmReplies: [
        llmTxn({
          transaction_date: "2026-10-02",
          merchant: "Two Villas Holiday",
          amount: 2000,
          currency: "THB",
          category: "Travel",
          transaction_type: "Debit"
        })
      ],
      fxReply: fxHandler
    });
    const alice = await seedTenant(ctx, "111");
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"]);
    await ensurePersonalPin(ctx, "111");

    // 1. Cache miss on 2026-10-02 -> saves immediately with inr_minor = null and enqueues fx_enrich!
    const res = await ingest(ctx, {
      tenant: alice,
      source: "email",
      sourceRef: "e-thb-miss",
      text: "THB 2000 spent at TWO VILLAS HOLIDAY on 2026-10-02."
    });
    expect(await getTransaction(ctx.db, "111", res.transactionId)).toMatchObject({
      amount_minor: 200000,
      currency: "THB",
      inr_minor: null
    });
    expect(queued).toEqual([{ kind: "fx_enrich", tenantId: "111", txnId: res.transactionId }]);

    // 2. Async queue worker dispatches fx_enrich cleanly and acks the message.
    let acked = false;
    await handleQueue(
      {
        messages: [
          {
            body: { kind: "fx_enrich", tenantId: "111", txnId: "nonexistent" },
            ack() {
              acked = true;
            }
          }
        ]
      },
      { DB: ctx.db, BOT_TOKEN: "unused" }
    );
    const enriched = await enrichTransactionFx(ctx, "111", res.transactionId);
    expect(acked).toBe(true);
    expect(enriched).toEqual({ ok: true, inrMinor: 500000, fxRate: 2.5 });
    expect(ctx.tg.of("editMessageText").some((c) => String(c.args[2]).includes("฿2000 (~₹5000)"))).toBe(true);

    // 3. Split 50/50 in group + add an INR DMart spend (₹3096) -> Two Villas (~₹2500 own share vs ₹5000 unsplit):
    //    Before split, Two Villas (~₹5000) ranks ABOVE DMart (₹3096) in get_top_merchants!
    await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-03",
        amountMinor: 309600,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "DMart",
        category: "Groceries"
      },
      { source: "email", sourceRef: "e-dmart" },
      NOW
    );
    const run = askToolExecutor(ctx, "111");
    const topUnsplit = await run("get_top_merchants", { start_date: "2026-10-01", end_date: "2026-10-07" });
    expect(topUnsplit.merchants[0]).toMatchObject({
      name: "Two Villas Holiday",
      currency: "THB",
      amount: 2000,
      amount_inr: 5000
    });
    expect(topUnsplit.merchants[1]).toMatchObject({ name: "DMart", currency: "INR", amount: 3096 });

    // After 50/50 split (own share = THB 1000 = ~₹2500), prorated effective_inr_minor = ₹2500!
    await createSplit(ctx.db, {
      transactionId: res.transactionId,
      groupId: "-100",
      payerId: "111",
      mode: "50",
      shares: [
        { holderId: "111", amountMinor: 100000 },
        { holderId: "222", amountMinor: 100000 }
      ]
    });
    const runAfterSplit = askToolExecutor(ctx, "111");
    const summary = await runAfterSplit("get_spending_summary", { start_date: "2026-10-01", end_date: "2026-10-07" });
    expect(summary).toMatchObject({
      spend_by_currency: { THB: 1000, INR: 3096 },
      total_spend_inr: 5596,
      includes_converted_fx: true
    });

    // Personal pin also converts the THB 1000 group balance owed to Alice (~₹2500)!
    const pinAfterSplit = formatPersonalPin(await personalPinData(ctx, "111"));
    expect(pinAfterSplit).toContain("~₹5.6K spent");
    expect(pinAfterSplit).toContain("owed ~₹2500");

    // 4. Non-ECB currency (`VND`) falls back to `open.er-api.com` (`1 INR = 250 VND` -> `inr_rate = 0.004`).
    const idVnd = await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-05",
        amountMinor: 10000000,
        currency: "VND",
        direction: "debit",
        kind: "spend",
        merchant: "Grab",
        category: "Travel"
      },
      { source: "email", sourceRef: "e-vnd" },
      NOW
    );
    const swept = await sweepPendingFxConversions(ctx, { tenantId: "111" });
    expect(swept.converted).toBe(1);
    expect(await getTransaction(ctx.db, "111", idVnd)).toMatchObject({ inr_minor: 40000, fx_rate: 0.004 });
  });
});
