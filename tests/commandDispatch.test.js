// Integration test for handleMessage → group-vs-personal command routing.
//
// Backstory: handleGroup{Start,Help,Account,Stats,Settle}Command existed and
// had unit coverage, but no production code path ever called them. Group
// chats sending /help got the personal /help (with /ask /backfill etc.) and
// /settle returned "Unknown command". This file owns the seam between
// handleMessage and the handleGroup*Command family — one positive case per
// command, plus the negative case that personal chats still get the
// personal handlers.

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
    BOT_SEND_CHAT_ACTION_URL: "https://api.telegram.test/bot/sendChatAction",
    BOT_INBOX_EMAIL: "bot@example.com",
    MAX_GROUP_MEMBERS: 4
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
    [
      "TelegramUtils.js",
      "TenantRegistry.js",
      "Analytics.js",
      "GoogleSheetUtils.js",
      "Onboarding.js",
      "Groups.js",
      "BotHandlers.js"
    ],
    ["handleMessage"],
    stubs
  );
}

function groupUpdate(chatId, text, fromId) {
  return {
    message: {
      chat: { id: chatId, type: "group", title: "Padosi" },
      from: { id: fromId || chatId, first_name: "Alice", username: "alice" },
      text: text
    }
  };
}

function personalUpdate(chatId, text) {
  return {
    message: {
      chat: { id: chatId, type: "private" },
      from: { id: chatId, first_name: "Alice", username: "alice" },
      text: text
    }
  };
}

describe("handleMessage → group command routing", () => {
  it("/help in a group renders the *Group commands* body (not the personal /help)", () => {
    var sent = [];
    var SpreadsheetApp = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Padosi", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleMessage } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} })
      }
    });

    handleMessage(groupUpdate(-100, "/help"));

    var msg = sent.find((s) => s.url.indexOf("/sendMessage") !== -1);
    expect(msg).toBeTruthy();
    expect(msg.payload.chat_id).toBe(-100);
    // Group help body is anchored on this header. The personal help body
    // does NOT contain this string.
    expect(msg.payload.text).toMatch(/Group commands/);
    // And mentions /settle, which is group-only.
    expect(msg.payload.text).toMatch(/\/settle/);
  });

  it("/account in a group calls handleGroupAccountCommand (status reply, not personal account view)", () => {
    var sent = [];
    var SpreadsheetApp = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Padosi", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleMessage } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} })
      }
    });

    handleMessage(groupUpdate(-100, "/account"));

    var msgs = sent.filter((s) => s.url.indexOf("/sendMessage") !== -1 && s.payload.chat_id === -100);
    expect(msgs.length).toBeGreaterThan(0);
    // Group /account leads with the group title; personal /account would
    // emit "Account" / email registration text instead.
    var anyHasTitle = msgs.some((m) => /Padosi/.test(m.payload.text || ""));
    expect(anyHasTitle).toBe(true);
  });

  it("/settle in a group reaches handleGroupSettleCommand (validates args, doesn't say 'Unknown command')", () => {
    var sent = [];
    var SpreadsheetApp = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Padosi", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleMessage } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} })
      }
    });

    // Bare `/settle` triggers the handler's usage-help branch — proves the
    // routing got there. Full settlement happy-path is covered in groups.test.js.
    handleMessage(groupUpdate(-100, "/settle", 111));

    var msgs = sent.filter((s) => s.url.indexOf("/sendMessage") !== -1);
    var unknown = msgs.find((m) => /Unknown command/i.test(m.payload.text || ""));
    expect(unknown).toBeUndefined();
    var usage = msgs.find((m) => /\/settle/.test(m.payload.text || ""));
    expect(usage).toBeTruthy();
  });

  it("/ask in a group is silently ignored (personal-only, no spam in group)", () => {
    var sent = [];
    var SpreadsheetApp = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Padosi", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleMessage } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} })
      }
    });

    handleMessage(groupUpdate(-100, "/ask how much on food?"));

    // No reply at all — group chats shouldn't get "Unknown command" noise
    // for personal-only commands (other bots in the same group might own
    // /ask, /backfill, etc.).
    expect(sent.length).toBe(0);
  });

  it("/help in a personal chat still renders the personal help (regression guard)", () => {
    var sent = [];
    var SpreadsheetApp = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { handleMessage } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} })
      }
    });

    handleMessage(personalUpdate(111, "/help"));

    var msg = sent.find((s) => s.url.indexOf("/sendMessage") !== -1);
    expect(msg).toBeTruthy();
    // Personal /help mentions /ask; group /help does not.
    expect(msg.payload.text).toMatch(/\/ask/);
    expect(msg.payload.text).not.toMatch(/Group commands/);
  });
});
