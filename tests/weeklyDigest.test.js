import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let weekRangeFor, formatWeeklyMessage;

const Session = { getScriptTimeZone: () => "UTC" };
const Utilities = {
  formatDate: (d, _tz, fmt) => {
    // Tiny formatter — only the patterns the code uses.
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var mon = months[d.getMonth()];
    var day = d.getDate();
    var dd = String(day).padStart(2, "0");
    if (fmt === "MMM d") return mon + " " + day;
    if (fmt === "MMM dd") return mon + " " + dd;
    return d.toISOString();
  }
};

beforeAll(() => {
  ({ weekRangeFor, formatWeeklyMessage } = loadAppsScript(["Analytics.js"], ["weekRangeFor", "formatWeeklyMessage"], {
    Session,
    Utilities,
    CATEGORY_EMOJIS: { "Food & Dining": "🍔", Shopping: "🛒" },
    CURRENCY_SYMBOLS: { INR: "₹", USD: "$", EUR: "€", JPY: "¥" },
    escapeMarkdown: (s) => String(s).replace(/([_*`\[])/g, "\\$1")
  }));
});

describe("weekRangeFor", () => {
  it("returns the rolling 7 days ending yesterday", () => {
    // Fri May 1 2026 → covers Fri Apr 24 - Thu Apr 30
    var r = weekRangeFor(new Date(2026, 4, 1));
    expect(r.start.getMonth()).toBe(3);
    expect(r.start.getDate()).toBe(24);
    expect(r.end.getMonth()).toBe(3);
    expect(r.end.getDate()).toBe(30);
    expect(r.end.getHours()).toBe(23);
  });

  it("is day-of-week independent (Mon trigger)", () => {
    // Mon Apr 27 2026 → covers Mon Apr 20 - Sun Apr 26
    var r = weekRangeFor(new Date(2026, 3, 27));
    expect(r.start.getDate()).toBe(20);
    expect(r.end.getDate()).toBe(26);
  });

  it("crosses a month boundary cleanly", () => {
    // Sat May 2 2026 → covers Sat Apr 25 - Fri May 1
    var r = weekRangeFor(new Date(2026, 4, 2));
    expect(r.start.getMonth()).toBe(3);
    expect(r.start.getDate()).toBe(25);
    expect(r.end.getMonth()).toBe(4);
    expect(r.end.getDate()).toBe(1);
  });

  it("start is local midnight, end is local 23:59:59.999", () => {
    var r = weekRangeFor(new Date(2026, 3, 27));
    expect(r.start.getHours()).toBe(0);
    expect(r.start.getMinutes()).toBe(0);
    expect(r.end.getHours()).toBe(23);
    expect(r.end.getMinutes()).toBe(59);
    expect(r.end.getMilliseconds()).toBe(999);
  });
});

function makeRange() {
  return { start: new Date(2026, 3, 20), end: new Date(2026, 3, 26) };
}

describe("formatWeeklyMessage", () => {
  it("includes header with date label and INR total", () => {
    var msg = formatWeeklyMessage(makeRange(), {
      totalTransactions: 1,
      spentByCurrency: { INR: 500 },
      prevSpentByCurrency: {},
      categorySpend: { "Shopping|||INR": 500 },
      topTransactions: []
    });
    expect(msg).toContain("Apr 20–Apr 26");
    expect(msg).toContain("₹500");
  });

  it("omits delta when previous week had zero INR", () => {
    var msg = formatWeeklyMessage(makeRange(), {
      totalTransactions: 1,
      spentByCurrency: { INR: 500 },
      prevSpentByCurrency: { INR: 0 },
      categorySpend: { "Shopping|||INR": 500 },
      topTransactions: []
    });
    expect(msg).not.toContain("vs");
  });

  it("shows up-arrow delta when spending increased", () => {
    var msg = formatWeeklyMessage(makeRange(), {
      totalTransactions: 1,
      spentByCurrency: { INR: 1500 },
      prevSpentByCurrency: { INR: 1000 },
      categorySpend: { "Shopping|||INR": 1500 },
      topTransactions: []
    });
    expect(msg).toContain("↑50%");
    expect(msg).toContain("vs ₹1000");
  });

  it("shows down-arrow delta when spending decreased", () => {
    var msg = formatWeeklyMessage(makeRange(), {
      totalTransactions: 1,
      spentByCurrency: { INR: 800 },
      prevSpentByCurrency: { INR: 1000 },
      categorySpend: { "Shopping|||INR": 800 },
      topTransactions: []
    });
    expect(msg).toContain("↓20%");
  });

  it("collapses categories beyond the top 5", () => {
    var cats = {};
    ["A", "B", "C", "D", "E", "F", "G"].forEach(function (c, i) {
      cats[c + "|||INR"] = (7 - i) * 100;
    });
    var msg = formatWeeklyMessage(makeRange(), {
      totalTransactions: 7,
      spentByCurrency: { INR: 2800 },
      prevSpentByCurrency: {},
      categorySpend: cats,
      topTransactions: []
    });
    // No backslash escape — "+" isn't a special char in legacy Markdown,
    // so the previous "\\+2 more" rendered as a visible backslash in chat.
    expect(msg).toContain("+2 more");
    expect(msg).not.toContain("F  ₹"); // F is in collapsed bucket
  });

  it("renders non-INR currencies on a separate line", () => {
    var msg = formatWeeklyMessage(makeRange(), {
      totalTransactions: 2,
      spentByCurrency: { INR: 500, USD: 30 },
      prevSpentByCurrency: {},
      categorySpend: { "Shopping|||INR": 500, "Shopping|||USD": 30 },
      topTransactions: []
    });
    // Non-INR currencies now render with the currency symbol ("$30") instead
    // of the 3-letter code ("USD 30") — see currencySymbol() in Analytics.js.
    expect(msg).toContain("$30");
  });

  it("lists top transactions when present", () => {
    var msg = formatWeeklyMessage(makeRange(), {
      totalTransactions: 2,
      spentByCurrency: { INR: 800 },
      prevSpentByCurrency: {},
      categorySpend: { "Shopping|||INR": 800 },
      topTransactions: [
        { merchant: "Swiggy", amount: 500, currency: "INR", date: new Date(2026, 3, 23) },
        { merchant: "Amazon", amount: 300, currency: "INR", date: new Date(2026, 3, 24) }
      ]
    });
    expect(msg).toContain("*Top:*");
    expect(msg).toContain("Swiggy");
    expect(msg).toContain("Amazon");
  });
});

// Regression: sendWeeklySummaries used to fan out to *all* active tenants
// including group ones. Group sheets use a different schema (β: one row per
// share), so getAllTransactions read the wrong columns — every group digest
// came out as ₹0 with no categories. Loop must skip group tenants.
describe("sendWeeklySummaries tenant filter", () => {
  it("only sends to personal active tenants with a sheet_id", () => {
    var sent = [];
    var contextSet = [];
    var stubs = {
      Session,
      Utilities,
      CATEGORY_EMOJIS: {},
      CURRENCY_SYMBOLS: { INR: "₹" },
      escapeMarkdown: (s) => String(s),
      TENANT_STATUS: { ACTIVE: "active", PENDING: "pending" },
      TENANT_CHAT_TYPE: { PERSONAL: "personal", GROUP: "group" },
      loadTenants: () => [
        { chat_id: "1", status: "active", chat_type: "personal", sheet_id: "s1" },
        { chat_id: "2", status: "active", chat_type: "group", sheet_id: "g1" },
        { chat_id: "3", status: "pending", chat_type: "personal", sheet_id: "s3" },
        { chat_id: "4", status: "active", chat_type: "personal", sheet_id: "" }
      ],
      setCurrentTenant: (t) => contextSet.push(t && t.chat_id),
      weekRangeFor: () => ({ start: new Date(2026, 3, 17), end: new Date(2026, 3, 23) }),
      getWeeklyAnalytics: () => ({
        totalTransactions: 1,
        spentByCurrency: { INR: 100 },
        prevSpentByCurrency: {},
        categorySpend: {},
        topTransactions: []
      }),
      formatWeeklyMessage: () => "msg",
      sendTelegramMessage: (chatId) => sent.push(chatId)
    };
    var { sendWeeklySummaries } = loadAppsScript(["Code.js"], ["sendWeeklySummaries"], stubs);

    sendWeeklySummaries();

    expect(sent).toEqual(["1"]);
    expect(contextSet).toEqual(["1", null]);
  });
});
