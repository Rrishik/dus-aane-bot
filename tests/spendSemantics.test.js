import { describe, it, expect } from "vitest";
import { loadAppsScript } from "./_loader.js";

const COLS = {
  EMAIL_DATE_COLUMN: 1,
  TRANSACTION_DATE_COLUMN: 2,
  MERCHANT_COLUMN: 3,
  AMOUNT_COLUMN: 4,
  CATEGORY_COLUMN: 5,
  TRANSACTION_TYPE_COLUMN: 6,
  USER_COLUMN: 7,
  MESSAGE_ID_COLUMN: 8,
  CURRENCY_COLUMN: 9,
  GROUP_REF_COLUMN: 10
};

const d = new Date("2026-10-05T10:00:00");
const txn = (amount, category, type) => ({
  date: d,
  merchant: "M",
  amount: amount,
  category: category,
  type: type || "Debit",
  user: "a",
  currency: "INR",
  messageId: "id"
});
const TXNS = [
  txn(500, "Food & Dining"),
  txn(300, "Shopping", "debit"),
  txn(20000, "CC Bill Payment"),
  txn(5000, "Transfer Out"),
  txn(10000, "Investment"),
  txn(80000, "Salary", "Credit")
];

function load(extra) {
  return loadAppsScript(
    ["Analytics.js", "AskTools.js"],
    ["buildTrendBucket", "executeAskTool", "getAllTransactions", "isSpendTransaction"],
    Object.assign(
      {
        ...COLS,
        Session: { getScriptTimeZone: () => "Asia/Kolkata" },
        Utilities: { formatDate: () => "2026-10-05" }
      },
      extra || {}
    )
  );
}

describe("spend excludes money that just moves", () => {
  it("trend buckets count spend only; credits stay separate", () => {
    var b = load().buildTrendBucket(TXNS, "Oct");
    expect(b.debitByCurrency).toEqual({ INR: 800 });
    expect(b.creditByCurrency).toEqual({ INR: 80000 });
    expect(Object.keys(b.categorySpend).sort()).toEqual(["Food & Dining", "Shopping"]);
  });

  it("/ask summary reports spend and non-spend debits separately", () => {
    var out = load().executeAskTool("get_spending_summary", {}, TXNS, {});
    expect(out.spend_by_currency).toEqual({ INR: 800 });
    expect(out.non_spend_debits_by_currency).toEqual({ INR: 35000 });
    expect(out.credits_by_currency).toEqual({ INR: 80000 });
    expect(out.spend_count).toBe(2);
  });

  it("/ask category breakdown keeps every debit category but marks non-spend ones", () => {
    var cats = load().executeAskTool("get_category_breakdown", {}, TXNS, {}).categories;
    var byName = Object.fromEntries(cats.map((c) => [c.name, c.counts_as_spend]));
    expect(byName).toEqual({
      "CC Bill Payment": false,
      Investment: false,
      "Transfer Out": false,
      "Food & Dining": true,
      Shopping: true
    });
  });

  it("/ask top merchants ignore card bill payments", () => {
    var m = load().executeAskTool("get_top_merchants", {}, [txn(20000, "CC Bill Payment"), txn(10, "Shopping")], {});
    expect(m.merchants.map((x) => x.amount)).toEqual([10]);
  });
});

describe("getAllTransactions", () => {
  it("skips unconfirmed review rows", () => {
    var rows = [
      new Array(14).fill("h"),
      [d, "2026-10-05", "Kept", 10, "Shopping", "Debit", "a", "m1", "INR", "", "", "llm", "", ""],
      [d, "2026-10-05", "Pending", 99, "Shopping", "Debit", "a", "m2", "INR", "", "", "tpl", "", "review"]
    ];
    var api = load({
      getSpreadsheet: () => ({ getSheets: () => [{ getDataRange: () => ({ getValues: () => rows }) }] })
    });
    expect(api.getAllTransactions().map((t) => t.merchant)).toEqual(["Kept"]);
  });
});
