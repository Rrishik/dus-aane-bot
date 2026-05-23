import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let sumByCurrency, aggregateByUser, aggregateByField, filterByDateRange;

beforeAll(() => {
  ({ sumByCurrency, aggregateByUser, aggregateByField, filterByDateRange } = loadAppsScript(
    ["Analytics.js"],
    ["sumByCurrency", "aggregateByUser", "aggregateByField", "filterByDateRange"],
    { CATEGORY_EMOJIS: {} }
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
