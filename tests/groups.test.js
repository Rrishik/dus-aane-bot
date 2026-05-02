import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "admin-sheet";

// Minimal harness: load Groups.js + TenantRegistry.js + TelegramUtils helpers
// stubbed. We don't exercise the full /start orchestration here (it touches
// Drive + Telegram); we test the pure helpers that drive its decisions, plus
// a focused integration test of the bot-not-admin reject path.

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
  return { SpreadsheetApp, ss };
}

// Constants.js isn't loaded by these tests (it uses top-level template literals
// that depend on BOT_TOKEN already being a global). Stub the BOT_*_URL constants
// our handlers reference so TelegramUtils.js can build payloads.
function urlStubs() {
  return {
    BOT_TOKEN: "test",
    BOT_SEND_MESSAGE_URL: "https://api.telegram.test/bot/sendMessage",
    BOT_EDIT_MESSAGE_URL: "https://api.telegram.test/bot/editMessageText",
    BOT_DELETE_MESSAGE_URL: "https://api.telegram.test/bot/deleteMessage",
    BOT_ANSWER_CALLBACK_QUERY_URL: "https://api.telegram.test/bot/answerCallbackQuery",
    BOT_GET_CHAT_URL: "https://api.telegram.test/bot/getChat",
    BOT_GET_CHAT_ADMINISTRATORS_URL: "https://api.telegram.test/bot/getChatAdministrators",
    BOT_GET_ME_URL: "https://api.telegram.test/bot/getMe",
    BOT_SET_WEBHOOK_URL: "https://api.telegram.test/bot/setWebhook",
    BOT_DELETE_WEBHOOK_URL: "https://api.telegram.test/bot/deleteWebhook",
    BOT_SET_COMMANDS_URL: "https://api.telegram.test/bot/setMyCommands",
    WORKER_PROXY_URL: "https://example"
  };
}

describe("classifyGroupAdmins", () => {
  function load() {
    return loadAppsScript(["Groups.js"], ["classifyGroupAdmins"], {});
  }

  it("excludes the bot itself, marks botPresent=true", () => {
    var { classifyGroupAdmins } = load();
    var admins = [
      { user: { id: 999, is_bot: true, first_name: "DusAaneBot" } }, // self
      { user: { id: 111, is_bot: false, first_name: "Alice" } }
    ];
    var out = classifyGroupAdmins(admins, "999", () => null);
    expect(out.botPresent).toBe(true);
    expect(out.unregistered.length).toBe(1);
    expect(out.unregistered[0].chat_id).toBe("111");
    expect(out.registered.length).toBe(0);
  });

  it("flags botPresent=false when bot is not in admin list", () => {
    var { classifyGroupAdmins } = load();
    var admins = [{ user: { id: 111, is_bot: false, first_name: "Alice" } }];
    var out = classifyGroupAdmins(admins, "999", () => null);
    expect(out.botPresent).toBe(false);
  });

  it("classifies registered vs unregistered via findActive", () => {
    var { classifyGroupAdmins } = load();
    var admins = [
      { user: { id: 111, is_bot: false, first_name: "Alice" } },
      { user: { id: 222, is_bot: false, first_name: "Bob" } },
      { user: { id: 999, is_bot: true } } // bot
    ];
    var registry = { 111: { chat_id: "111" } };
    var out = classifyGroupAdmins(admins, "999", (uid) => registry[uid] || null);
    expect(out.registered.map((r) => r.chat_id)).toEqual(["111"]);
    expect(out.unregistered.map((r) => r.chat_id)).toEqual(["222"]);
  });

  it("skips non-self bots", () => {
    var { classifyGroupAdmins } = load();
    var admins = [
      { user: { id: 999, is_bot: true } }, // self
      { user: { id: 888, is_bot: true, first_name: "OtherBot" } } // someone else's bot
    ];
    var out = classifyGroupAdmins(admins, "999", () => null);
    expect(out.botPresent).toBe(true);
    expect(out.registered).toEqual([]);
    expect(out.unregistered).toEqual([]);
  });

  it("falls back to username then user.id for the display name", () => {
    var { classifyGroupAdmins } = load();
    var admins = [{ user: { id: 111, is_bot: false, username: "alice42" } }, { user: { id: 222, is_bot: false } }];
    var out = classifyGroupAdmins(admins, "999", () => null);
    expect(out.unregistered[0].name).toBe("alice42");
    expect(out.unregistered[1].name).toBe("222");
  });
});

describe("formatGroupSetupMessage", () => {
  function load() {
    return loadAppsScript(["TelegramUtils.js", "Groups.js"], ["formatGroupSetupMessage"], {
      // TelegramUtils references constants/URLs we don't care about here; stubs:
      UrlFetchApp: {},
      PropertiesService: {}
    });
  }

  it("includes ready and need-to-register sections plus sheet link", () => {
    var { formatGroupSetupMessage } = load();
    var msg = formatGroupSetupMessage(
      "Bachelor Pad",
      [
        { chat_id: "111", name: "Alice" },
        { chat_id: "222", name: "Bob" }
      ],
      [{ chat_id: "333", name: "Charlie" }],
      "https://docs.google.com/spreadsheets/d/abc/edit"
    );
    expect(msg).toContain("Bachelor Pad");
    expect(msg).toContain("2 of 3");
    expect(msg).toContain("Alice");
    expect(msg).toContain("Bob");
    expect(msg).toContain("Charlie");
    expect(msg).toContain("DM me `/register`");
    expect(msg).toContain("https://docs.google.com/spreadsheets/d/abc/edit");
  });

  it("omits the need-to-register section when everyone is ready", () => {
    var { formatGroupSetupMessage } = load();
    var msg = formatGroupSetupMessage("Trip", [{ chat_id: "111", name: "Alice" }], [], "https://s");
    expect(msg).not.toContain("Need to register");
    expect(msg).toContain("1 of 1");
  });

  it("escapes Markdown-special characters in the group name and member names", () => {
    var { formatGroupSetupMessage } = load();
    var msg = formatGroupSetupMessage("Pad_Mates", [{ chat_id: "111", name: "Al*ice" }], [], "");
    // Both _ and * must be escaped (Telegram legacy Markdown)
    expect(msg).toContain("Pad\\_Mates");
    expect(msg).toContain("Al\\*ice");
  });
});

describe("handleGroupStartCommand bot-admin enforcement", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "Groups.js"],
      ["handleGroupStartCommand", "findGroupTenantByChatId", "loadTenants", "invalidateTenantCache"],
      stubs
    );
  }

  it("refuses provisioning and tells the user to promote the bot when bot is not admin", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var fakeUrlFetch = {
      fetch: vi.fn((url, opts) => {
        var payload = JSON.parse(opts.payload);
        // /getMe — bot identity
        if (url.indexOf("/getMe") !== -1) {
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({ ok: true, result: { id: 999, is_bot: true } })
          };
        }
        // /getChatAdministrators — no bot in list
        if (url.indexOf("/getChatAdministrators") !== -1) {
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                ok: true,
                result: [{ user: { id: 111, is_bot: false, first_name: "Alice" } }]
              })
          };
        }
        // /sendMessage
        if (url.indexOf("/sendMessage") !== -1) {
          sent.push(payload);
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } })
          };
        }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
      })
    };
    var props = {
      _store: {},
      getProperty(k) {
        return this._store[k] || null;
      },
      setProperty(k, v) {
        this._store[k] = String(v);
      },
      deleteProperty(k) {
        delete this._store[k];
      }
    };
    var { handleGroupStartCommand, loadTenants, invalidateTenantCache } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: fakeUrlFetch,
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => props },
      MAX_GROUP_MEMBERS: 4,
      adminProvisionGroupSheet: vi.fn(() => {
        throw new Error("should not be called when bot is not admin");
      })
    });

    handleGroupStartCommand({
      message: {
        chat: { id: -100, type: "group", title: "Bachelor Pad" },
        from: { id: 111 }
      }
    });

    invalidateTenantCache();
    expect(loadTenants()).toEqual([]); // no tenant inserted
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("Make me an admin");
  });

  it("rejects when more than MAX_GROUP_MEMBERS admins are visible", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var fakeUrlFetch = {
      fetch: vi.fn((url, opts) => {
        var payload = JSON.parse(opts.payload);
        if (url.indexOf("/getMe") !== -1) {
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({ ok: true, result: { id: 999, is_bot: true } })
          };
        }
        if (url.indexOf("/getChatAdministrators") !== -1) {
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                ok: true,
                result: [
                  { user: { id: 999, is_bot: true } }, // self
                  { user: { id: 1, is_bot: false, first_name: "A" } },
                  { user: { id: 2, is_bot: false, first_name: "B" } },
                  { user: { id: 3, is_bot: false, first_name: "C" } },
                  { user: { id: 4, is_bot: false, first_name: "D" } },
                  { user: { id: 5, is_bot: false, first_name: "E" } }
                ]
              })
          };
        }
        if (url.indexOf("/sendMessage") !== -1) {
          sent.push(payload);
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } })
          };
        }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
      })
    };
    var props = {
      _store: {},
      getProperty(k) {
        return this._store[k] || null;
      },
      setProperty(k, v) {
        this._store[k] = String(v);
      },
      deleteProperty(k) {
        delete this._store[k];
      }
    };
    var { handleGroupStartCommand, loadTenants, invalidateTenantCache } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: fakeUrlFetch,
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => props },
      MAX_GROUP_MEMBERS: 4,
      adminProvisionGroupSheet: vi.fn()
    });

    handleGroupStartCommand({
      message: {
        chat: { id: -100, type: "group", title: "Big Group" },
        from: { id: 1 }
      }
    });

    invalidateTenantCache();
    expect(loadTenants()).toEqual([]);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("Too many admins");
  });
});

describe("handleBotMembershipChange", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "TenantRegistry.js", "Groups.js"],
      ["handleBotMembershipChange", "loadTenants", "findTenantByChatId", "invalidateTenantCache"],
      stubs
    );
  }

  it("posts a welcome message when added to a fresh group", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var fakeUrlFetch = {
      fetch: vi.fn((url, opts) => {
        var payload = JSON.parse(opts.payload);
        if (url.indexOf("/sendMessage") !== -1) {
          sent.push(payload);
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } })
          };
        }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
      })
    };
    var { handleBotMembershipChange } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: fakeUrlFetch,
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) }
    });

    handleBotMembershipChange({
      my_chat_member: {
        chat: { id: -100, type: "group", title: "Bachelor Pad" },
        old_chat_member: { status: "left" },
        new_chat_member: { status: "member" }
      }
    });

    expect(sent.length).toBe(1);
    expect(sent[0].chat_id).toBe(-100);
    expect(sent[0].text).toContain("Promote me to admin");
    expect(sent[0].text).toContain("Bachelor Pad");
  });

  it("ignores transitions inside the chat (member → administrator)", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var fakeUrlFetch = {
      fetch: vi.fn((url, opts) => {
        sent.push(JSON.parse(opts.payload));
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: {} }) };
      })
    };
    var { handleBotMembershipChange } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: fakeUrlFetch,
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) }
    });

    handleBotMembershipChange({
      my_chat_member: {
        chat: { id: -100, type: "group", title: "Pad" },
        old_chat_member: { status: "member" },
        new_chat_member: { status: "administrator" }
      }
    });

    expect(sent.length).toBe(0);
  });

  it("disables the group tenant when bot is removed", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "grp-sheet", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var fakeUrlFetch = {
      fetch: vi.fn((url, opts) => {
        sent.push(JSON.parse(opts.payload));
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } })
        };
      })
    };
    var { handleBotMembershipChange, findTenantByChatId, invalidateTenantCache } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: fakeUrlFetch,
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) }
    });

    handleBotMembershipChange({
      my_chat_member: {
        chat: { id: -100, type: "group", title: "Pad" },
        old_chat_member: { status: "administrator" },
        new_chat_member: { status: "left" }
      }
    });

    invalidateTenantCache();
    expect(findTenantByChatId("-100").status).toBe("disabled");
    // Should DM the admin (chat_id=111).
    var adminDm = sent.find((s) => s.chat_id === "111" || s.chat_id === 111);
    expect(adminDm).toBeTruthy();
    expect(adminDm.text).toContain("removed");
  });

  it("ignores private chats", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var fakeUrlFetch = {
      fetch: vi.fn((url, opts) => {
        sent.push(JSON.parse(opts.payload));
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: {} }) };
      })
    };
    var { handleBotMembershipChange } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: fakeUrlFetch,
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) }
    });

    handleBotMembershipChange({
      my_chat_member: {
        chat: { id: 42, type: "private" },
        old_chat_member: { status: "member" },
        new_chat_member: { status: "kicked" }
      }
    });

    expect(sent.length).toBe(0);
  });
});
