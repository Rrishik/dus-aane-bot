import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "admin-sheet";

// Header matching production's TENANT_HEADERS (col 18 = pin_message_id).
var TENANT_HEADERS = [
  "chat_id",
  "name",
  "emails",
  "sheet_id",
  "status",
  "created_at",
  "notes",
  "last_forward_at",
  "last_nag_at",
  "nag_count",
  "chat_type",
  "group_members",
  "primary_currency",
  "ask_used_today",
  "ask_used_date",
  "ask_lifetime_count",
  "ask_cap_hit_count",
  "pin_message_id"
];

function urlStubs() {
  return {
    BOT_TOKEN: "test",
    BOT_SEND_MESSAGE_URL: "https://api.telegram.test/bot/sendMessage",
    BOT_EDIT_MESSAGE_URL: "https://api.telegram.test/bot/editMessageText",
    BOT_PIN_CHAT_MESSAGE_URL: "https://api.telegram.test/bot/pinChatMessage",
    BOT_ANSWER_CALLBACK_QUERY_URL: "https://api.telegram.test/bot/answerCallbackQuery",
    BOT_DELETE_MESSAGE_URL: "https://api.telegram.test/bot/deleteMessage"
  };
}

// β-row builder for group sheet seeding. Only the columns aggregatePairwiseDebts
// reads are populated; the rest are filler.
function bRow(currency, payer, holder, share, category) {
  return ["", "", "", "", currency, payer, holder, share, "tx", category || "Food", "Debit", "msg"];
}

// ─── formatGroupBalancesPin (pure) ──────────────────────────────────────────

describe("formatGroupBalancesPin", () => {
  function load() {
    return loadAppsScript(
      ["TelegramUtils.js", "Analytics.js", "Groups.js"],
      ["formatGroupBalancesPin", "PIN_CURRENCY_CAP"],
      {
        CURRENCY_SYMBOLS: { INR: "₹", USD: "$", EUR: "€", JPY: "¥", GBP: "£" }
      }
    );
  }

  var nameOf = function (id) {
    return { 111: "Alice", 222: "Bob", 333: "Carol" }[id] || id;
  };

  it("renders 'all settled up' when no balances", () => {
    var { formatGroupBalancesPin } = load();
    var text = formatGroupBalancesPin({}, nameOf, "Pad");
    expect(text).toContain("Pad");
    expect(text).toContain("live balances");
    expect(text).toContain("All settled up");
  });

  it("renders a single currency with debtor → creditor and the symbol", () => {
    var { formatGroupBalancesPin } = load();
    var text = formatGroupBalancesPin({ INR: [{ debtor: "111", creditor: "222", amount: 450 }] }, nameOf, "Pad");
    expect(text).toContain("Alice → Bob");
    expect(text).toContain("₹450");
    expect(text).not.toContain("more currenc");
  });

  it("caps at top 3 currencies by total volume and collapses the rest", () => {
    var { formatGroupBalancesPin } = load();
    var text = formatGroupBalancesPin(
      {
        INR: [{ debtor: "111", creditor: "222", amount: 1000 }],
        USD: [{ debtor: "111", creditor: "222", amount: 500 }],
        EUR: [{ debtor: "111", creditor: "222", amount: 250 }],
        JPY: [{ debtor: "111", creditor: "222", amount: 100 }],
        GBP: [{ debtor: "111", creditor: "222", amount: 50 }]
      },
      nameOf,
      "Pad"
    );
    // Top 3 by total: INR, USD, EUR.
    expect(text).toContain("₹1000");
    expect(text).toContain("$500");
    expect(text).toContain("€250");
    // Bottom 2 collapsed.
    expect(text).not.toContain("¥");
    expect(text).not.toContain("£");
    expect(text).toContain("+2 more currencies");
  });

  it("single hidden currency uses singular wording", () => {
    var { formatGroupBalancesPin } = load();
    var text = formatGroupBalancesPin(
      {
        INR: [{ debtor: "111", creditor: "222", amount: 1000 }],
        USD: [{ debtor: "111", creditor: "222", amount: 500 }],
        EUR: [{ debtor: "111", creditor: "222", amount: 250 }],
        JPY: [{ debtor: "111", creditor: "222", amount: 100 }]
      },
      nameOf,
      "Pad"
    );
    expect(text).toContain("+1 more currency");
    expect(text).not.toContain("currencies");
  });

  it("falls back to chat_id when nameOf returns nothing", () => {
    var { formatGroupBalancesPin } = load();
    var text = formatGroupBalancesPin(
      { INR: [{ debtor: "999", creditor: "888", amount: 10 }] },
      function () {
        return "";
      },
      "Pad"
    );
    expect(text).toContain("999");
    expect(text).toContain("888");
  });
});

// ─── refreshGroupSplitPin (orchestrator integration) ────────────────────────

function setupGroupFixture(opts) {
  var SpreadsheetApp = makeSpreadsheetApp();

  // Admin Tenants tab — single group row, with whatever pin_message_id the
  // test asks for in col 18.
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var tab = ss.insertSheet("Tenants");
  tab.appendRow(TENANT_HEADERS);
  var memberRow = function (id, name, sheetId) {
    return [id, name, "", sheetId, "active", "", "", "", "", 0, "personal", "", "INR", 0, "", 0, 0, ""];
  };
  tab.appendRow(memberRow("111", "Alice", "s1"));
  tab.appendRow(memberRow("222", "Bob", "s2"));
  tab.appendRow([
    "-100",
    "Pad",
    "",
    "g1",
    "active",
    "",
    "admin=111",
    "",
    "",
    0,
    "group",
    "111,222",
    "INR",
    0,
    "",
    0,
    0,
    opts.pinMessageId || ""
  ]);

  // Group sheet with header + one 50/50 split worth 600 INR → Bob owes Alice 300.
  var groupSs = SpreadsheetApp.openById("g1");
  var groupSheet = groupSs.getSheets()[0];
  groupSheet.appendRow([
    "Email Date",
    "Tx Date",
    "Merchant",
    "Amount",
    "Currency",
    "Paid By",
    "Share Holder",
    "Share Amount",
    "Tx ID",
    "Category",
    "Tx Type",
    "Msg Id"
  ]);
  groupSheet.appendRow(bRow("INR", "111", "111", 300, "Food"));
  groupSheet.appendRow(bRow("INR", "111", "222", 300, "Food"));

  return { SpreadsheetApp: SpreadsheetApp, groupSheet: groupSheet };
}

function makeFetch(sent, fetchOverride) {
  return {
    fetch: vi.fn((url, opts) => {
      var payload = JSON.parse(opts.payload);
      sent.push({ url: url, payload: payload });
      if (fetchOverride) {
        var override = fetchOverride(url, payload);
        if (override) return override;
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: { message_id: 42 } })
      };
    })
  };
}

function loadOrchestrator(SpreadsheetApp, sent, fetchOverride) {
  return loadAppsScript(
    ["TelegramUtils.js", "TenantRegistry.js", "GroupSheet.js", "Analytics.js", "Groups.js"],
    ["refreshGroupSplitPin", "findGroupTenantByChatId", "invalidateTenantCache", "loadTenants"],
    {
      ...urlStubs(),
      G_EMAIL_DATE_COLUMN: 1,
      G_TRANSACTION_DATE_COLUMN: 2,
      G_MERCHANT_COLUMN: 3,
      G_AMOUNT_COLUMN: 4,
      G_CURRENCY_COLUMN: 5,
      G_PAID_BY_COLUMN: 6,
      G_SHARE_HOLDER_COLUMN: 7,
      G_SHARE_AMOUNT_COLUMN: 8,
      G_TX_ID_COLUMN: 9,
      G_CATEGORY_COLUMN: 10,
      G_TRANSACTION_TYPE_COLUMN: 11,
      G_MESSAGE_ID_COLUMN: 12,
      G_COL_COUNT: 12,
      CURRENCY_SYMBOLS: { INR: "₹", USD: "$" },
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent, fetchOverride),
      Utilities: { sleep: () => {} }
    }
  );
}

describe("refreshGroupSplitPin — bootstrap", () => {
  it("first call: sends the balance card, pins it, stores message_id on the tenant", () => {
    var sent = [];
    var fix = setupGroupFixture({});
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent);

    var group = mod.findGroupTenantByChatId("-100");
    mod.refreshGroupSplitPin(group);

    var sendCall = sent.find((s) => s.url.indexOf("/sendMessage") !== -1);
    var pinCall = sent.find((s) => s.url.indexOf("/pinChatMessage") !== -1);
    expect(sendCall).toBeDefined();
    expect(sendCall.payload.chat_id).toBe("-100");
    expect(sendCall.payload.text).toContain("Bob → Alice");
    expect(pinCall).toBeDefined();
    // pinTelegramMessage forwards the string id from sendMessage's response.
    expect(String(pinCall.payload.message_id)).toBe("42");
    expect(pinCall.payload.disable_notification).toBe(true);

    // pin_message_id persisted on the tenant row.
    mod.invalidateTenantCache();
    var reloaded = mod.findGroupTenantByChatId("-100");
    expect(reloaded.pin_message_id).toBe("42");
  });

  it("bot-not-admin: pin fails → marks 'skip' sentinel and posts a one-time nudge", () => {
    var sent = [];
    var fix = setupGroupFixture({});
    // Mock fetch: succeed on sendMessage, fail on pinChatMessage with a 400.
    var fetchOverride = function (url) {
      if (url.indexOf("/pinChatMessage") !== -1) {
        return {
          getResponseCode: () => 400,
          getContentText: () => JSON.stringify({ ok: false, description: "Bad Request: not enough rights" })
        };
      }
      return null;
    };
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent, fetchOverride);
    // Pin-fail path logs to console.error/warn by design — silence the noise.
    var err = vi.spyOn(console, "error").mockImplementation(() => {});
    var warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    var group = mod.findGroupTenantByChatId("-100");
    mod.refreshGroupSplitPin(group);

    mod.invalidateTenantCache();
    var reloaded = mod.findGroupTenantByChatId("-100");
    expect(reloaded.pin_message_id).toBe("skip");

    // One-time group nudge.
    var nudge = sent.find(function (s) {
      return (
        s.url.indexOf("/sendMessage") !== -1 &&
        String(s.payload.chat_id) === "-100" &&
        /Couldn't pin/.test(s.payload.text)
      );
    });
    expect(nudge).toBeDefined();

    // Admin DM.
    var adminDm = sent.find(function (s) {
      return s.url.indexOf("/sendMessage") !== -1 && String(s.payload.chat_id) === "111";
    });
    expect(adminDm).toBeDefined();
    expect(adminDm.payload.text).toMatch(/Pin messages/);
    err.mockRestore();
    warn.mockRestore();
  });

  it("after skip sentinel: subsequent calls are no-ops (no sends, no pins)", () => {
    var sent = [];
    var fix = setupGroupFixture({ pinMessageId: "skip" });
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent);

    var group = mod.findGroupTenantByChatId("-100");
    mod.refreshGroupSplitPin(group);

    expect(sent).toHaveLength(0);
  });
});

describe("refreshGroupSplitPin — edit existing pin", () => {
  it("edits the pinned message in place when pin_message_id is set", () => {
    var sent = [];
    var fix = setupGroupFixture({ pinMessageId: "99" });
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent);

    mod.refreshGroupSplitPin(mod.findGroupTenantByChatId("-100"));

    // editMessageText hit, no fresh send + no fresh pin.
    var edit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    expect(edit).toBeDefined();
    expect(String(edit.payload.chat_id)).toBe("-100");
    expect(String(edit.payload.message_id)).toBe("99");
    expect(edit.payload.text).toContain("Bob → Alice");
    expect(sent.find((s) => s.url.indexOf("/pinChatMessage") !== -1)).toBeUndefined();
  });

  it("edit failure → clears stale id, re-bootstraps (send + pin)", () => {
    var sent = [];
    var fix = setupGroupFixture({ pinMessageId: "99" });
    // Mock fetch: editMessageText returns ok:false → triggers re-bootstrap.
    var fetchOverride = function (url) {
      if (url.indexOf("/editMessageText") !== -1) {
        return {
          getResponseCode: () => 400,
          getContentText: () => JSON.stringify({ ok: false, description: "Bad Request: message to edit not found" })
        };
      }
      return null;
    };
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent, fetchOverride);
    var err = vi.spyOn(console, "error").mockImplementation(() => {});
    var warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mod.refreshGroupSplitPin(mod.findGroupTenantByChatId("-100"));

    // Re-bootstrap kicked in: a fresh sendMessage + pinChatMessage happened.
    expect(sent.find((s) => s.url.indexOf("/sendMessage") !== -1)).toBeDefined();
    expect(sent.find((s) => s.url.indexOf("/pinChatMessage") !== -1)).toBeDefined();

    mod.invalidateTenantCache();
    expect(mod.findGroupTenantByChatId("-100").pin_message_id).toBe("42"); // new id
    err.mockRestore();
    warn.mockRestore();
  });
});

describe("refreshGroupSplitPin — guards", () => {
  it("no-op on null tenant", () => {
    var sent = [];
    var fix = setupGroupFixture({});
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent);
    mod.refreshGroupSplitPin(null);
    expect(sent).toHaveLength(0);
  });

  it("no-op on personal (non-group) tenant", () => {
    var sent = [];
    var fix = setupGroupFixture({});
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent);
    mod.refreshGroupSplitPin({
      chat_id: "111",
      chat_type: "personal",
      status: "active",
      sheet_id: "s1",
      pin_message_id: ""
    });
    expect(sent).toHaveLength(0);
  });

  it("no-op on disabled group tenant", () => {
    var sent = [];
    var fix = setupGroupFixture({});
    var mod = loadOrchestrator(fix.SpreadsheetApp, sent);
    mod.refreshGroupSplitPin({
      chat_id: "-100",
      chat_type: "group",
      status: "disabled",
      sheet_id: "g1",
      pin_message_id: ""
    });
    expect(sent).toHaveLength(0);
  });
});
