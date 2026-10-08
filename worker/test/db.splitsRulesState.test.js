import { describe, it, expect } from "vitest";
import { createTestD1 } from "./helpers/d1.js";
import { loadAppsScript } from "../../tests/_loader.js";
import * as tenants from "../src/db/tenants.js";
import * as txns from "../src/db/transactions.js";
import * as splits from "../src/db/splits.js";
import { getMerchantRules, upsertMerchantRule, resolveMerchant } from "../src/db/merchantRules.js";
import * as settings from "../src/db/settings.js";
import * as eph from "../src/db/ephemeral.js";
import { consumeAsk, refundAsk } from "../src/db/quota.js";

const NOW = 1791460000000;

async function groupFixture() {
  const db = createTestD1();
  for (const id of ["111", "222", "333"]) {
    await tenants.registerEmail(db, id, id + "@x.com", "U" + id, NOW);
    await tenants.activateTenant(db, id);
  }
  await tenants.createGroup(db, { id: "-100", name: "Flat", members: ["111", "222", "333"], now: NOW });
  return db;
}

async function paid(db, payer, amountMinor, currency, direction, ref) {
  return txns.insertTransaction(
    db,
    payer,
    { occurredOn: "2026-10-07", amountMinor, currency, direction, kind: direction === "debit" ? "spend" : "refund" },
    { source: "sms", sourceRef: ref },
    NOW
  );
}

describe("splits + group balances", () => {
  it("createSplit refuses another tenant's transaction and a second split", async () => {
    const db = await groupFixture();
    const t = await paid(db, "111", 90000, "INR", "debit", "a");
    const shares = [{ holderId: "222", amountMinor: 45000 }];
    await expect(
      splits.createSplit(db, { transactionId: t, groupId: "-100", payerId: "222", mode: "50", shares })
    ).rejects.toThrow(/not found for payer/);
    await splits.createSplit(db, { transactionId: t, groupId: "-100", payerId: "111", mode: "50", shares });
    await expect(
      splits.createSplit(db, { transactionId: t, groupId: "-100", payerId: "111", mode: "50", shares })
    ).rejects.toThrow(/UNIQUE/);
    const s = await splits.getSplitForTransaction(db, t);
    expect(s).toMatchObject({ group_id: "-100", payer_id: "111", shares: [{ holder_id: "222", amount_minor: 45000 }] });
    expect(await splits.deleteSplit(db, "-999", s.id)).toBe(false);
    expect(await splits.deleteSplit(db, "-100", s.id)).toBe(true);
    expect(await splits.getSplitForTransaction(db, t)).toBeNull();
  });

  it("balances match Groups.js aggregatePairwiseDebts on the same data", async () => {
    const db = await groupFixture();
    const legacyRows = [];
    // Legacy β row: [email, txDate, merchant, amount, currency, paidBy, holder, share, txId, category, txType, msgId]
    const legacy = (payer, holder, share, currency, category) =>
      legacyRows.push(["", "", "", 0, currency, payer, holder, share, "", category || "Food", "Debit", ""]);

    async function split(payer, amountMinor, currency, direction, shares, ref) {
      const t = await paid(db, payer, amountMinor, currency, direction, ref);
      await splits.createSplit(db, {
        transactionId: t,
        groupId: "-100",
        payerId: payer,
        mode: "all",
        shares: shares.map(([h, a]) => ({ holderId: h, amountMinor: a }))
      });
      shares.forEach(([h, a]) => legacy(payer, h, a / 100, currency));
    }

    await split(
      "111",
      90000,
      "INR",
      "debit",
      [
        ["111", 30000],
        ["222", 30000],
        ["333", 30000]
      ],
      "s1"
    );
    await split(
      "222",
      10000,
      "INR",
      "debit",
      [
        ["222", 5000],
        ["111", 5000]
      ],
      "s2"
    );
    await split(
      "333",
      1200,
      "USD",
      "debit",
      [
        ["333", 600],
        ["111", 600]
      ],
      "s3"
    );
    await split(
      "111",
      6000,
      "INR",
      "credit",
      [
        ["111", 3000],
        ["222", 3000]
      ],
      "s4"
    ); // refunds split the same way
    const settleTxn = await paid(db, "222", 20000, "INR", "debit", "s5");
    await splits.recordSettlement(db, {
      groupId: "-100",
      fromId: "222",
      toId: "111",
      amountMinor: 20000,
      currency: "INR",
      transactionId: settleTxn
    });
    legacy("222", "111", 200, "INR", "Settlement");

    const { aggregatePairwiseDebts } = loadAppsScript(["Groups.js"], ["aggregatePairwiseDebts"], {
      G_CURRENCY_COLUMN: 5,
      G_PAID_BY_COLUMN: 6,
      G_SHARE_HOLDER_COLUMN: 7,
      G_SHARE_AMOUNT_COLUMN: 8,
      G_CATEGORY_COLUMN: 10
    });
    const expected = aggregatePairwiseDebts(legacyRows);
    const actual = await splits.groupBalances(db, "-100");

    const asMajor = (byCcy) =>
      Object.fromEntries(
        Object.entries(byCcy).map(([c, list]) => [
          c,
          list.map((e) => ({ debtor: e.debtor, creditor: e.creditor, amount: e.amountMinor / 100 }))
        ])
      );
    expect(asMajor(actual)).toEqual(expected);
    expect(actual.INR.length).toBeGreaterThan(0);
    expect(actual.USD).toEqual([{ debtor: "111", creditor: "333", amountMinor: 600 }]);
  });

  it("deleting a settlement or a deleted transaction drops it from balances", async () => {
    const db = await groupFixture();
    const t = await paid(db, "111", 10000, "INR", "debit", "a");
    await splits.createSplit(db, {
      transactionId: t,
      groupId: "-100",
      payerId: "111",
      mode: "50",
      shares: [{ holderId: "222", amountMinor: 5000 }]
    });
    const st = await splits.recordSettlement(db, {
      groupId: "-100",
      fromId: "222",
      toId: "111",
      amountMinor: 5000,
      currency: "INR"
    });
    expect(await splits.groupBalances(db, "-100")).toEqual({});
    await splits.deleteSettlement(db, "-100", st);
    expect(await splits.groupBalances(db, "-100")).toEqual({
      INR: [{ debtor: "222", creditor: "111", amountMinor: 5000 }]
    });
    await txns.softDeleteTransaction(db, "111", t);
    expect(await splits.groupBalances(db, "-100")).toEqual({});
  });
});

describe("merchant rules", () => {
  it("personal rules come first and win; omitted fields are preserved on upsert", async () => {
    const db = await groupFixture();
    await upsertMerchantRule(db, null, "swiggy_mws", { name: "Swiggy", category: "Food & Dining" }, NOW);
    await upsertMerchantRule(db, "111", "Swiggy", { category: "Groceries" }, NOW);
    await upsertMerchantRule(db, "111", "swiggy", { kind: "spend" }, NOW);
    const rules = await getMerchantRules(db, "111");
    expect(rules[0]).toEqual({ pattern: "swiggy", name: null, category: "Groceries", kind: "spend", personal: true });
    expect(rules[1]).toMatchObject({ pattern: "swiggy_mws", personal: false });
    expect(await getMerchantRules(db, "222")).toEqual([expect.objectContaining({ pattern: "swiggy_mws" })]);
  });

  it("resolveMerchant: names and categories resolve independently; personal category beats shared", async () => {
    const rules = [
      { pattern: "bundl", name: "Swiggy", category: null, kind: null, personal: true },
      { pattern: "swiggy", name: null, category: "Groceries", kind: null, personal: true },
      { pattern: "bundl tech", name: null, category: "Food & Dining", kind: null, personal: false }
    ];
    expect(resolveMerchant("BUNDL TECH 123", rules)).toEqual({
      merchant: "Swiggy",
      category: "Groceries",
      kind: null,
      personalCategory: true
    });
    expect(resolveMerchant("Unknown", rules)).toEqual({
      merchant: "Unknown",
      category: null,
      kind: null,
      personalCategory: false
    });
  });
});

describe("settings + parser telemetry", () => {
  it("parser mode defaults to shadow and rejects unknown values", async () => {
    const db = createTestD1();
    expect(await settings.getParserMode(db)).toBe("shadow");
    await settings.setSetting(db, "parser.mode", "on");
    expect(await settings.getParserMode(db)).toBe("on");
    await settings.setSetting(db, "parser.mode", "yolo");
    expect(await settings.getParserMode(db)).toBe("shadow");
  });

  it("disabled templates accumulate without duplicates", async () => {
    const db = createTestD1();
    expect(await settings.disableTemplate(db, "a_v1")).toBe(true);
    expect(await settings.disableTemplate(db, "a_v1")).toBe(false);
    await settings.disableTemplate(db, "b_v1");
    expect(await settings.getDisabledTemplates(db)).toEqual(["a_v1", "b_v1"]);
  });

  it("logs field names only and summarises per template", async () => {
    const db = createTestD1();
    await settings.logParserEvent(db, { tenantId: 111, templateId: "t1", event: "saved" }, NOW);
    await settings.logParserEvent(
      db,
      { tenantId: 111, templateId: "t1", event: "reparse_accepted", fieldsChanged: ["amount"], sourceRef: "sms-1" },
      NOW
    );
    await settings.logParserEvent(db, { templateId: "t1", event: "reparse_accepted" }, NOW - 10 * 86400000);
    expect(
      await settings.countParserEvents(db, { templateId: "t1", event: "reparse_accepted", sinceMs: NOW - 1 })
    ).toBe(1);
    expect(await settings.parserEventSummary(db, NOW - 1)).toEqual({ t1: { saved: 1, reparse_accepted: 1 } });
    const row = await db
      .prepare("SELECT * FROM parser_events WHERE event = 'reparse_accepted' AND ts = ?")
      .bind(NOW)
      .first();
    expect(row).toMatchObject({ tenant_id: "111", fields_changed: "amount", source_ref: "sms-1" });
  });
});

describe("ephemeral", () => {
  it("expires values and take() consumes exactly once", async () => {
    const db = createTestD1();
    await eph.putEphemeral(db, "k", { v: 1 }, 60, NOW);
    expect(await eph.getEphemeral(db, "k", NOW + 59000)).toEqual({ v: 1 });
    expect(await eph.getEphemeral(db, "k", NOW + 60000)).toBeNull();

    await eph.putEphemeral(db, "k2", [1, 2], 60, NOW);
    expect(await eph.takeEphemeral(db, "k2", NOW)).toEqual([1, 2]);
    expect(await eph.takeEphemeral(db, "k2", NOW)).toBeNull();

    await eph.putEphemeral(db, "old", 1, 1, NOW);
    await eph.putEphemeral(db, "new", 1, 100, NOW);
    expect(await eph.purgeExpired(db, NOW + 5000)).toBe(1);
  });
});

describe("ask quota", () => {
  it("allows up to the cap per day, counts cap hits, resets on a new day, refunds same-day", async () => {
    const db = await groupFixture();
    const cap = 2;
    expect(await consumeAsk(db, "111", "2026-10-07", cap)).toEqual({ allowed: true, usedToday: 1 });
    expect(await consumeAsk(db, "111", "2026-10-07", cap)).toEqual({ allowed: true, usedToday: 2 });
    expect(await consumeAsk(db, "111", "2026-10-07", cap)).toEqual({ allowed: false, usedToday: 2 });
    expect(await db.prepare("SELECT * FROM ask_usage").first()).toMatchObject({ lifetime: 2, cap_hits: 1 });

    await refundAsk(db, "111", "2026-10-07", cap);
    expect(await db.prepare("SELECT * FROM ask_usage").first()).toMatchObject({
      used_today: 1,
      lifetime: 1,
      cap_hits: 0
    });
    await refundAsk(db, "111", "2026-10-06", cap);
    expect(await db.prepare("SELECT used_today FROM ask_usage").first("used_today")).toBe(1);

    expect(await consumeAsk(db, "111", "2026-10-08", cap)).toEqual({ allowed: true, usedToday: 1 });
    expect(await consumeAsk(db, "222", "2026-10-08", cap)).toEqual({ allowed: true, usedToday: 1 });
  });
});
