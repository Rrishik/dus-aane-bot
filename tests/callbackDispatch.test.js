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
