// Integration test for the callback dispatcher in BotHandlers.js.
//
// Backstory: a UX refactor (dd37fa8) silently dropped the
//   if (isGroupCallback(data)) { handleGroupCallback(update); return; }
// shim sitting between handleCallbackQuery's "no data" check and the legacy
// "_"-split parser. Group taps like "gnav:m1:-100" fell through to the
// underscore parser, action became "gnav:m1:-100" (no underscore → -1),
// and the bot replied "❌ Error: Invalid request". Both halves had unit
// coverage (isGroupCallback, handleGroupCallback) but nothing exercised
// the seam between them. This file owns that seam.

import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "admin-sheet";

function setupRegistry(rows) {
  var SpreadsheetApp = makeSpreadsheetApp();
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var tab = ss.insertSheet("Tenants");
  tab.appendRow([
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
    "primary_currency"
  ]);
  rows.forEach(function (r) {
    tab.appendRow(r);
  });
  return SpreadsheetApp;
}

function urlStubs() {
  return {
    BOT_TOKEN: "test",
    BOT_SEND_MESSAGE_URL: "https://api.telegram.test/bot/sendMessage",
    BOT_EDIT_MESSAGE_URL: "https://api.telegram.test/bot/editMessageText",
    BOT_EDIT_REPLY_MARKUP_URL: "https://api.telegram.test/bot/editMessageReplyMarkup",
    BOT_ANSWER_CALLBACK_QUERY_URL: "https://api.telegram.test/bot/answerCallbackQuery",
    BOT_DELETE_MESSAGE_URL: "https://api.telegram.test/bot/deleteMessage",
    BOT_SEND_CHAT_ACTION_URL: "https://api.telegram.test/bot/sendChatAction"
  };
}

function makeFetch(sent) {
  return {
    fetch: vi.fn((url, opts) => {
      sent.push({ url: url, payload: JSON.parse(opts.payload) });
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } })
      };
    })
  };
}

function load(stubs) {
  return loadAppsScript(
    ["TelegramUtils.js", "TenantRegistry.js", "Analytics.js", "Groups.js", "BotHandlers.js"],
    ["handleCallbackQuery"],
    stubs
  );
}

describe("handleCallbackQuery → group-callback routing", () => {
  it("dispatches gnav:* callbacks to handleGroupCallback (renders Level 1 keyboard)", () => {
    var sent = [];
    var SpreadsheetApp = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleCallbackQuery } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} })
      }
    });

    handleCallbackQuery({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gnav:m1:-100",
        message: { chat: { id: 111 }, message_id: 42, text: "💸 INR 100 ..." }
      }
    });

    // The bug symptom: handleCallbackQuery used to reply "Invalid request"
    // because gnav:m1:-100 has no "_" for the legacy parser to split on.
    var errorReply = sent.find(
      (s) => s.url.indexOf("/sendMessage") !== -1 && s.payload.text && s.payload.text.indexOf("Invalid request") !== -1
    );
    expect(errorReply).toBeUndefined();

    // Positive proof: handleGroupCallback ran and edited the message
    // with a Level 1 split keyboard.
    var edit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    expect(edit).toBeTruthy();
    expect(edit.payload.message_id).toBe(42);
  });

  it("falls through to the legacy underscore parser for non-group data", () => {
    var sent = [];
    var SpreadsheetApp = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { handleCallbackQuery } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} })
      }
    });

    // "noseparator" has no "_" and no group prefix → must hit the "Invalid
    // request" path. Anchors the negative case so a future refactor can't
    // accidentally start treating malformed data as group callbacks.
    handleCallbackQuery({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "noseparator",
        message: { chat: { id: 111 }, message_id: 1, text: "x" }
      }
    });

    var errorReply = sent.find(
      (s) => s.url.indexOf("/sendMessage") !== -1 && s.payload.text && s.payload.text.indexOf("Invalid request") !== -1
    );
    expect(errorReply).toBeTruthy();
  });
});

// ── In-place txn-card flow ──────────────────────────────────────────────────
// Covers the keyboard-only flows wired in the ❓ overflow + picker redesign:
// editcat / cat / help / report / del / delyes / back / tag. These flows
// edit the card in place via editMessageReplyMarkup; they do NOT post new
// messages (except `tag`, which has to use force_reply, and `report`, which
// posts an admin DM).

const PERSONAL_HEADER = [
  "Email Date",
  "Transaction Date",
  "Merchant",
  "Amount",
  "Category",
  "Transaction Type",
  "User",
  "Message ID",
  "Currency",
  "Email Link",
  "Group Ref",
  "Group Message ID"
];

function setupFlowFixture(txn, extraTenants) {
  var tenants = [["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"]];
  if (extraTenants && extraTenants.length) tenants = tenants.concat(extraTenants);
  var SpreadsheetApp = setupRegistry(tenants);
  var personal = SpreadsheetApp.openById("s1").getSheets()[0];
  personal.appendRow(PERSONAL_HEADER);
  personal.appendRow([
    txn.emailDate || "2026-05-01",
    txn.txDate || "2026-05-01",
    txn.merchant || "Swiggy",
    txn.amount || 500,
    txn.category || "Food & Dining",
    txn.txType || "Debit",
    txn.user || "Alice",
    txn.messageId,
    txn.currency || "INR",
    txn.emailLink || "https://mail.google.com/x",
    txn.groupRef || "",
    txn.groupMessageId || ""
  ]);
  return { SpreadsheetApp: SpreadsheetApp, personal: personal };
}

function flowLoad(SpreadsheetApp, sent, extraStubs) {
  return loadAppsScript(
    ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "Analytics.js", "Groups.js", "BotHandlers.js"],
    ["handleCallbackQuery", "setCurrentTenant"],
    Object.assign(
      {
        ...urlStubs(),
        SpreadsheetApp: SpreadsheetApp,
        ADMIN_SHEET_ID: ADMIN_SHEET_ID,
        ADMIN_CHAT_ID: "999",
        // currencySymbol() reads this from the global namespace.
        CURRENCY_SYMBOLS: { INR: "₹" },
        // Category lists used by handleCallbackQuery → getCategoryListForType.
        CATEGORIES: ["Shopping", "Groceries", "Food & Dining", "Healthcare", "Fuel"],
        CREDIT_CATEGORIES: ["Salary", "Refund"],
        CATEGORY_EMOJIS: { Shopping: "🛍", Groceries: "🥦", "Food & Dining": "🍕" },
        UrlFetchApp: makeFetch(sent),
        Utilities: { sleep: () => {}, getUuid: () => "uuid-1" },
        PropertiesService: (function () {
          var store = {};
          return {
            getScriptProperties: () => ({
              getProperty: (k) => store[k] || null,
              setProperty: (k, v) => {
                store[k] = String(v);
              },
              deleteProperty: (k) => {
                delete store[k];
              }
            })
          };
        })(),
        // Personal sheet column constants used by BotHandlers callback paths.
        MESSAGE_ID_COLUMN: 8,
        MERCHANT_COLUMN: 3,
        AMOUNT_COLUMN: 4,
        CATEGORY_COLUMN: 5,
        TRANSACTION_TYPE_COLUMN: 6,
        EMAIL_LINK_COLUMN: 10,
        GROUP_REF_COLUMN: 11,
        GROUP_MESSAGE_ID_COLUMN: 12,
        Logger: { log: () => {} }
      },
      extraStubs || {}
    )
  );
}

describe("handleCallbackQuery → in-place txn-card flow", () => {
  function cb(data, msgId) {
    return {
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: data,
        message: { chat: { id: 111 }, message_id: msgId || 42, text: "txn body" }
      }
    };
  }

  it("editcat → swaps reply_markup to a category picker in place (no new message)", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X" });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("editcat_msg-X"));

    var sendMsg = sent.find((s) => s.url.indexOf("/sendMessage") !== -1);
    expect(sendMsg).toBeUndefined();
    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    expect(edit.payload.message_id).toBe(42);
    var kb = JSON.parse(edit.payload.reply_markup);
    // Last row is the [← Back] row.
    var backRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(backRow.length).toBe(1);
    expect(backRow[0].text).toContain("Back");
    expect(backRow[0].callback_data).toBe("back_msg-X");
  });

  it("cat pick → writes category + override and restores default keyboard in place", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X", merchant: "Swiggy", category: "Food & Dining" });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    // Pick index 0 of the debit category list → "Shopping"
    mod.handleCallbackQuery(cb("cat_msg-X_0"));

    // Row's CATEGORY column updated.
    expect(fix.personal.getRange(2, 5).getValue()).toBe("Shopping");
    // No "✅ Category updated" message — pill change is the ack.
    var ackMsg = sent.find(
      (s) => s.url.indexOf("/sendMessage") !== -1 && /Category updated/.test(s.payload.text || "")
    );
    expect(ackMsg).toBeUndefined();
    // Keyboard swapped back in place.
    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    var kb = JSON.parse(edit.payload.reply_markup);
    var pillRow = kb.inline_keyboard.find((row) => row.some((b) => /^📂/.test(b.text)));
    expect(pillRow).toBeTruthy();
    var catBtn = pillRow.find((b) => /^📂/.test(b.text));
    expect(catBtn.text).toContain("Shopping");
  });

  it("help → swaps reply_markup to the Report + Delete overflow menu", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X" });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("help_msg-X"));

    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    var kb = JSON.parse(edit.payload.reply_markup);
    var labels = kb.inline_keyboard[0].map((b) => b.text);
    expect(labels.some((t) => /Report/.test(t))).toBe(true);
    expect(labels.some((t) => /Delete/.test(t))).toBe(true);
  });

  it("del (first tap) → swaps to confirm; does NOT delete the row", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X" });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("del_msg-X"));

    // Row still there (header + the txn row = 2).
    expect(fix.personal.getLastRow()).toBe(2);
    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    var kb = JSON.parse(edit.payload.reply_markup);
    var labels = kb.inline_keyboard[0].map((b) => b.text);
    expect(labels.some((t) => /Yes/.test(t))).toBe(true);
    expect(labels.some((t) => /Cancel/.test(t))).toBe(true);
    // Yes button commits via delyes; Cancel returns via back.
    expect(kb.inline_keyboard[0].find((b) => /Yes/.test(b.text)).callback_data).toBe("delyes_msg-X");
    expect(kb.inline_keyboard[0].find((b) => /Cancel/.test(b.text)).callback_data).toBe("back_msg-X");
  });

  it("delyes → actually deletes the row and tombstones the card body", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X" });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("delyes_msg-X"));

    // Row gone (just the header remains).
    expect(fix.personal.getLastRow()).toBe(1);
    // Card body replaced via editMessageText (sendTelegramMessage with message_id).
    var edit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    expect(edit).toBeTruthy();
    expect(edit.payload.text).toContain("deleted");
  });

  it("report → DMs admin with row context and swaps card to ack keyboard", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X", merchant: "Bundl Tech", amount: 1234 });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("report_msg-X"));

    var adminDm = sent.find((s) => s.url.indexOf("/sendMessage") !== -1 && String(s.payload.chat_id) === "999");
    expect(adminDm).toBeTruthy();
    expect(adminDm.payload.text).toContain("Reported");
    expect(adminDm.payload.text).toContain("Bundl Tech");
    expect(adminDm.payload.text).toContain("1234");
    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    var kb = JSON.parse(edit.payload.reply_markup);
    expect(kb.inline_keyboard[0][0].text).toMatch(/Reported/);
  });

  it("back → rebuilds default keyboard for personal row (Level 0)", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X", merchant: "Amazon", category: "Shopping" });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("back_msg-X"));

    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    var kb = JSON.parse(edit.payload.reply_markup);
    // Personal user not in any group: just one pills+❓ row, no parent rows.
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0].map((b) => b.text)).toEqual(["🏷 Amazon ▾", "📂 Shopping ▾", "❓"]);
  });

  it("back → personal row when user has ≥1 group: prepends group parent row, ❓ rides on pills", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X", merchant: "Amazon", category: "Shopping" }, [
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("back_msg-X"));

    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    var kb = JSON.parse(edit.payload.reply_markup);
    // First row is the group parent button.
    expect(kb.inline_keyboard[0][0].text).toContain("Split with Pad");
    // No standalone action row — ❓ sits inline on the pills row to keep
    // the keyboard compact.
    var pillsRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(pillsRow.map((b) => b.text)).toEqual(["🏷 Amazon ▾", "📂 Shopping ▾", "❓"]);
  });

  it("back → rebuilds post-split keyboard when the row has a GROUP_REF", () => {
    var sent = [];
    var fix = setupFlowFixture({
      messageId: "msg-X",
      merchant: "Amazon",
      category: "Shopping",
      groupRef: "-100:tx-1",
      groupMessageId: "55"
    });
    var mod = flowLoad(fix.SpreadsheetApp, sent);
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("back_msg-X"));

    var edit = sent.find((s) => s.url.indexOf("/editMessageReplyMarkup") !== -1);
    expect(edit).toBeTruthy();
    var kb = JSON.parse(edit.payload.reply_markup);
    // First row carries the undo affordance via gun:.
    expect(kb.inline_keyboard[0][0].text).toContain("Make personal again");
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gun:msg-X");
  });

  it("tag → stashes <emailMsgId>|<tgMsgId> and prompts with force_reply", () => {
    var sent = [];
    var fix = setupFlowFixture({ messageId: "msg-X", merchant: "Swiggy" });
    // Capture script-properties writes to verify the tg msg id is stashed.
    var store = {};
    var props = {
      getScriptProperties: () => ({
        getProperty: (k) => store[k] || null,
        setProperty: (k, v) => {
          store[k] = String(v);
        },
        deleteProperty: (k) => {
          delete store[k];
        }
      })
    };
    var mod = flowLoad(fix.SpreadsheetApp, sent, { PropertiesService: props });
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleCallbackQuery(cb("tag_msg-X", 42));

    expect(store["pending_tag_111"]).toBe("msg-X|42");
    var prompt = sent.find((s) => s.url.indexOf("/sendMessage") !== -1);
    expect(prompt).toBeTruthy();
    var rm = JSON.parse(prompt.payload.reply_markup);
    expect(rm.force_reply).toBe(true);
  });
});
