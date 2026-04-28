import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let calcSplitSettlement, sumByCurrency, aggregateByUser, aggregateByField, filterByDateRange;

const SPLIT_STATUS = { PERSONAL: "Personal", SPLIT: "Split", PARTNER: "Partner" };

beforeAll(() => {
  ({ calcSplitSettlement, sumByCurrency, aggregateByUser, aggregateByField, filterByDateRange } = loadAppsScript(
    ["Analytics.js"],
    ["calcSplitSettlement", "sumByCurrency", "aggregateByUser", "aggregateByField", "filterByDateRange"],
    { SPLIT_STATUS, CATEGORY_EMOJIS: {} }
  ));
});

function txn(overrides) {
  return Object.assign(
    {
      date: new Date("2026-04-10"),
      merchant: "X",
      amount: 100,
      category: "Shopping",
      type: "Debit",
      user: "alice",
      split: SPLIT_STATUS.PERSONAL,
      currency: "INR"
    },
    overrides
  );
}

describe("sumByCurrency", () => {
  it("returns empty object for empty input", () => {
    expect(sumByCurrency([])).toEqual({});
  });

  it("sums per currency", () => {
    var t = [
      txn({ amount: 100, currency: "INR" }),
      txn({ amount: 50, currency: "INR" }),
      txn({ amount: 20, currency: "USD" })
    ];
    expect(sumByCurrency(t)).toEqual({ INR: 150, USD: 20 });
  });
});

describe("aggregateByUser", () => {
  it("groups amounts per user per currency", () => {
    var t = [
      txn({ user: "alice", amount: 100, currency: "INR" }),
      txn({ user: "alice", amount: 30, currency: "USD" }),
      txn({ user: "bob", amount: 50, currency: "INR" })
    ];
    expect(aggregateByUser(t)).toEqual({ alice: { INR: 100, USD: 30 }, bob: { INR: 50 } });
  });
});

describe("aggregateByField", () => {
  it("groups by field+currency and sorts desc by amount", () => {
    var t = [
      txn({ merchant: "Swiggy", amount: 100 }),
      txn({ merchant: "Swiggy", amount: 50 }),
      txn({ merchant: "Amazon", amount: 200 })
    ];
    var out = aggregateByField(t, "merchant");
    expect(out).toEqual([
      { name: "Amazon", currency: "INR", amount: 200, count: 1 },
      { name: "Swiggy", currency: "INR", amount: 150, count: 2 }
    ]);
  });
});

describe("filterByDateRange", () => {
  it("includes endpoints (full-day boundaries)", () => {
    var t = [
      txn({ date: new Date("2026-04-01T08:00:00") }),
      txn({ date: new Date("2026-04-15T23:59:00") }),
      txn({ date: new Date("2026-04-16T00:30:00") })
    ];
    var out = filterByDateRange(t, new Date("2026-04-01"), new Date("2026-04-15"));
    expect(out).toHaveLength(2);
  });
});

describe("calcSplitSettlement — empty / personal-only", () => {
  it("returns zeros when no debits", () => {
    var r = calcSplitSettlement([]);
    expect(r.splitCount).toBe(0);
    expect(r.partnerCount).toBe(0);
    expect(r.personalCount).toBe(0);
    expect(r.users).toEqual([]);
    expect(r.settlements).toEqual({});
  });

  it("classifies personal txns as personal, no settlement currencies", () => {
    var debits = [txn({ user: "alice", amount: 100, split: SPLIT_STATUS.PERSONAL })];
    var r = calcSplitSettlement(debits);
    expect(r.personalCount).toBe(1);
    expect(r.splitCount).toBe(0);
    expect(r.settlements).toEqual({}); // no shared currency
  });
});

describe("calcSplitSettlement — split (50/50)", () => {
  it("balances are zero when both users paid equally", () => {
    var debits = [
      txn({ user: "alice", amount: 100, split: SPLIT_STATUS.SPLIT }),
      txn({ user: "bob", amount: 100, split: SPLIT_STATUS.SPLIT })
    ];
    var r = calcSplitSettlement(debits);
    expect(r.splitCount).toBe(2);
    expect(r.settlements.INR.total).toBe(200);
    expect(r.settlements.INR.fairShare).toBe(100);
    expect(r.settlements.INR.balances).toEqual({ alice: 0, bob: 0 });
  });

  it("alice paid 200, bob paid 0 → bob owes alice 100 (half of 200)", () => {
    var debits = [
      txn({ user: "alice", amount: 200, split: SPLIT_STATUS.SPLIT }),
      txn({ user: "bob", amount: 0, split: SPLIT_STATUS.PERSONAL })
    ];
    // Need bob to appear as a known user; PERSONAL contributes to userSet
    var r = calcSplitSettlement(debits);
    expect(r.users.sort()).toEqual(["alice", "bob"]);
    // splitTotal=200, fairShare=100. alice paid 200 (split), bob paid 0 (split)
    expect(r.settlements.INR.balances.alice).toBe(100);
    expect(r.settlements.INR.balances.bob).toBe(-100);
  });
});

describe("calcSplitSettlement — partner (100% on behalf of other)", () => {
  it("alice paid 300 partner → bob owes alice 300", () => {
    var debits = [
      txn({ user: "alice", amount: 300, split: SPLIT_STATUS.PARTNER }),
      txn({ user: "bob", amount: 0, split: SPLIT_STATUS.PERSONAL })
    ];
    var r = calcSplitSettlement(debits);
    expect(r.partnerCount).toBe(1);
    expect(r.settlements.INR.partnerTotal).toBe(300);
    expect(r.settlements.INR.balances.alice).toBe(300);
    expect(r.settlements.INR.balances.bob).toBe(-300);
  });

  it("partner with no counterparty leaves balance untouched (can't settle)", () => {
    var debits = [txn({ user: "alice", amount: 300, split: SPLIT_STATUS.PARTNER })];
    var r = calcSplitSettlement(debits);
    expect(r.settlements.INR.balances).toEqual({ alice: 0 });
  });
});

describe("calcSplitSettlement — multi-currency", () => {
  it("settles each currency independently", () => {
    var debits = [
      txn({ user: "alice", amount: 200, currency: "INR", split: SPLIT_STATUS.SPLIT }),
      txn({ user: "bob", amount: 100, currency: "USD", split: SPLIT_STATUS.SPLIT })
    ];
    var r = calcSplitSettlement(debits);
    expect(r.settlements.INR.balances).toEqual({ alice: 100, bob: -100 });
    expect(r.settlements.USD.balances).toEqual({ alice: -50, bob: 50 });
  });
});

describe("calcSplitSettlement — userPaid combines split + partner", () => {
  it("sums split and partner amounts per user/currency", () => {
    var debits = [
      txn({ user: "alice", amount: 100, split: SPLIT_STATUS.SPLIT }),
      txn({ user: "alice", amount: 50, split: SPLIT_STATUS.PARTNER }),
      txn({ user: "bob", amount: 30, split: SPLIT_STATUS.SPLIT })
    ];
    var r = calcSplitSettlement(debits);
    expect(r.userPaid.alice.INR).toBe(150);
    expect(r.userPaid.bob.INR).toBe(30);
  });
});
