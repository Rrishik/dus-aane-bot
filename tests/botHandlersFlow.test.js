// Coverage tests for BotHandlers.js entry points that aren't reached by the
// existing integration suites (callbackDispatch, commandDispatch, parseBackfillDuration).
// Loads BotHandlers.js standalone with every cross-module call stubbed so
// these are pure unit tests of the routing/composition logic in this file.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

const TENANT_CHAT_TYPE = { PERSONAL: "personal", GROUP: "group" };

// Personal sheet column indices (1-based) — match Constants.js.
const PERSONAL_COLS = {
  EMAIL_DATE_COLUMN: 1,
  TRANSACTION_DATE_COLUMN: 2,
  MERCHANT_COLUMN: 3,
  AMOUNT_COLUMN: 4,
  CATEGORY_COLUMN: 5,
  TRANSACTION_TYPE_COLUMN: 6,
  USER_COLUMN: 7,
  SPLIT_COLUMN: 8,
  MESSAGE_ID_COLUMN: 9,
  CURRENCY_COLUMN: 10,
  EMAIL_LINK_COLUMN: 11,
  GROUP_REF_COLUMN: 12,
  GROUP_MESSAGE_ID_COLUMN: 13
};

// Group sheet column indices (1-based, β schema).
const GROUP_COLS = {
  G_EMAIL_DATE_COLUMN: 1,
  G_TRANSACTION_DATE_COLUMN: 2,
  G_MERCHANT_COLUMN: 3,
  G_AMOUNT_COLUMN: 4,
  G_CURRENCY_COLUMN: 5,
  G_PAID_BY_COLUMN: 6,
  G_HOLDER_COLUMN: 7,
  G_SHARE_AMOUNT_COLUMN: 8,
  G_TX_ID_COLUMN: 9,
  G_CATEGORY_COLUMN: 10,
  G_TRANSACTION_TYPE_COLUMN: 11,
  G_MESSAGE_ID_COLUMN: 12,
  G_EMAIL_LINK_COLUMN: 13
};

// Minimal in-process sheet mock that supports the calls BotHandlers makes:
// getDataRange().getValues() returns the full 2D array (header + rows).
function makeSheet(header, rows) {
  var data = [header.slice()].concat(rows.map((r) => r.slice()));
  return {
    getDataRange: () => ({ getValues: () => data })
  };
}

function makeProps(initial) {
  var store = Object.assign({}, initial || {});
  return {
    store: store,
    api: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => {
          store[k] = String(v);
        },
        deleteProperty: (k) => {
          delete store[k];
        }
      })
    }
  };
}

function baseStubs(overrides) {
  var props = makeProps();
  var sent = [];
  var stubs = Object.assign(
    {
      TENANT_CHAT_TYPE: TENANT_CHAT_TYPE,
      CATEGORIES: ["Shopping", "Groceries", "Food & Dining", "Healthcare"],
      CREDIT_CATEGORIES: ["Salary", "Refund"],
      CATEGORY_EMOJIS: { Shopping: "🛍", Groceries: "🥦", "Food & Dining": "🍕", Salary: "💰" },
      ADMIN_CHAT_ID: "999",
      Logger: { log: () => {} },
      PropertiesService: props.api,
      Utilities: {
        sleep: () => {},
        getUuid: () => "uuid-1",
        formatDate: (date, _tz, fmt) =>
          "FMT(" + (date && date.toISOString ? date.toISOString() : date) + "," + fmt + ")"
      },
      Session: { getScriptTimeZone: () => "Asia/Kolkata" },
      sendTelegramMessage: (chat, text, opts) => sent.push({ chat: chat, text: text, opts: opts }),
      answerCallbackQuery: vi.fn(),
      sendChatAction: vi.fn(),
      editTelegramReplyMarkup: vi.fn(),
      escapeMarkdown: (s) => String(s == null ? "" : s).replace(/([_*`[\]])/g, "\\$1"),
      currencySymbol: (c) => (c === "INR" ? "₹" : c + " "),
      formatAmount: (n) => String(n),
      shortCategoryName: (c) => c,
      isDebit: (t) => /debit/i.test(String(t || "")),
      getCategoryListForType: (t) =>
        /credit/i.test(String(t || "")) ? ["Salary", "Refund"] : ["Shopping", "Groceries", "Food & Dining"],
      getCurrentTenant: () => null,
      getTenantSheetId: () => "sheet-xyz",
      sheetUrl: (id) => "https://sheets/" + id,
      findTenantByChatId: () => null,
      gateTenantForCommand: () => true,
      // Onboarding / register / ask helpers wired below as no-ops by default.
      handleStartCommand: vi.fn(),
      handleRegisterCommand: vi.fn(),
      handleRegisterEmailReply: vi.fn(() => false),
      handleAccountCommand: vi.fn(),
      // Analytics / Ask deps.
      getTrendsAnalytics: vi.fn(() => [{ label: "Apr", debits: { INR: 1000 } }]),
      getWeeklyTrendsAnalytics: vi.fn(() => [{ label: "W17", debits: { INR: 1000 } }]),
      formatTrendsMessage: vi.fn((data, opts) => "TRENDS:" + opts.title + "|" + opts.comparisonLabel),
      consumeAskQuota: vi.fn(() => ({ allowed: true })),
      refundAskQuota: vi.fn(),
      runAskLoop: vi.fn(() => ({ kind: "final", text: "an answer" })),
      saveAskConvo: vi.fn(),
      loadAskConvo: vi.fn(() => null),
      clearAskConvo: vi.fn(),
      formatAskCapHitMessage: vi.fn(() => "CAP HIT"),
      buildAskCapHitKeyboard: vi.fn(() => ({
        inline_keyboard: [[{ text: "💎 Premium", callback_data: "premium_info" }]]
      })),
      // Personal column constants.
      ...PERSONAL_COLS,
      // Group column constants.
      ...GROUP_COLS,
      TAG_MAX_LEN: 18
    },
    overrides || {}
  );
  return { stubs: stubs, props: props, sent: sent };
}

const SYMBOLS = [
  "buildRecentTransactionsMessage",
  "showRecentTransactions",
  "handleStatsCommand",
  "handleStatsCallback",
  "buildStatsMenuKeyboard",
  "buildStatsBackRow",
  "buildTrendsToggleRow",
  "handleAskCommand",
  "handleAskQuestionReply",
  "runAskFlow",
  "resumeAsk",
  "tryResumeAsk",
  "handleHelpCommand",
  "buildKeyboardForRow",
  "handleBackfillCommand"
];

function load(stubs) {
  return loadAppsScript(["BotHandlers.js"], SYMBOLS, stubs);
}

// ── buildRecentTransactionsMessage ──────────────────────────────────────────

describe("buildRecentTransactionsMessage", () => {
  function personalRow(opts) {
    var r = new Array(13).fill("");
    r[PERSONAL_COLS.EMAIL_DATE_COLUMN - 1] = opts.emailDate || new Date("2026-05-01T10:00:00Z");
    r[PERSONAL_COLS.TRANSACTION_DATE_COLUMN - 1] = opts.txDate || "";
    r[PERSONAL_COLS.MERCHANT_COLUMN - 1] = opts.merchant || "Swiggy";
    r[PERSONAL_COLS.AMOUNT_COLUMN - 1] = opts.amount || 500;
    r[PERSONAL_COLS.CATEGORY_COLUMN - 1] = opts.category || "Food & Dining";
    r[PERSONAL_COLS.TRANSACTION_TYPE_COLUMN - 1] = opts.type || "Debit";
    r[PERSONAL_COLS.USER_COLUMN - 1] = opts.user || "alice";
    r[PERSONAL_COLS.CURRENCY_COLUMN - 1] = opts.currency || "INR";
    return r;
  }

  function groupRow(opts) {
    var r = new Array(13).fill("");
    r[GROUP_COLS.G_EMAIL_DATE_COLUMN - 1] = opts.emailDate || new Date("2026-05-01T10:00:00Z");
    r[GROUP_COLS.G_MERCHANT_COLUMN - 1] = opts.merchant || "Swiggy";
    r[GROUP_COLS.G_AMOUNT_COLUMN - 1] = opts.amount || 500;
    r[GROUP_COLS.G_CURRENCY_COLUMN - 1] = opts.currency || "INR";
    r[GROUP_COLS.G_PAID_BY_COLUMN - 1] = opts.paidBy || "111";
    r[GROUP_COLS.G_HOLDER_COLUMN - 1] = opts.holder || opts.paidBy || "111";
    r[GROUP_COLS.G_TX_ID_COLUMN - 1] = opts.txId || "";
    r[GROUP_COLS.G_CATEGORY_COLUMN - 1] = opts.category || "Food & Dining";
    r[GROUP_COLS.G_TRANSACTION_TYPE_COLUMN - 1] = opts.type || "Debit";
    return r;
  }

  it("returns the empty-sheet message when only the header row exists", () => {
    var env = baseStubs({
      getSpreadsheet: () => ({ getSheets: () => [makeSheet(["h"], [])] })
    });
    var api = load(env.stubs);

    var out = api.buildRecentTransactionsMessage(5, null);
    expect(out.text).toMatch(/No transactions found yet/);
  });

  it("renders personal-schema rows with debit emoji + currency + category", () => {
    var env = baseStubs({
      getSpreadsheet: () => ({
        getSheets: () => [makeSheet(["h"], [personalRow({ merchant: "Swiggy", amount: 450 })])]
      })
    });
    var api = load(env.stubs);

    var out = api.buildRecentTransactionsMessage(5, null);
    expect(out.text).toMatch(/Recent Transactions/);
    expect(out.text).toMatch(/🔴/); // debit
    expect(out.text).toMatch(/Swiggy/);
    expect(out.text).toMatch(/₹450/);
    expect(out.text).toMatch(/Food & Dining/);
    // Personal chats: no 👤 user-tag on the date row.
    expect(out.text).not.toMatch(/👤/);
  });

  it("renders credit transactions with the green emoji", () => {
    var env = baseStubs({
      getSpreadsheet: () => ({
        getSheets: () => [makeSheet(["h"], [personalRow({ type: "Credit", merchant: "Refund Co" })])]
      })
    });
    var api = load(env.stubs);

    var out = api.buildRecentTransactionsMessage(5, null);
    expect(out.text).toMatch(/🟢/);
    expect(out.text).not.toMatch(/🔴/);
  });

  it("filters by username (case-insensitive substring)", () => {
    var env = baseStubs({
      getSpreadsheet: () => ({
        getSheets: () => [
          makeSheet(
            ["h"],
            [personalRow({ user: "alice", merchant: "Aliceshop" }), personalRow({ user: "bob", merchant: "Bobmart" })]
          )
        ]
      })
    });
    var api = load(env.stubs);

    var out = api.buildRecentTransactionsMessage(5, "AL");
    expect(out.text).toMatch(/Aliceshop/);
    expect(out.text).not.toMatch(/Bobmart/);
    expect(out.text).toMatch(/user: AL/);
  });

  it("returns a filtered no-results message when the user filter matches nothing", () => {
    var env = baseStubs({
      getSpreadsheet: () => ({
        getSheets: () => [makeSheet(["h"], [personalRow({ user: "alice" })])]
      })
    });
    var api = load(env.stubs);

    var out = api.buildRecentTransactionsMessage(5, "zelda");
    expect(out.text).toMatch(/No transactions found.*user: zelda/);
  });

  it("clamps limit into the [1, 50] range", () => {
    var env = baseStubs({
      getSpreadsheet: () => ({
        getSheets: () => [
          makeSheet(
            ["h"],
            Array.from({ length: 5 }, (_, i) => personalRow({ merchant: "M" + i }))
          )
        ]
      })
    });
    var api = load(env.stubs);

    // limit > 50 → clamped down (we only have 5 rows so all are shown).
    var hi = api.buildRecentTransactionsMessage(99999, null);
    expect((hi.text.match(/M\d/g) || []).length).toBe(5);

    // limit < 1 → clamped to 1.
    var lo = api.buildRecentTransactionsMessage(0, null);
    expect((lo.text.match(/M\d/g) || []).length).toBe(1);
  });

  it("group schema: dedups multiple share-holder rows of the same txn by Tx ID", () => {
    var env = baseStubs({
      getCurrentTenant: () => ({ chat_type: "group" }),
      findTenantByChatId: (id) => (id === "111" ? { chat_id: "111", name: "Alice" } : null),
      getSpreadsheet: () => ({
        getSheets: () => [
          makeSheet(
            ["h"],
            [
              groupRow({ txId: "tx-A", merchant: "Pizza", holder: "111" }),
              groupRow({ txId: "tx-A", merchant: "Pizza", holder: "222" }),
              groupRow({ txId: "tx-B", merchant: "Cab" })
            ]
          )
        ]
      })
    });
    var api = load(env.stubs);

    var out = api.buildRecentTransactionsMessage(10, null);
    // 2 distinct txns, not 3 share rows.
    expect((out.text.match(/Pizza/g) || []).length).toBe(1);
    expect(out.text).toMatch(/Cab/);
    // Group chats: 👤 payer label rides on the date row.
    expect(out.text).toMatch(/👤 Alice/);
  });

  it("group schema: falls back to raw chat_id when the payer tenant row is missing", () => {
    var env = baseStubs({
      getCurrentTenant: () => ({ chat_type: "group" }),
      findTenantByChatId: () => null,
      getSpreadsheet: () => ({
        getSheets: () => [makeSheet(["h"], [groupRow({ paidBy: "888", txId: "tx-x" })])]
      })
    });
    var api = load(env.stubs);

    var out = api.buildRecentTransactionsMessage(5, null);
    expect(out.text).toMatch(/👤 888/);
  });
});

// ── showRecentTransactions ──────────────────────────────────────────────────

describe("showRecentTransactions", () => {
  it("parses '/recent 7 alice' into limit + user filter", () => {
    var env = baseStubs({
      getSpreadsheet: () => ({ getSheets: () => [makeSheet(["h"], [])] })
    });
    var api = load(env.stubs);
    api.showRecentTransactions("1", "/recent 7 alice");

    expect(env.sent).toHaveLength(1);
    // Empty sheet path → the "no transactions" message.
    expect(env.sent[0].text).toMatch(/No transactions/);
  });

  it("DMs an error when buildRecentTransactionsMessage throws", () => {
    var env = baseStubs({
      getSpreadsheet: () => {
        throw new Error("sheet api blip");
      }
    });
    var api = load(env.stubs);
    api.showRecentTransactions("1", "/recent");

    expect(env.sent[0].text).toMatch(/Error fetching recent transactions/);
  });
});

// ── /stats command + callbacks ──────────────────────────────────────────────

describe("handleStatsCommand", () => {
  it("posts the stats picker with the menu keyboard", () => {
    var env = baseStubs({ getCurrentTenant: () => ({ chat_type: "personal" }) });
    var api = load(env.stubs);
    api.handleStatsCommand("1");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Stats.*pick a view/);
    var rows = env.sent[0].opts.reply_markup.inline_keyboard;
    expect(rows[0].map((b) => b.callback_data)).toEqual(["stats_recent", "stats_trends"]);
  });
});

describe("buildStatsMenuKeyboard / buildStatsBackRow / buildTrendsToggleRow", () => {
  it("menu offers Recent + Trends on one row", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var rows = api.buildStatsMenuKeyboard({ chat_type: "personal" });
    expect(rows).toHaveLength(1);
    expect(rows[0].map((b) => b.text)).toEqual(["🕒 Recent", "📉 Trends"]);
  });

  it("back row points at stats_back", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.buildStatsBackRow()).toEqual([{ text: "🔙 Back", callback_data: "stats_back" }]);
  });

  it("trends toggle labels the OTHER granularity (switch affordance)", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var wk = api.buildTrendsToggleRow("weekly");
    expect(wk[0].callback_data).toBe("stats_trendsmonthly");
    expect(wk[0].text).toMatch(/Monthly/);

    var mn = api.buildTrendsToggleRow("monthly");
    expect(mn[0].callback_data).toBe("stats_trendsweekly");
    expect(mn[0].text).toMatch(/Weekly/);
  });
});

describe("handleStatsCallback", () => {
  it("back → re-renders the menu in place (same message_id)", () => {
    var env = baseStubs({ getCurrentTenant: () => ({ chat_type: "personal" }) });
    var api = load(env.stubs);
    api.handleStatsCallback("1", 42, "cb-1", "back");

    expect(env.sent[0].opts.message_id).toBe(42);
    var rows = env.sent[0].opts.reply_markup.inline_keyboard;
    expect(rows[0][0].callback_data).toBe("stats_recent");
  });

  it("recent → renders buildRecentTransactionsMessage with a Back button", () => {
    var env = baseStubs({
      getCurrentTenant: () => ({ chat_type: "personal" }),
      getSpreadsheet: () => ({ getSheets: () => [makeSheet(["h"], [])] })
    });
    var api = load(env.stubs);
    api.handleStatsCallback("1", 42, "cb-1", "recent");

    expect(env.sent[0].opts.message_id).toBe(42);
    expect(env.sent[0].text).toMatch(/No transactions/);
    expect(env.sent[0].opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("stats_back");
  });

  it("trends (default) → weekly view + Monthly toggle button", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.handleStatsCallback("1", 42, "cb-1", "trends");

    expect(env.stubs.getWeeklyTrendsAnalytics).toHaveBeenCalledWith(5);
    expect(env.stubs.getTrendsAnalytics).not.toHaveBeenCalled();
    expect(env.sent[0].text).toMatch(/Weekly/);
    var rows = env.sent[0].opts.reply_markup.inline_keyboard;
    // First row is the granularity toggle (says "Monthly" because we're weekly now).
    expect(rows[0][0].callback_data).toBe("stats_trendsmonthly");
  });

  it("trendsmonthly → monthly view + Weekly toggle button", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.handleStatsCallback("1", 42, "cb-1", "trendsmonthly");

    expect(env.stubs.getTrendsAnalytics).toHaveBeenCalledWith(6);
    expect(env.sent[0].text).toMatch(/Monthly/);
    expect(env.sent[0].opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("stats_trendsweekly");
  });

  it("DMs error when an analytics helper throws", () => {
    var env = baseStubs({
      getWeeklyTrendsAnalytics: () => {
        throw new Error("BigQuery down");
      }
    });
    var api = load(env.stubs);
    api.handleStatsCallback("1", 42, "cb-1", "trends");

    var errMsg = env.sent.find((s) => /Error.*BigQuery down/.test(s.text));
    expect(errMsg).toBeTruthy();
  });
});

// ── /ask command + reply + runAskFlow ──────────────────────────────────────

describe("handleAskCommand", () => {
  it("with no question: stashes pending_ask_<chatId> + sends a force_reply prompt", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.handleAskCommand("1", "/ask");

    expect(env.props.store.pending_ask_1).toBe("1");
    expect(env.sent[0].opts.reply_markup.force_reply).toBe(true);
    expect(env.stubs.runAskLoop).not.toHaveBeenCalled();
  });

  it("with a question inline: clears any stale pending_ask flag and runs the loop", () => {
    var env = baseStubs();
    env.props.store.pending_ask_1 = "1"; // stale flag from a previous run
    var api = load(env.stubs);
    api.handleAskCommand("1", "/ask how much on food last month?");

    expect(env.props.store.pending_ask_1).toBeUndefined();
    expect(env.stubs.runAskLoop).toHaveBeenCalledOnce();
    expect(env.stubs.runAskLoop.mock.calls[0][0]).toBe("how much on food last month?");
  });

  it("DMs a friendly error if something at the top level throws", () => {
    var env = baseStubs({
      consumeAskQuota: () => {
        throw new Error("registry down");
      }
    });
    var api = load(env.stubs);
    api.handleAskCommand("1", "/ask anything");

    expect(env.sent.find((s) => /went wrong/.test(s.text))).toBeTruthy();
  });
});

describe("handleAskQuestionReply", () => {
  it("returns false when there is no pending_ask flag", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.handleAskQuestionReply("1", "hello")).toBe(false);
    expect(env.stubs.runAskLoop).not.toHaveBeenCalled();
  });

  it("consumes the flag and runs the loop when a question is supplied", () => {
    var env = baseStubs();
    env.props.store.pending_ask_1 = "1";
    var api = load(env.stubs);

    expect(api.handleAskQuestionReply("1", "  what now?  ")).toBe(true);
    expect(env.props.store.pending_ask_1).toBeUndefined();
    expect(env.stubs.runAskLoop.mock.calls[0][0]).toBe("what now?");
  });

  it("consumes the flag but DMs 'empty question' when the message is blank", () => {
    var env = baseStubs();
    env.props.store.pending_ask_1 = "1";
    var api = load(env.stubs);

    expect(api.handleAskQuestionReply("1", "   ")).toBe(true);
    expect(env.props.store.pending_ask_1).toBeUndefined();
    expect(env.stubs.runAskLoop).not.toHaveBeenCalled();
    expect(env.sent[0].text).toMatch(/Empty question/);
  });
});

describe("runAskFlow", () => {
  it("happy path: consumes quota, emits typing, sends the answer", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.runAskFlow("1", "is there pizza?");

    expect(env.stubs.consumeAskQuota).toHaveBeenCalledWith("1");
    expect(env.stubs.sendChatAction).toHaveBeenCalledWith("1", "typing");
    expect(env.stubs.refundAskQuota).not.toHaveBeenCalled();
    expect(env.sent[0].text).toMatch(/an answer/);
  });

  it("over-cap path: sends the cap-hit copy + premium button; never calls runAskLoop", () => {
    var env = baseStubs({
      consumeAskQuota: () => ({ allowed: false, resetInMinutes: 120 })
    });
    var api = load(env.stubs);
    api.runAskFlow("1", "another one");

    expect(env.stubs.runAskLoop).not.toHaveBeenCalled();
    expect(env.sent[0].text).toBe("CAP HIT");
    expect(env.sent[0].opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("premium_info");
  });

  it("LLM throw path: refunds the quota and DMs a friendly fallback", () => {
    var env = baseStubs({
      runAskLoop: vi.fn(() => {
        throw new Error("Azure 429");
      })
    });
    var api = load(env.stubs);
    api.runAskFlow("1", "burst");

    expect(env.stubs.refundAskQuota).toHaveBeenCalledWith("1");
    expect(env.sent.find((s) => /Something went wrong/.test(s.text))).toBeTruthy();
  });

  it("does NOT refund when the failure happened before quota consume", () => {
    var env = baseStubs({
      consumeAskQuota: () => {
        throw new Error("registry locked");
      }
    });
    var api = load(env.stubs);
    api.runAskFlow("1", "q");

    expect(env.stubs.refundAskQuota).not.toHaveBeenCalled();
  });

  it("suspend path: sends force_reply prompt and saves the convo keyed by bot message_id", () => {
    var env = baseStubs({
      // sendTelegramMessage returns the parsed Telegram response body so
      // runAskFlow can pluck out the new message_id to key the cache.
      sendTelegramMessage: vi.fn((chat, text, opts) => {
        return JSON.stringify({ ok: true, result: { message_id: 7777 } });
      }),
      runAskLoop: vi.fn(() => ({
        kind: "suspend",
        text: "which month?",
        messages: [{ role: "user", content: "spend?" }],
        askCallId: "call_xyz",
        turn: 1
      }))
    });
    var api = load(env.stubs);
    api.runAskFlow("42", "spend?");

    expect(env.stubs.sendTelegramMessage).toHaveBeenCalledOnce();
    var [, text, opts] = env.stubs.sendTelegramMessage.mock.calls[0];
    expect(text).toMatch(/which month/);
    expect(opts.reply_markup.force_reply).toBe(true);
    expect(env.stubs.saveAskConvo).toHaveBeenCalledWith(
      "42",
      7777,
      [{ role: "user", content: "spend?" }],
      "call_xyz",
      1
    );
  });

  it("suspend path: skips convo save if the Telegram response can't be parsed", () => {
    var env = baseStubs({
      sendTelegramMessage: vi.fn(() => "not-json"),
      runAskLoop: vi.fn(() => ({
        kind: "suspend",
        text: "q?",
        messages: [],
        askCallId: "c",
        turn: 1
      }))
    });
    var api = load(env.stubs);
    api.runAskFlow("42", "q");

    expect(env.stubs.saveAskConvo).not.toHaveBeenCalled();
  });

  it("error path from runAskLoop: sends text but does NOT save a convo", () => {
    var env = baseStubs({
      runAskLoop: vi.fn(() => ({ kind: "error", text: "took too many steps" }))
    });
    var api = load(env.stubs);
    api.runAskFlow("1", "q");

    expect(env.sent[0].text).toMatch(/took too many steps/);
    expect(env.stubs.saveAskConvo).not.toHaveBeenCalled();
  });
});

describe("tryResumeAsk", () => {
  it("returns false (no-op) when no convo is cached for the replied-to message", () => {
    var env = baseStubs(); // loadAskConvo returns null by default
    var api = load(env.stubs);
    expect(api.tryResumeAsk("1", 99, "any text")).toBe(false);
    expect(env.stubs.runAskLoop).not.toHaveBeenCalled();
    expect(env.stubs.clearAskConvo).not.toHaveBeenCalled();
  });

  it("returns false when replyToMessageId is missing", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.tryResumeAsk("1", null, "x")).toBe(false);
    expect(env.stubs.loadAskConvo).not.toHaveBeenCalled();
  });

  it("clears the convo BEFORE resuming (single-use semantics)", () => {
    var calls = [];
    var env = baseStubs({
      loadAskConvo: vi.fn(() => ({
        messages: [{ role: "user", content: "q" }],
        askCallId: "call_1",
        turn: 1
      })),
      clearAskConvo: vi.fn(() => calls.push("clear")),
      runAskLoop: vi.fn(() => {
        calls.push("loop");
        return { kind: "final", text: "ok" };
      })
    });
    var api = load(env.stubs);
    expect(api.tryResumeAsk("42", 100, "May")).toBe(true);
    expect(calls).toEqual(["clear", "loop"]);
  });

  it("appends the user reply as a tool message answering the suspended ask_user call", () => {
    var env = baseStubs({
      loadAskConvo: vi.fn(() => ({
        messages: [
          { role: "user", content: "spend?" },
          { role: "assistant", tool_calls: [{ id: "call_x", function: { name: "ask_user", arguments: "{}" } }] }
        ],
        askCallId: "call_x",
        turn: 1
      })),
      runAskLoop: vi.fn(() => ({ kind: "final", text: "got it" }))
    });
    var api = load(env.stubs);
    api.tryResumeAsk("42", 100, "May 2026");

    var [question, , opts] = env.stubs.runAskLoop.mock.calls[0];
    expect(question).toBeNull(); // resume mode — no fresh question
    expect(opts.turn).toBe(2);
    var lastMsg = opts.messages[opts.messages.length - 1];
    expect(lastMsg).toEqual({ role: "tool", tool_call_id: "call_x", content: "May 2026" });
  });
});

// ── handleHelpCommand ───────────────────────────────────────────────────────

describe("handleHelpCommand", () => {
  it("posts the commands list with a Sheet + README button row", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.handleHelpCommand("1", "alice");

    expect(env.sent[0].text).toMatch(/\/ask/);
    expect(env.sent[0].text).toMatch(/\/stats/);
    var btns = env.sent[0].opts.reply_markup.inline_keyboard[0];
    expect(btns.find((b) => /Open Sheet/.test(b.text)).url).toBe("https://sheets/sheet-xyz");
    expect(btns.find((b) => /README/.test(b.text)).url).toMatch(/github\.com/);
  });
});

// ── buildKeyboardForRow ────────────────────────────────────────────────────

describe("buildKeyboardForRow", () => {
  it("post-split rows (GROUP_REF present) → undo keyboard", () => {
    var env = baseStubs({
      buildPostSplitDMKeyboard: vi.fn(() => ({ kind: "post-split" })),
      buildTransactionLevel0Keyboard: vi.fn(() => ({ kind: "level-0" }))
    });
    var api = load(env.stubs);
    var kb = api.buildKeyboardForRow("1", "msg-X", "Swiggy", "Food", "g1");
    expect(kb).toEqual({ kind: "post-split" });
    expect(env.stubs.buildTransactionLevel0Keyboard).not.toHaveBeenCalled();
  });

  it("regular personal rows (no GROUP_REF) → Level 0 keyboard", () => {
    var env = baseStubs({
      buildPostSplitDMKeyboard: vi.fn(() => ({ kind: "post-split" })),
      buildTransactionLevel0Keyboard: vi.fn(() => ({ kind: "level-0" }))
    });
    var api = load(env.stubs);
    var kb = api.buildKeyboardForRow("1", "msg-X", "Swiggy", "Food", "");
    expect(kb).toEqual({ kind: "level-0" });
    expect(env.stubs.buildPostSplitDMKeyboard).not.toHaveBeenCalled();
  });
});

// ── handleBackfillCommand (Backfill.js owns the implementation now; this
//    confirms BotHandlers.js no longer carries its own duplicate). ─────────

describe("handleBackfillCommand (post-dedup)", () => {
  it("is no longer defined in BotHandlers.js — Backfill.js owns it now", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.handleBackfillCommand).toBeUndefined();
  });
});
