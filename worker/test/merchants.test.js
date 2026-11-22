import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testContext, seedTenant, llmTxn, NOW } from "./helpers/app.js";
import { createTestD1 } from "./helpers/d1.js";
import { ingest } from "../src/app/ingest.js";
import { handleUpdate } from "../src/app/webhook.js";
import { sendParserDigest } from "../src/app/cron.js";
import { askToolExecutor } from "../src/app/orchestratorTools.js";
import {
  canonicalizeMerchant,
  normalizeUserMerchantInput,
  normalizeTenantMerchants,
  detectCcBillCardLast4,
  formatCcBillMerchant
} from "../src/app/merchants.js";
import { getTransaction, insertTransaction } from "../src/db/transactions.js";
import { getMerchantRules, upsertMerchantRule, promoteConsensusMerchantRules } from "../src/db/merchantRules.js";
import { getAccountLabels } from "../src/db/accountLabels.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

describe("canonicalizeMerchant & normalizeUserMerchantInput", () => {
  it("normalizes brands, legal names, clearing houses (SIP/ICCL -> Mutual Funds), gateways, currencies, and VPAs", () => {
    expect(canonicalizeMerchant("BLINKIT")).toMatchObject({ merchant: "Blinkit", category: "Groceries" });
    expect(canonicalizeMerchant("BLINK COMMERCE PVT LTD")).toMatchObject({
      merchant: "Blinkit",
      category: "Groceries"
    });
    expect(canonicalizeMerchant("KIRANAKART TECHNOLOGIES")).toMatchObject({
      merchant: "Zepto",
      category: "Groceries"
    });
    expect(canonicalizeMerchant("DMART")).toMatchObject({ merchant: "DMart", category: "Groceries" });
    expect(canonicalizeMerchant("AVENUE")).toMatchObject({ merchant: "DMart", category: "Groceries" });
    expect(canonicalizeMerchant("Avenue")).toMatchObject({ merchant: "DMart", category: "Groceries" });
    expect(canonicalizeMerchant("AVENUE SUPERMART")).toMatchObject({ merchant: "DMart", category: "Groceries" });
    expect(canonicalizeMerchant("AVENUE E-COMMERCE LTD")).toMatchObject({ merchant: "DMart", category: "Groceries" });
    expect(canonicalizeMerchant("Park Avenue")).toMatchObject({ merchant: "Park Avenue", category: null });
    expect(canonicalizeMerchant("SWIGGY INSTAMART")).toMatchObject({ merchant: "Instamart", category: "Groceries" });
    expect(canonicalizeMerchant("BUNDL TECHNOLOGIES PVT LTD")).toMatchObject({ merchant: "Swiggy", category: "Food" });
    expect(canonicalizeMerchant("SCOOTSY LOGISTICS")).toMatchObject({ merchant: "Swiggy", category: "Food" });
    expect(canonicalizeMerchant("FSN E-COMMERCE VENTURES")).toMatchObject({
      merchant: "Nykaa",
      category: "Shopping"
    });
    expect(canonicalizeMerchant("INFINITI RETAIL LTD")).toMatchObject({ merchant: "Croma", category: "Shopping" });
    expect(canonicalizeMerchant("BIGTREE ENTERTAINMENT")).toMatchObject({ merchant: "BookMyShow", category: "Fun" });
    expect(canonicalizeMerchant("ROPPEN TRANSPORTATION")).toMatchObject({ merchant: "Rapido", category: "Travel" });
    expect(canonicalizeMerchant("URBANCLAP TECHNOLOGIES INDIA PVT LTD")).toMatchObject({
      merchant: "Urban Company",
      category: "Bills"
    });
    expect(canonicalizeMerchant("INDIAN CLEARING CORP LTD")).toMatchObject({
      merchant: "Mutual Funds",
      category: "Invest",
      kind: "investment"
    });
    expect(canonicalizeMerchant("SIP")).toMatchObject({ merchant: "Mutual Funds", category: "Invest" });
    expect(canonicalizeMerchant("DREAMPLUG TECHNOLOGIES")).toMatchObject({
      merchant: "CC Bill",
      category: "Transfer",
      kind: "transfer"
    });
    expect(canonicalizeMerchant("RAZORPAY*EAZYDINER")).toMatchObject({ merchant: "EazyDiner", category: "Food" });
    expect(canonicalizeMerchant("TWO VILLAS HOLIDAY CO ,LT")).toMatchObject({
      merchant: "Two Villas Holiday",
      category: null
    });
    expect(canonicalizeMerchant("FIREFLY THB")).toMatchObject({ merchant: "Firefly", category: null });
    expect(canonicalizeMerchant("JARAPLA ARCHANA")).toMatchObject({ merchant: "Jarapla Archana", category: null });
    expect(canonicalizeMerchant("swiggy@ybl")).toMatchObject({ merchant: "Swiggy", category: "Food" });
    expect(canonicalizeMerchant("ox981234...@pty")).toEqual({ merchant: null, category: null, kind: null });

    expect(normalizeUserMerchantInput("sip")).toBe("Mutual Funds");
    expect(normalizeUserMerchantInput("mf")).toBe("Mutual Funds");
    expect(normalizeUserMerchantInput("dmart")).toBe("DMart");
    expect(normalizeUserMerchantInput("avenue")).toBe("DMart");
    expect(normalizeUserMerchantInput("d mart")).toBe("DMart");
    expect(normalizeUserMerchantInput("chai")).toBe("Chai");
  });

  it("normalizeTenantMerchants normalizes rules before transactions and recovers truncated raw corporate names", async () => {
    const db = createTestD1();
    await db
      .prepare("INSERT INTO tenants (id, kind, status, created_at) VALUES ('111', 'personal', 'active', ?)")
      .bind(NOW)
      .run();
    // Stale learned rule with uncanonicalized `Avenue` name + historical `Avenue` row.
    await upsertMerchantRule(db, "111", "avenue", { name: "Avenue", category: "Groceries" }, NOW);
    await insertTransaction(
      db,
      "111",
      {
        occurredOn: "2026-11-10",
        amountMinor: 309600,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "Avenue",
        merchantRaw: "AVENUE",
        category: "Groceries"
      },
      { source: "email", sourceRef: "e-avenue" },
      NOW
    );
    // Truncated `merchant` whose `merchant_raw` contains a full corporate brand, vs user-renamed "Team Lunch".
    const rTrunc = await insertTransaction(
      db,
      "111",
      {
        occurredOn: "2026-11-11",
        amountMinor: 50000,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "Infiniti",
        merchantRaw: "INFINITI RETAIL LIMITED",
        category: null
      },
      { source: "email", sourceRef: "e-infiniti" },
      NOW
    );
    const rCustom = await insertTransaction(
      db,
      "111",
      {
        occurredOn: "2026-11-12",
        amountMinor: 90000,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "Team Lunch",
        merchantRaw: "BUNDL TECHNOLOGIES",
        category: "Food"
      },
      { source: "email", sourceRef: "e-custom" },
      NOW
    );

    const rules = await getMerchantRules(db, "111");
    await normalizeTenantMerchants(db, "111", rules, NOW);

    const avenueRows = (
      await db.prepare("SELECT merchant FROM transactions WHERE tenant_id = '111' AND amount_minor = 309600").all()
    ).results;
    expect(avenueRows[0].merchant).toBe("DMart");
    expect((await getMerchantRules(db, "111")).find((r) => r.pattern === "avenue").name).toBe("DMart");
    expect(await getTransaction(db, "111", rTrunc)).toMatchObject({ merchant: "Croma", category: "Shopping" });
    expect(await getTransaction(db, "111", rCustom)).toMatchObject({ merchant: "Team Lunch", category: "Food" });
  });

  it("0004 migration cleans historical transactions and rules", async () => {
    const db = createTestD1();
    await db
      .prepare("INSERT INTO tenants (id, kind, status, created_at) VALUES ('111', 'personal', 'active', ?)")
      .bind(NOW)
      .run();
    const cases = [
      ["t1", "BLINKIT", "Blinkit"],
      ["t2", "DMART", "DMart"],
      ["t3", "URBANCLAP TECHNOLOGIES", "Urban Company"],
      ["t4", "INDIAN CLEARING CORP", "Mutual Funds"],
      ["t5", "sip", "Mutual Funds"],
      ["t6", "DREAMPLUG", "CC Bill"],
      ["t7", "ox9988...@pty", null],
      ["t8", "TWO VILLAS HOLIDAY CO ,LT", "Two Villas Holiday"],
      ["t9", "FIREFLY THB", "Firefly"]
    ];
    for (const [id, raw] of cases) {
      await db
        .prepare(
          "INSERT INTO transactions (id, tenant_id, occurred_on, amount_minor, currency, direction, kind, merchant, created_at, updated_at) VALUES (?, '111', '2026-10-07', 10000, 'INR', 'debit', 'spend', ?, ?, ?)"
        )
        .bind(id, raw, NOW, NOW)
        .run();
    }
    await db.exec(readFileSync(resolve(MIGRATIONS_DIR, "0004_canonical_merchants_and_cards.sql"), "utf8"));
    for (const [id, , expected] of cases) {
      expect(await db.prepare("SELECT merchant FROM transactions WHERE id = ?").bind(id).first("merchant")).toBe(
        expected
      );
    }
  });
});

describe("CC Bill *last4, card labels, and per-card analytics", () => {
  it("extracts card last-4 on CC bill emails, upgrades past rows when card is labelled, and filters spend by card name", async () => {
    expect(
      detectCcBillCardLast4("We have received payment of Rs. 45,165.00 towards your HDFC Bank Credit Card ending 5678.")
    ).toBe("5678");
    // Must NOT treat normal card POS spend as a CC bill!
    expect(detectCcBillCardLast4("Spent Rs.899 On HDFC Bank Card 5678 At NETFLIX On 2026-10-07")).toBeNull();
    expect(formatCcBillMerchant("5678", {})).toBe("CC Bill *5678");
    expect(formatCcBillMerchant("5678", { 5678: "Infinia" })).toBe("CC Bill · Infinia");

    const ctx = testContext({
      now: NOW,
      llmReplies: [llmTxn({ merchant: "", category: "Transfer", amount: 45165, transaction_type: "Debit" })]
    });
    const alice = await seedTenant(ctx, "111");

    // 1. Ingest unlabelled CC bill email mentioning Card ending 5678 -> saved as "CC Bill *5678".
    const ccRes = await ingest(ctx, {
      tenant: alice,
      source: "email",
      sourceRef: "e-cc-1",
      text: "Payment of Rs. 45,165.00 debited towards your HDFC Credit Card ending 5678 on 07-Oct-2026."
    });
    expect(await getTransaction(ctx.db, "111", ccRes.transactionId)).toMatchObject({
      merchant: "CC Bill *5678",
      category: "Transfer",
      kind: "transfer",
      account_last4: "5678"
    });

    // Add a regular spend on card 5678 and another on card 4321.
    await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-07",
        amountMinor: 120000,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "Swiggy",
        category: "Food",
        accountLast4: "5678"
      },
      { source: "email", sourceRef: "e-spend-5678" },
      NOW
    );
    await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-07",
        amountMinor: 80000,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "Amazon",
        category: "Shopping",
        accountLast4: "4321"
      },
      { source: "email", sourceRef: "e-spend-4321" },
      NOW
    );

    // 2. User labels card 5678 in DM ("card 5678 is Infinia") -> 0 LLM calls + retroactively upgrades CC Bill *5678!
    await handleUpdate(ctx, {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 111, first_name: "Alice" },
        text: "card 5678 is Infinia"
      }
    });
    expect(await getAccountLabels(ctx.db, "111")).toEqual([{ last4: "5678", label: "Infinia", kind: "card" }]);
    expect((await getTransaction(ctx.db, "111", ccRes.transactionId)).merchant).toBe("CC Bill · Infinia");
    expect(ctx.tg.of("sendMessage").at(-1).args[1]).toContain("updated 1 past CC bill");

    // 3. Analytics tool filters spend by saved card label "Infinia"!
    const run = askToolExecutor(ctx, "111");
    const infiniaSummary = await run("get_spending_summary", {
      start_date: "2026-10-01",
      end_date: "2026-10-07",
      card: "Infinia"
    });
    expect(infiniaSummary.spend_by_currency).toEqual({ INR: 1200 });
    const cardsList = await run("list_cards", {});
    expect(cardsList.cards_and_accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ last4: "5678", label: "Infinia", txn_count: 2 }),
        expect.objectContaining({ last4: "4321", label: null, txn_count: 1 })
      ])
    );
  });
});

describe("1-row quick merchant chips on unnamed cards + self-improving merchant flywheel", () => {
  it("shows deterministic quick merchant chips when categorizing an unnamed card and collapses to 1 row on tap", async () => {
    const ctx = testContext({
      now: NOW,
      llmReplies: [llmTxn({ merchant: "", category: "", amount: 5000, transaction_type: "Debit" })]
    });
    const alice = await seedTenant(ctx, "111");
    const res = await ingest(ctx, {
      tenant: alice,
      source: "email",
      sourceRef: "e-unnamed-inv",
      text: "Rs.5000.00 debited from A/C **1234 on 07-10-26."
    });
    const cardMsgId = (await getTransaction(ctx.db, "111", res.transactionId)).card_message_id;

    // Pick Invest (index 7) on unnamed card -> shows [Mutual Funds, Stocks, Gold] chip row above [📈 ▾, ⋯]!
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-cat",
        data: "cat_" + res.transactionId + "_7",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: cardMsgId }
      }
    });
    const kbWithChips = ctx.tg.of("editMessageReplyMarkup").at(-1).args[2].inline_keyboard;
    expect(kbWithChips[0].map((b) => b.text)).toEqual(["Mutual Funds", "Stocks", "Gold"]);
    expect(kbWithChips[1].map((b) => b.text)).toEqual(["📈 ▾", "⋯"]);

    // Tap "Mutual Funds" chip -> sets merchant="Mutual Funds" and collapses back to 1 row [📈 ▾, ⋯]!
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-chip",
        data: kbWithChips[0][0].callback_data,
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: cardMsgId }
      }
    });
    expect(await getTransaction(ctx.db, "111", res.transactionId)).toMatchObject({
      merchant: "Mutual Funds",
      category: "Invest",
      kind: "investment"
    });
    const finalEdit = ctx.tg.of("editMessageText").at(-1).args;
    expect(finalEdit[2]).toContain("🔴 *Mutual Funds* — ₹5000");
    expect(finalEdit[3].reply_markup.inline_keyboard).toHaveLength(1);
  });

  it("caches confident LLM brand extractions into merchant_rules and promotes >=2-tenant consensus rules to global", async () => {
    const ctx = testContext({
      now: NOW,
      llmReplies: [llmTxn({ merchant: "KANCHI CAFE 99", category: "Food", amount: 340 })]
    });
    const alice = await seedTenant(ctx, "111");
    await seedTenant(ctx, "222");

    // 1st hit via LLM email -> normalizes "KANCHI CAFE 99" to "Kanchi Cafe 99" and caches shortened rule "kanchi cafe"!
    await ingest(ctx, {
      tenant: alice,
      source: "email",
      sourceRef: "e-kanchi-1",
      text: "Rs.340.00 debited to KANCHI CAFE 99 on 07-10-26."
    });
    expect((await getMerchantRules(ctx.db, "111")).find((r) => r.pattern === "kanchi cafe")).toMatchObject({
      name: "Kanchi Cafe 99",
      category: "Food"
    });

    // 2nd hit via SMS (0 LLM replies left!) -> auto-categorizes "Kanchi Cafe 42" as Food deterministically!
    const smsRes = await ingest(ctx, {
      tenant: alice,
      source: "sms",
      sourceRef: "s-kanchi-2",
      text: "Sent Rs.180.00 From HDFC Bank A/C *1234 To KANCHI CAFE 42 On 07/10/26 Ref 628077778888 Not You? Call 18002586161"
    });
    expect(await getTransaction(ctx.db, "111", smsRes.transactionId)).toMatchObject({
      category: "Food"
    });

    // Crowd consensus: when >= 2 tenants agree on ("ratnadeep super", "Ratnadeep", "Groceries"), promotes to shared ('')!
    await upsertMerchantRule(ctx.db, "111", "ratnadeep super", { name: "Ratnadeep", category: "Groceries" }, NOW);
    await upsertMerchantRule(ctx.db, "222", "ratnadeep super", { name: "Ratnadeep", category: "Groceries" }, NOW);
    const promoted = await promoteConsensusMerchantRules(ctx.db, NOW);
    expect(promoted).toEqual([{ pattern: "ratnadeep super", name: "Ratnadeep", category: "Groceries", tenants: 2 }]);

    // Monday parser digest surfaces the merchant flywheel activity to admin DM.
    await sendParserDigest(ctx);
    const adminMsg = ctx.tg.of("sendMessage").find((c) => c.args[0] === "999");
    expect(adminMsg.args[1]).toContain("🏷 *Merchant flywheel — last 7d*");
    expect(adminMsg.args[1]).toContain("`ratnadeep super`");
  });
});
