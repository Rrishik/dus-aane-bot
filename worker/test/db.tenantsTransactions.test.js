import { describe, it, expect } from "vitest";
import { createTestD1 } from "./helpers/d1.js";
import * as tenants from "../src/db/tenants.js";
import * as txns from "../src/db/transactions.js";

const NOW = 1791460000000;

async function seed() {
  const db = createTestD1();
  await tenants.registerEmail(db, "111", "alice@x.com", "Alice", NOW);
  await tenants.activateTenant(db, "111");
  await tenants.registerEmail(db, "222", "bob@x.com", "Bob", NOW);
  await tenants.activateTenant(db, "222");
  return db;
}

const base = {
  occurredOn: "2026-10-07",
  amountMinor: 25000,
  currency: "INR",
  direction: "debit",
  kind: "spend",
  merchantRaw: "SWIGGY",
  merchant: "Swiggy",
  category: "Food & Dining"
};
const smsSource = (ref) => ({
  source: "sms",
  sourceRef: ref,
  parsedBy: "tpl_v1",
  confidence: 0.97,
  rawText: "Sent Rs.250"
});

describe("tenants", () => {
  it("registerEmail creates a pending personal tenant and refuses someone else's address", async () => {
    const db = createTestD1();
    expect(await tenants.registerEmail(db, 111, " Alice@X.com ", "Alice", NOW)).toEqual({ ok: true });
    expect(await tenants.getTenant(db, "111")).toMatchObject({ kind: "personal", status: "pending", name: "Alice" });
    expect(await tenants.getTenantEmails(db, "111")).toEqual(["alice@x.com"]);
    expect(await tenants.registerEmail(db, "222", "alice@x.com", "Mallory", NOW)).toEqual({
      ok: false,
      conflict: true
    });
    // Re-registering keeps the name when none is given.
    await tenants.registerEmail(db, "111", "alice2@x.com", "", NOW);
    expect((await tenants.getTenant(db, "111")).name).toBe("Alice");
  });

  it("routes forwards only to usable personal tenants", async () => {
    const db = createTestD1();
    await tenants.registerEmail(db, "111", "alice@x.com", "Alice", NOW);
    expect(await tenants.findTenantByEmail(db, "alice@x.com")).toBeNull();
    expect((await tenants.findPendingTenantByEmail(db, "ALICE@x.com")).id).toBe("111");
    await tenants.activateTenant(db, "111");
    expect((await tenants.findTenantByEmail(db, "alice@x.com")).id).toBe("111");
    await tenants.setTenantStatus(db, "111", "dormant");
    expect((await tenants.findTenantByEmail(db, "alice@x.com")).id).toBe("111");
    await tenants.setTenantStatus(db, "111", "disabled");
    expect(await tenants.findTenantByEmail(db, "alice@x.com")).toBeNull();
  });

  it("nags flip to dormant at the cap; activity reactivates and resets", async () => {
    const db = await seed();
    expect(await tenants.recordNag(db, "111", 2, NOW)).toEqual({ status: "active", nag_count: 1 });
    expect(await tenants.recordNag(db, "111", 2, NOW)).toEqual({ status: "dormant", nag_count: 2 });
    expect(await tenants.touchActivity(db, "111", NOW + 1)).toEqual({ reactivated: true });
    expect(await tenants.getTenant(db, "111")).toMatchObject({
      status: "active",
      nag_count: 0,
      last_nag_at: null,
      last_activity_at: NOW + 1
    });
    expect(await tenants.touchActivity(db, "111", NOW + 2)).toEqual({ reactivated: false });
  });

  it("groups keep member join order and only list active groups", async () => {
    const db = await seed();
    await tenants.registerEmail(db, "333", "c@x.com", "C", NOW);
    await tenants.createGroup(db, { id: -100, name: "Flat", adminId: 111, members: ["222", "111"], now: NOW });
    expect(await tenants.getGroupMembers(db, "-100")).toEqual(["222", "111"]);
    expect(await tenants.addGroupMember(db, "-100", "333", NOW + 5)).toBe(true);
    expect(await tenants.addGroupMember(db, "-100", "333", NOW + 6)).toBe(false);
    await tenants.setGroupMembers(db, "-100", ["111", "333"], NOW + 10);
    expect(await tenants.getGroupMembers(db, "-100")).toEqual(["111", "333"]);
    expect((await tenants.groupsForMember(db, "111")).map((g) => g.id)).toEqual(["-100"]);
    await tenants.setTenantStatus(db, "-100", "disabled");
    expect(await tenants.groupsForMember(db, "111")).toEqual([]);
  });

  it("group invites are consumed once", async () => {
    const db = await seed();
    await tenants.createGroup(db, { id: "-100", name: "Flat", members: [], now: NOW });
    await tenants.addGroupInvite(db, "999", "-100", NOW);
    await tenants.addGroupInvite(db, "999", "-100", NOW);
    expect(await tenants.takeGroupInvites(db, "999")).toEqual(["-100"]);
    expect(await tenants.takeGroupInvites(db, "999")).toEqual([]);
  });
});

describe("transactions", () => {
  it("inserts a transaction with its source and finds it by source", async () => {
    const db = await seed();
    const id = await txns.insertTransaction(db, "111", base, smsSource("sms-a"), NOW);
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
    const t = await txns.findTransactionBySource(db, "111", "sms", "sms-a");
    expect(t).toMatchObject({ id, amount_minor: 25000, status: "confirmed", merchant: "Swiggy" });
    expect(await txns.getSources(db, "111", id)).toEqual([
      expect.objectContaining({ source: "sms", source_ref: "sms-a", parsed_by: "tpl_v1", raw_text: "Sent Rs.250" })
    ]);
  });

  it("is isolated per tenant for every read and write", async () => {
    const db = await seed();
    const id = await txns.insertTransaction(db, "111", base, smsSource("sms-a"), NOW);
    expect(await txns.getTransaction(db, "222", id)).toBeNull();
    expect(await txns.findTransactionBySource(db, "222", "sms", "sms-a")).toBeNull();
    expect(await txns.getSources(db, "222", id)).toEqual([]);
    expect(await txns.updateTransaction(db, "222", id, { category: "Shopping" })).toBe(false);
    expect(await txns.softDeleteTransaction(db, "222", id)).toBe(false);
    expect(await txns.attachSource(db, "222", id, { source: "email", sourceRef: "g1" })).toBe(false);
    expect(await txns.listTransactions(db, "222")).toEqual([]);
    expect(await txns.findLinkCandidate(db, "222", { ...base, accountLast4: null, reference: null })).toBeNull();
    expect((await txns.getTransaction(db, "111", id)).category).toBe("Food & Dining");
  });

  it("attaches a second source to the same transaction", async () => {
    const db = await seed();
    const id = await txns.insertTransaction(db, "111", base, smsSource("sms-a"), NOW);
    expect(
      await txns.attachSource(db, "111", id, { source: "email", sourceRef: "18f2a", parsedBy: "llm" }, NOW + 1)
    ).toBe(true);
    expect((await txns.getSources(db, "111", id)).map((s) => s.source)).toEqual(["sms", "email"]);
    expect((await txns.findTransactionBySource(db, "111", "email", "18f2a")).id).toBe(id);
  });

  it("updates only whitelisted fields and bumps updated_at", async () => {
    const db = await seed();
    const id = await txns.insertTransaction(db, "111", base, smsSource("sms-a"), NOW);
    expect(await txns.updateTransaction(db, "111", id, { category: "Groceries", kind: "spend" }, NOW + 5)).toBe(true);
    expect(await txns.getTransaction(db, "111", id)).toMatchObject({ category: "Groceries", updated_at: NOW + 5 });
    await expect(txns.updateTransaction(db, "111", id, { tenantId: "222" })).rejects.toThrow(/not updatable/);
    expect(await txns.updateSource(db, "111", "sms", "sms-a", { reread: 1, parsedBy: "llm" })).toBe(true);
    expect((await txns.getSources(db, "111", id))[0]).toMatchObject({ reread: 1, parsed_by: "llm" });
  });

  it("lists confirmed rows by default, newest first, with filters", async () => {
    const db = await seed();
    await txns.insertTransaction(db, "111", base, smsSource("a"), NOW);
    await txns.insertTransaction(
      db,
      "111",
      { ...base, occurredOn: "2026-10-01", merchant: "Zepto", category: "Groceries" },
      smsSource("b"),
      NOW + 1
    );
    await txns.insertTransaction(db, "111", { ...base, status: "review" }, smsSource("c"), NOW + 2);
    const gone = await txns.insertTransaction(db, "111", base, smsSource("d"), NOW + 3);
    await txns.softDeleteTransaction(db, "111", gone);

    expect((await txns.listTransactions(db, "111")).map((t) => t.merchant)).toEqual(["Swiggy", "Zepto"]);
    expect((await txns.listTransactions(db, "111", { statuses: ["confirmed", "review"] })).length).toBe(3);
    expect((await txns.listTransactions(db, "111", { from: "2026-10-05" })).length).toBe(1);
    expect((await txns.listTransactions(db, "111", { merchant: "zep" }))[0].merchant).toBe("Zepto");
    expect((await txns.listTransactions(db, "111", { category: "Groceries" })).length).toBe(1);
    expect((await txns.listTransactions(db, "111", { limit: 1 })).length).toBe(1);
  });
});

describe("findLinkCandidate", () => {
  async function withExisting(over) {
    const db = await seed();
    const id = await txns.insertTransaction(db, "111", { ...base, ...over }, smsSource("sms-a"), NOW);
    return { db, id };
  }
  const incoming = (over) => ({ ...base, accountLast4: null, reference: null, ...over });

  it("matches on reference regardless of date or amount", async () => {
    const { db, id } = await withExisting({ reference: "628012345678" });
    const hit = await txns.findLinkCandidate(
      db,
      "111",
      incoming({ reference: "628012345678", occurredOn: "2026-09-01" })
    );
    expect(hit).toMatchObject({ strength: "reference", transaction: { id } });
  });

  it("matches same account + amount within a day as 'account'", async () => {
    const { db, id } = await withExisting({ accountLast4: "1234" });
    const hit = await txns.findLinkCandidate(db, "111", incoming({ accountLast4: "1234", occurredOn: "2026-10-08" }));
    expect(hit).toMatchObject({ strength: "account", transaction: { id } });
  });

  it("different accounts or references are never the same transaction", async () => {
    const { db } = await withExisting({ accountLast4: "1234", reference: "111111111" });
    expect(await txns.findLinkCandidate(db, "111", incoming({ accountLast4: "9999" }))).toBeNull();
    expect(await txns.findLinkCandidate(db, "111", incoming({ reference: "222222222" }))).toBeNull();
  });

  it("amount/date only (account missing on one side) is a weak 'amount' match", async () => {
    const { db } = await withExisting({});
    expect((await txns.findLinkCandidate(db, "111", incoming({ accountLast4: "1234" }))).strength).toBe("amount");
  });

  it("ignores other amounts, currencies, directions, far dates and deleted rows", async () => {
    const { db, id } = await withExisting({});
    expect(await txns.findLinkCandidate(db, "111", incoming({ amountMinor: 25001 }))).toBeNull();
    expect(await txns.findLinkCandidate(db, "111", incoming({ currency: "USD" }))).toBeNull();
    expect(await txns.findLinkCandidate(db, "111", incoming({ direction: "credit" }))).toBeNull();
    expect(await txns.findLinkCandidate(db, "111", incoming({ occurredOn: "2026-10-09" }))).toBeNull();
    await txns.softDeleteTransaction(db, "111", id);
    expect(await txns.findLinkCandidate(db, "111", incoming({}))).toBeNull();
  });
});
