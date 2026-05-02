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

// In-memory ScriptProperties stub used by the chat_member + retro-add tests.
function makeProps(initial) {
  var store = Object.assign({}, initial || {});
  return {
    _store: store,
    getProperty(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setProperty(k, v) {
      store[k] = String(v);
    },
    deleteProperty(k) {
      delete store[k];
    }
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

describe("pending group invite stash", () => {
  function load(stubs) {
    return loadAppsScript(
      ["Groups.js"],
      ["addPendingGroupInvite", "getPendingGroupInvites", "clearPendingGroupInvites"],
      stubs
    );
  }

  it("dedupes, lists, and clears invites for a user", () => {
    var props = makeProps();
    var { addPendingGroupInvite, getPendingGroupInvites, clearPendingGroupInvites } = load({
      PropertiesService: { getScriptProperties: () => props }
    });
    expect(addPendingGroupInvite("111", "-100")).toBe(true);
    expect(addPendingGroupInvite("111", "-200")).toBe(true);
    expect(addPendingGroupInvite("111", "-100")).toBe(false); // dedup
    expect(getPendingGroupInvites("111")).toEqual(["-100", "-200"]);
    expect(getPendingGroupInvites("999")).toEqual([]);
    clearPendingGroupInvites("111");
    expect(getPendingGroupInvites("111")).toEqual([]);
  });
});

describe("handleChatMemberChange", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "TenantRegistry.js", "Groups.js"],
      [
        "handleChatMemberChange",
        "findTenantByChatId",
        "loadTenants",
        "invalidateTenantCache",
        "getPendingGroupInvites"
      ],
      stubs
    );
  }

  it("adds a registered user to group_members and posts in the group", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111", "INR"],
      ["222", "Bob", "bob@gmail.com", "b-sheet", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { handleChatMemberChange, findTenantByChatId, invalidateTenantCache } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });

    handleChatMemberChange({
      chat_member: {
        chat: { id: -100, type: "group", title: "Pad" },
        old_chat_member: { status: "left", user: { id: 222 } },
        new_chat_member: { status: "member", user: { id: 222, first_name: "Bob", is_bot: false } }
      }
    });

    invalidateTenantCache();
    expect(findTenantByChatId("-100").group_members).toEqual(["111", "222"]);
    var groupPost = sent.find((s) => s.payload.chat_id === -100);
    expect(groupPost).toBeTruthy();
    expect(groupPost.payload.text).toContain("Bob");
    expect(groupPost.payload.text).toContain("joined");
  });

  it("DMs unregistered joiner with /register prompt and stashes invite", () => {
    var sent = [];
    var props = makeProps();
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleChatMemberChange, findTenantByChatId, invalidateTenantCache, getPendingGroupInvites } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => props },
      MAX_GROUP_MEMBERS: 4
    });

    handleChatMemberChange({
      chat_member: {
        chat: { id: -100, type: "group", title: "Pad" },
        old_chat_member: { status: "left", user: { id: 333 } },
        new_chat_member: { status: "member", user: { id: 333, first_name: "Charlie", is_bot: false } }
      }
    });

    invalidateTenantCache();
    expect(findTenantByChatId("-100").group_members).toEqual(["111"]); // unchanged
    expect(getPendingGroupInvites("333")).toEqual(["-100"]);
    var dm = sent.find((s) => s.payload.chat_id === "333");
    expect(dm).toBeTruthy();
    expect(dm.payload.text).toContain("/register");
  });

  it("removes a leaving member and posts in the group", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleChatMemberChange, findTenantByChatId, invalidateTenantCache } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });

    handleChatMemberChange({
      chat_member: {
        chat: { id: -100, type: "group", title: "Pad" },
        old_chat_member: { status: "member", user: { id: 222 } },
        new_chat_member: { status: "left", user: { id: 222, first_name: "Bob", is_bot: false } }
      }
    });

    invalidateTenantCache();
    expect(findTenantByChatId("-100").group_members).toEqual(["111"]);
    var groupPost = sent.find((s) => s.payload.chat_id === -100);
    expect(groupPost).toBeTruthy();
    expect(groupPost.payload.text).toContain("left");
  });

  it("DMs admin and refuses to add when group is at member cap", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111,222,333,444", "INR"],
      ["555", "Eve", "eve@gmail.com", "e-sheet", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { handleChatMemberChange, findTenantByChatId, invalidateTenantCache } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });

    handleChatMemberChange({
      chat_member: {
        chat: { id: -100, type: "group", title: "Pad" },
        old_chat_member: { status: "left", user: { id: 555 } },
        new_chat_member: { status: "member", user: { id: 555, first_name: "Eve", is_bot: false } }
      }
    });

    invalidateTenantCache();
    expect(findTenantByChatId("-100").group_members).toEqual(["111", "222", "333", "444"]); // unchanged
    // No public group post; admin DM only.
    expect(sent.find((s) => s.payload.chat_id === -100)).toBeUndefined();
    var adminDm = sent.find((s) => s.payload.chat_id === "111");
    expect(adminDm).toBeTruthy();
    expect(adminDm.payload.text).toContain("cap");
  });

  it("ignores events for unprovisioned/disabled groups", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "disabled", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleChatMemberChange } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });

    handleChatMemberChange({
      chat_member: {
        chat: { id: -100, type: "group" },
        old_chat_member: { status: "left", user: { id: 222 } },
        new_chat_member: { status: "member", user: { id: 222, first_name: "Bob", is_bot: false } }
      }
    });

    expect(sent.length).toBe(0);
  });

  it("ignores bot self-events (handled by my_chat_member)", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleChatMemberChange } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });

    handleChatMemberChange({
      chat_member: {
        chat: { id: -100, type: "group" },
        old_chat_member: { status: "left", user: { id: 999 } },
        new_chat_member: { status: "member", user: { id: 999, first_name: "Bot", is_bot: true } }
      }
    });

    expect(sent.length).toBe(0);
  });
});

describe("consumePendingGroupInvitesForUser", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "TenantRegistry.js", "Groups.js"],
      [
        "consumePendingGroupInvitesForUser",
        "addPendingGroupInvite",
        "getPendingGroupInvites",
        "findTenantByChatId",
        "invalidateTenantCache"
      ],
      stubs
    );
  }

  it("adds the user to every active pending group, posts, and clears the stash", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "s1", "active", "", "admin=111", "", "", 0, "group", "111", "INR"],
      ["-200", "Trip", "", "s2", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var props = makeProps({ pending_group_invite_222: "-100,-200" });
    var { consumePendingGroupInvitesForUser, getPendingGroupInvites, findTenantByChatId, invalidateTenantCache } = load(
      {
        ...urlStubs(),
        SpreadsheetApp: SpreadsheetApp,
        ADMIN_SHEET_ID: ADMIN_SHEET_ID,
        UrlFetchApp: makeFetch(sent),
        Utilities: { sleep: () => {} },
        PropertiesService: { getScriptProperties: () => props },
        MAX_GROUP_MEMBERS: 4
      }
    );

    var added = consumePendingGroupInvitesForUser("222", "Bob");
    invalidateTenantCache();

    expect(added.length).toBe(2);
    expect(findTenantByChatId("-100").group_members).toEqual(["111", "222"]);
    expect(findTenantByChatId("-200").group_members).toEqual(["111", "222"]);
    expect(getPendingGroupInvites("222")).toEqual([]);
    var post1 = sent.find((s) => s.payload.chat_id === "-100" || s.payload.chat_id === -100);
    var post2 = sent.find((s) => s.payload.chat_id === "-200" || s.payload.chat_id === -200);
    expect(post1.payload.text).toContain("Bob");
    expect(post2.payload.text).toContain("Bob");
  });

  it("skips disabled groups but still clears the stash", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "s1", "disabled", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var props = makeProps({ pending_group_invite_222: "-100" });
    var { consumePendingGroupInvitesForUser, getPendingGroupInvites, findTenantByChatId, invalidateTenantCache } = load(
      {
        ...urlStubs(),
        SpreadsheetApp: SpreadsheetApp,
        ADMIN_SHEET_ID: ADMIN_SHEET_ID,
        UrlFetchApp: makeFetch(sent),
        Utilities: { sleep: () => {} },
        PropertiesService: { getScriptProperties: () => props },
        MAX_GROUP_MEMBERS: 4
      }
    );

    consumePendingGroupInvitesForUser("222", "Bob");
    invalidateTenantCache();
    expect(findTenantByChatId("-100").group_members).toEqual(["111"]); // unchanged
    expect(getPendingGroupInvites("222")).toEqual([]); // cleared
  });

  it("DMs admin and skips groups already at the cap", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "s1", "active", "", "admin=111", "", "", 0, "group", "111,222,333,444", "INR"]
    ]);
    var props = makeProps({ pending_group_invite_555: "-100" });
    var { consumePendingGroupInvitesForUser, findTenantByChatId, invalidateTenantCache } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => props },
      MAX_GROUP_MEMBERS: 4
    });

    var added = consumePendingGroupInvitesForUser("555", "Eve");
    invalidateTenantCache();
    expect(added).toEqual([]);
    expect(findTenantByChatId("-100").group_members).toEqual(["111", "222", "333", "444"]);
    var adminDm = sent.find((s) => s.payload.chat_id === "111");
    expect(adminDm).toBeTruthy();
    expect(adminDm.payload.text).toContain("cap");
  });

  it("returns empty array for users with no pending invites", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var { consumePendingGroupInvitesForUser } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });
    expect(consumePendingGroupInvitesForUser("999", "Nobody")).toEqual([]);
    expect(sent.length).toBe(0);
  });
});

describe("handleGroupHelpCommand", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "Groups.js"],
      ["handleGroupHelpCommand"],
      stubs
    );
  }

  it("posts the group help message with sheet button when group is active", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleGroupHelpCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });
    handleGroupHelpCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent.length).toBe(1);
    expect(sent[0].payload.text).toContain("Group commands");
    expect(sent[0].payload.text).toContain("/start");
    expect(sent[0].payload.text).toContain("/account");
    var mk = JSON.parse(sent[0].payload.reply_markup);
    expect(mk.inline_keyboard[0][0].text).toContain("Open group sheet");
  });

  it("nudges to /start when the group isn't provisioned", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var { handleGroupHelpCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });
    handleGroupHelpCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent.length).toBe(1);
    expect(sent[0].payload.text).toContain("isn't set up yet");
  });
});

describe("handleGroupAccountCommand", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "Groups.js"],
      ["handleGroupAccountCommand"],
      stubs
    );
  }

  it("renders name, status, currency, members, admin, and sheet link", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Bachelor Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"],
      ["111", "Alice", "alice@x", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["222", "Bob", "bob@x", "s2", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { handleGroupAccountCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });
    handleGroupAccountCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent.length).toBe(1);
    var t = sent[0].payload.text;
    expect(t).toContain("Bachelor Pad");
    expect(t).toContain("Alice");
    expect(t).toContain("Bob");
    expect(t).toContain("Members (2/4)");
    expect(t).toContain("Admin: Alice");
    expect(t).toContain("INR");
    expect(t).toContain("[open]"); // sheet link
  });

  it("falls back to chat_id label for unregistered members", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g-sheet", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { handleGroupAccountCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });
    handleGroupAccountCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent[0].payload.text).toContain("`111`"); // raw chat id when no tenant.name
  });

  it("nudges to /start when not provisioned", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([]);
    var { handleGroupAccountCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4
    });
    handleGroupAccountCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent[0].payload.text).toContain("isn't set up yet");
  });
});

describe("group callback encoder", () => {
  function load() {
    return loadAppsScript(["Groups.js"], ["encodeGroupCallback", "decodeGroupCallback", "isGroupCallback"], {});
  }

  it("round-trips action + parts", () => {
    var { encodeGroupCallback, decodeGroupCallback } = load();
    var enc = encodeGroupCallback("gsp", ["abc123", "-100", "w1"]);
    expect(enc).toBe("gsp:abc123:-100:w1");
    var dec = decodeGroupCallback(enc);
    expect(dec).toEqual({ action: "gsp", parts: ["abc123", "-100", "w1"] });
  });

  it("isGroupCallback recognizes our action codes only", () => {
    var { isGroupCallback } = load();
    expect(isGroupCallback("gnav:abc:-100")).toBe(true);
    expect(isGroupCallback("gsp:abc:-100:50")).toBe(true);
    expect(isGroupCallback("gset:abc:-100")).toBe(true);
    expect(isGroupCallback("gst:abc:-100:1")).toBe(true);
    expect(isGroupCallback("gbk:abc:-100:0")).toBe(true);
    expect(isGroupCallback("gun:abc")).toBe(true);
    // Legacy format passes through.
    expect(isGroupCallback("split_abc")).toBe(false);
    expect(isGroupCallback("stats_monthly")).toBe(false);
    expect(isGroupCallback("editcat_abc123")).toBe(false);
    expect(isGroupCallback("")).toBe(false);
    expect(isGroupCallback(null)).toBe(false);
  });

  it("worst-case callback fits Telegram's 64-byte limit", () => {
    var { encodeGroupCallback } = load();
    // Worst case in our format: gsp:<gmail-id 16 hex>:<-100xxxxxxxxxx 14>:wN
    var enc = encodeGroupCallback("gsp", ["18f7c9a2b3d4e5f6", "-1009876543210", "w3"]);
    expect(enc.length).toBeLessThanOrEqual(64);
  });
});

describe("buildGroupParentButtonRows", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TenantRegistry.js", "Groups.js"],
      ["buildGroupParentButtonRows", "invalidateTenantCache"],
      stubs
    );
  }

  it("returns empty array when user is in zero groups", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { buildGroupParentButtonRows } = load({
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID
    });
    expect(buildGroupParentButtonRows("111", "msg1")).toEqual([]);
  });

  it("emits one row per active group containing the user", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Bachelor Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"],
      ["-200", "Trip", "", "g2", "active", "", "admin=111", "", "", 0, "group", "111", "INR"],
      ["-300", "OldGroup", "", "g3", "disabled", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { buildGroupParentButtonRows } = load({
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID
    });
    var rows = buildGroupParentButtonRows("111", "msg1");
    expect(rows.length).toBe(2); // disabled OldGroup excluded
    expect(rows[0][0].text).toContain("Bachelor Pad");
    expect(rows[0][0].callback_data).toBe("gnav:msg1:-100");
    expect(rows[1][0].text).toContain("Trip");
    expect(rows[1][0].callback_data).toBe("gnav:msg1:-200");
  });

  it("excludes groups the user is not a member of", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    var { buildGroupParentButtonRows } = load({
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID
    });
    expect(buildGroupParentButtonRows("222", "msg1")).toEqual([]);
  });
});

describe("buildSplitLevel1Keyboard", () => {
  function load(stubs) {
    return loadAppsScript(["TenantRegistry.js", "Groups.js"], ["buildSplitLevel1Keyboard"], stubs);
  }

  it("2-person group: 50-50 + paid-100% buttons", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { buildSplitLevel1Keyboard } = load({ SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID });
    var group = { chat_id: "-100", group_members: ["111", "222"] };
    var kb = buildSplitLevel1Keyboard(group, "111", "m1");
    var labels = kb.inline_keyboard.map((r) => r.map((b) => b.text));
    expect(labels[0][0]).toBe("👥 50-50 with Bob");
    expect(labels[1][0]).toBe("💝 Bob paid 100%");
    expect(labels[2][0]).toBe("💸 Settlement ▾");
    expect(labels[3][0]).toBe("← Back");
    // Callback for 50-50 encodes mode "50"; back returns to level 0.
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gsp:m1:-100:50");
    expect(kb.inline_keyboard[1][0].callback_data).toBe("gsp:m1:-100:p100");
    expect(kb.inline_keyboard[3][0].callback_data).toBe("gbk:m1:-100:0");
  });

  it("3-person group: All 3 + Without X/Y buttons in CSV order", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["333", "Charlie", "", "s3", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { buildSplitLevel1Keyboard } = load({ SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID });
    var group = { chat_id: "-100", group_members: ["111", "222", "333"] };
    var kb = buildSplitLevel1Keyboard(group, "111", "m1");
    expect(kb.inline_keyboard[0][0].text).toBe("👥 All 3");
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gsp:m1:-100:all");
    var withoutRow = kb.inline_keyboard[1];
    expect(withoutRow.length).toBe(2);
    expect(withoutRow[0].text).toBe("➖ Without Bob");
    expect(withoutRow[0].callback_data).toBe("gsp:m1:-100:w1"); // idx 1 in group_members
    expect(withoutRow[1].text).toBe("➖ Without Charlie");
    expect(withoutRow[1].callback_data).toBe("gsp:m1:-100:w2");
  });

  it("4-person group: All 4 + 3 without buttons", () => {
    var { SpreadsheetApp } = setupRegistry([]);
    var { buildSplitLevel1Keyboard } = load({ SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID });
    var group = { chat_id: "-100", group_members: ["111", "222", "333", "444"] };
    var kb = buildSplitLevel1Keyboard(group, "111", "m1");
    expect(kb.inline_keyboard[0][0].text).toBe("👥 All 4");
    expect(kb.inline_keyboard[1].length).toBe(3); // 3 "without" buttons
    // No paid-100% in 3+ groups
    var allText = kb.inline_keyboard
      .flat()
      .map((b) => b.text)
      .join("|");
    expect(allText).not.toContain("paid 100%");
  });
});

describe("buildSplitLevel2Keyboard", () => {
  function load(stubs) {
    return loadAppsScript(["TenantRegistry.js", "Groups.js"], ["buildSplitLevel2Keyboard"], stubs);
  }

  it("renders one settlement target per other member + Back", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["333", "Charlie", "", "s3", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { buildSplitLevel2Keyboard } = load({ SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID });
    var group = { chat_id: "-100", group_members: ["111", "222", "333"] };
    var kb = buildSplitLevel2Keyboard(group, "111", "m1");
    expect(kb.inline_keyboard.length).toBe(3); // 2 targets + Back
    expect(kb.inline_keyboard[0][0].text).toBe("💸 To Bob");
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gst:m1:-100:1");
    expect(kb.inline_keyboard[1][0].text).toBe("💸 To Charlie");
    expect(kb.inline_keyboard[1][0].callback_data).toBe("gst:m1:-100:2");
    // Back returns to Level 1.
    expect(kb.inline_keyboard[2][0].callback_data).toBe("gbk:m1:-100:1");
  });
});

describe("handleGroupCallback dispatch", () => {
  function load(stubs) {
    return loadAppsScript(["TelegramUtils.js", "TenantRegistry.js", "Groups.js"], ["handleGroupCallback"], stubs);
  }

  it("gnav → edits message with Level 1 keyboard for a group the caller belongs to", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleGroupCallback } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() }
    });

    handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gnav:m1:-100",
        message: { chat: { id: 111 }, message_id: 42, text: "💸 INR 100 ..." }
      }
    });

    var edit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    expect(edit).toBeTruthy();
    expect(edit.payload.message_id).toBe(42);
    var kb = JSON.parse(edit.payload.reply_markup);
    expect(kb.inline_keyboard[0][0].text).toContain("50-50 with Bob");
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack).toBeTruthy();
  });

  it("gnav → rejects when caller is not a member", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["999", "Eve", "", "se", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleGroupCallback } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() }
    });

    handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 999 },
        data: "gnav:m1:-100",
        message: { chat: { id: 999 }, message_id: 42, text: "txn" }
      }
    });

    expect(sent.find((s) => s.url.indexOf("/editMessageText") !== -1)).toBeUndefined();
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("not a member");
  });

  it("gset → edits to Level 2 settlement picker", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleGroupCallback } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() }
    });

    handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gset:m1:-100",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    var edit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    var kb = JSON.parse(edit.payload.reply_markup);
    expect(kb.inline_keyboard[0][0].text).toContain("To Bob");
  });

  it("gbk:0 → restores Level 0 keyboard with parent button", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleGroupCallback } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() }
    });

    handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gbk:m1:-100:0",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    var edit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    var kb = JSON.parse(edit.payload.reply_markup);
    // First row should be the group parent button; last row legacy split/category/delete.
    expect(kb.inline_keyboard[0][0].text).toContain("Split with Pad");
    var lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(lastRow.map((b) => b.text)).toEqual(["✂️ Split", "✏️ Category", "🗑️ Delete"]);
  });

  it("gbk:1 → returns from Level 2 to Level 1", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleGroupCallback } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() }
    });

    handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gbk:m1:-100:1",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    var edit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    var kb = JSON.parse(edit.payload.reply_markup);
    expect(kb.inline_keyboard[0][0].text).toContain("50-50 with Bob");
  });

  it("gsp/gst/gun → 'Coming in step 4' toast, no edit", () => {
    var sent = [];
    var { SpreadsheetApp } = setupRegistry([
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { handleGroupCallback } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() }
    });

    ["gsp:m1:-100:50", "gst:m1:-100:1", "gun:m1"].forEach((data) => {
      handleGroupCallback({
        callback_query: {
          id: "cb",
          from: { id: 111 },
          data: data,
          message: { chat: { id: 111 }, message_id: 42, text: "txn" }
        }
      });
    });

    expect(sent.filter((s) => s.url.indexOf("/editMessageText") !== -1).length).toBe(0);
    var acks = sent.filter((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(acks.length).toBe(3);
    acks.forEach((a) => expect(a.payload.text).toContain("step 4"));
  });
});
