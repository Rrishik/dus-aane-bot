import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

let getWeeklyTrendsAnalytics, formatTrendsMessage, buildTrendBucket;

const Session = { getScriptTimeZone: () => "UTC" };
const Utilities = {
  formatDate: (d, _tz, fmt) => {
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var mon = months[d.getMonth()];
    var day = d.getDate();
    var dd = String(day).padStart(2, "0");
    if (fmt === "MMM yy") return mon + " " + String(d.getFullYear()).slice(-2);
    if (fmt === "MMM dd") return mon + " " + dd;
    if (fmt === "MMM d") return mon + " " + day;
    return d.toISOString();
  }
};

// Freeze "today" — getWeeklyTrendsAnalytics anchors off weekRangeFor(new Date())
// and we need deterministic bucket boundaries.
const TODAY = new Date(2026, 4, 11); // Mon May 11 2026

// Column constants mirror the production layout (see Constants.js) so the
// real getAllTransactions reads our fixture rows correctly.
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
  EMAIL_LINK_COLUMN: 10,
  GROUP_REF_COLUMN: 11,
  GROUP_MESSAGE_ID_COLUMN: 12
};

// Build a minimal Sheet-shaped object that getAllTransactions can read.
function fakeSheetWithRows(txns) {
  var header = new Array(12).fill("h");
  var rows = txns.map((t) => {
    var r = new Array(12).fill("");
    r[COLS.EMAIL_DATE_COLUMN - 1] = t.date;
    r[COLS.TRANSACTION_DATE_COLUMN - 1] = t.date;
    r[COLS.MERCHANT_COLUMN - 1] = t.merchant;
    r[COLS.AMOUNT_COLUMN - 1] = t.amount;
    r[COLS.CATEGORY_COLUMN - 1] = t.category;
    r[COLS.TRANSACTION_TYPE_COLUMN - 1] = t.type;
    r[COLS.USER_COLUMN - 1] = t.user;
    r[COLS.CURRENCY_COLUMN - 1] = t.currency;
    return r;
  });
  return {
    getSheets: () => [
      {
        getDataRange: () => ({ getValues: () => [header].concat(rows) })
      }
    ]
  };
}

// Mutable holder so each test can swap in its own fixture without re-loading
// the Analytics module.
const sheetHolder = { current: fakeSheetWithRows([]) };

beforeAll(() => {
  vi.setSystemTime(TODAY);
  ({ getWeeklyTrendsAnalytics, formatTrendsMessage, buildTrendBucket } = loadAppsScript(
    ["Analytics.js"],
    ["getWeeklyTrendsAnalytics", "formatTrendsMessage", "buildTrendBucket"],
    Object.assign({}, COLS, {
      Session,
      Utilities,
      CATEGORY_EMOJIS: { "Food & Dining": "🍔", Shopping: "🛒" },
      CURRENCY_SYMBOLS: { INR: "₹", USD: "$" },
      escapeMarkdown: (s) => String(s).replace(/([_*`\[])/g, "\\$1"),
      getSpreadsheet: () => sheetHolder.current
    })
  ));
});

beforeEach(() => {
  sheetHolder.current = fakeSheetWithRows([]);
});

function setFixture(txns) {
  sheetHolder.current = fakeSheetWithRows(txns);
}

function txn(overrides) {
  return Object.assign(
    {
      date: new Date(2026, 4, 10),
      merchant: "X",
      amount: 100,
      category: "Food & Dining",
      type: "Debit",
      user: "alice",
      currency: "INR"
    },
    overrides
  );
}

describe("getWeeklyTrendsAnalytics", () => {
  it("returns N buckets oldest-to-newest, each a 7-day window", () => {
    var buckets = getWeeklyTrendsAnalytics(5);
    expect(buckets.length).toBe(5);
    var labels = buckets.map((b) => b.label);
    // TODAY=May 11 → newest bucket = May 4 – May 10 → label "May 04".
    // 5 weeks back → oldest bucket starts Apr 6.
    expect(labels[labels.length - 1]).toBe("May 04");
    expect(labels[0]).toBe("Apr 06");
  });

  it("buckets transactions by their actual date", () => {
    setFixture([
      txn({ date: new Date(2026, 4, 5), amount: 200, currency: "INR" }), // newest bucket (May 4 - May 10)
      txn({ date: new Date(2026, 4, 9), amount: 50, currency: "INR" }), // also newest
      txn({ date: new Date(2026, 3, 28), amount: 300, currency: "INR" }), // 2nd-newest (Apr 27 - May 3)
      txn({ date: new Date(2026, 3, 7), amount: 999, currency: "INR" }) // oldest bucket (Apr 6 - Apr 12)
    ]);
    var buckets = getWeeklyTrendsAnalytics(5);
    expect(buckets[buckets.length - 1].debitByCurrency.INR).toBe(250);
    expect(buckets[buckets.length - 2].debitByCurrency.INR).toBe(300);
    expect(buckets[0].debitByCurrency.INR).toBe(999);
  });

  it("defaults to 5 weeks when called without args", () => {
    expect(getWeeklyTrendsAnalytics().length).toBe(5);
  });
});

describe("formatTrendsMessage (shared core)", () => {
  it("renders the weekly title and comparison label when passed weekly opts", () => {
    var buckets = [
      buildTrendBucket([txn({ amount: 1000, currency: "INR" })], "Apr 27"),
      buildTrendBucket([txn({ amount: 1500, currency: "INR" })], "May 04")
    ];
    var msg = formatTrendsMessage(buckets, { title: "📉 *Spending Trends* — Weekly", comparisonLabel: "vs Last Week" });
    expect(msg).toContain("📉 *Spending Trends* — Weekly");
    expect(msg).toContain("vs Last Week");
    expect(msg).toContain("Apr 27");
    expect(msg).toContain("May 04");
  });

  it("falls back to default title and 'vs Previous' when opts omitted", () => {
    var buckets = [
      buildTrendBucket([txn({ amount: 100, currency: "INR" })], "X"),
      buildTrendBucket([txn({ amount: 200, currency: "INR" })], "Y")
    ];
    var msg = formatTrendsMessage(buckets);
    expect(msg).toContain("📉 *Spending Trends*");
    expect(msg).toContain("vs Previous");
  });

  it("renders the INR debit row wrapped in a code span for monospaced alignment", () => {
    var buckets = [
      buildTrendBucket([txn({ amount: 500, currency: "INR" })], "Apr 27"),
      buildTrendBucket([txn({ amount: 54321, currency: "INR" })], "May 04")
    ];
    var msg = formatTrendsMessage(buckets);
    // Bar-row amounts use the compact form (sub-1K integer, ≥1K → "X.XK")
    // and are ₹-anchored — the ₹ sits flush against the digits, with any
    // pad spaces *after* the amount so the symbol column aligns vertically.
    expect(msg).toMatch(/`Apr 27.*₹500\s*`/);
    expect(msg).toMatch(/`May 04.*₹54\.3K\s*`/);
  });

  it("hides Credits section entirely when no credits exist", () => {
    var buckets = [
      buildTrendBucket([txn({ amount: 100, currency: "INR" })], "A"),
      buildTrendBucket([txn({ amount: 200, currency: "INR" })], "B")
    ];
    var msg = formatTrendsMessage(buckets);
    expect(msg).not.toContain("*Credits:*");
  });

  it("shows Credits section when at least one bucket has credits", () => {
    var buckets = [
      buildTrendBucket([txn({ amount: 100, currency: "INR" })], "A"),
      buildTrendBucket([txn({ amount: 5000, currency: "INR", type: "Credit", category: "Salary" })], "B")
    ];
    var msg = formatTrendsMessage(buckets);
    expect(msg).toContain("*Credits:*");
    // Credits use the compact form too: 5000 → "5.0K".
    expect(msg).toContain("₹5.0K");
  });
});
