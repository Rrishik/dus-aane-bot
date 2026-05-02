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
    BOT_GET_CHAT_MEMBER_URL: "https://api.telegram.test/bot/getChatMember",
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

describe("buildTransactionLevel0Keyboard", () => {
  function load(stubs) {
    return loadAppsScript(["TenantRegistry.js", "Groups.js"], ["buildTransactionLevel0Keyboard"], stubs);
  }

  it("zero-group user keeps the legacy ✂️ Split button (their only split path)", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { buildTransactionLevel0Keyboard } = load({ SpreadsheetApp, ADMIN_SHEET_ID });
    var kb = buildTransactionLevel0Keyboard("111", "msg-X");
    expect(kb.inline_keyboard.length).toBe(1); // no group rows
    expect(kb.inline_keyboard[0].map((b) => b.text)).toEqual(["✂️ Split", "✏️ Category", "🗑️ Delete"]);
  });

  it("user in ≥1 group drops the legacy Split — group parent button is canonical", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
    ]);
    var { buildTransactionLevel0Keyboard } = load({ SpreadsheetApp, ADMIN_SHEET_ID });
    var kb = buildTransactionLevel0Keyboard("111", "msg-X");
    expect(kb.inline_keyboard[0][0].text).toContain("Split with Pad");
    var lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(lastRow.map((b) => b.text)).toEqual(["✏️ Category", "🗑️ Delete"]);
  });
});

describe("listOtherMembers", () => {
  function load(stubs) {
    return loadAppsScript(["TenantRegistry.js", "Groups.js"], ["listOtherMembers"], stubs);
  }

  it("uses tenant.name when present", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { listOtherMembers } = load({ SpreadsheetApp, ADMIN_SHEET_ID });
    var out = listOtherMembers({ chat_id: "-100", group_members: ["111", "222"] }, "111");
    expect(out).toEqual([{ chat_id: "222", label: "Bob" }]);
  });

  it("falls back to Telegram first_name when the tenant row is missing", () => {
    var { SpreadsheetApp } = setupRegistry([]);
    var calls = [];
    var { listOtherMembers } = load({
      SpreadsheetApp,
      ADMIN_SHEET_ID,
      getTelegramChatMemberName: (chat_id, uid) => {
        calls.push([chat_id, uid]);
        return uid === "222" ? "Aishwarya" : "";
      }
    });
    var out = listOtherMembers({ chat_id: "-100", group_members: ["111", "222"] }, "111");
    expect(out).toEqual([{ chat_id: "222", label: "Aishwarya" }]);
    expect(calls).toEqual([["-100", "222"]]);
  });

  it("falls back to Telegram first_name when the tenant row exists but name is empty", () => {
    var { SpreadsheetApp } = setupRegistry([["222", "", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"]]);
    var { listOtherMembers } = load({
      SpreadsheetApp,
      ADMIN_SHEET_ID,
      getTelegramChatMemberName: () => "Aishwarya"
    });
    var out = listOtherMembers({ chat_id: "-100", group_members: ["111", "222"] }, "111");
    expect(out).toEqual([{ chat_id: "222", label: "Aishwarya" }]);
  });

  it("uses raw chat_id only when both tenant lookup and Telegram fallback fail", () => {
    var { SpreadsheetApp } = setupRegistry([]);
    var { listOtherMembers } = load({
      SpreadsheetApp,
      ADMIN_SHEET_ID,
      getTelegramChatMemberName: () => ""
    });
    var out = listOtherMembers({ chat_id: "-100", group_members: ["111", "222"] }, "111");
    expect(out).toEqual([{ chat_id: "222", label: "222" }]);
  });

  it("excludes the caller and preserves CSV order for the rest", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["333", "Charlie", "", "s3", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["444", "Dave", "", "s4", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { listOtherMembers } = load({ SpreadsheetApp, ADMIN_SHEET_ID });
    var out = listOtherMembers({ chat_id: "-100", group_members: ["111", "222", "333", "444"] }, "333");
    expect(out.map((o) => o.chat_id)).toEqual(["111", "222", "444"]);
    expect(out.map((o) => o.label)).toEqual(["111", "Bob", "Dave"]);
  });
});

describe("buildSplitLevel1Keyboard", () => {
  function load(stubs) {
    return loadAppsScript(["TenantRegistry.js", "Groups.js"], ["buildSplitLevel1Keyboard"], stubs);
  }

  it("uses Telegram first_name on buttons when tenant row is missing", () => {
    var { SpreadsheetApp } = setupRegistry([]);
    var { buildSplitLevel1Keyboard } = load({
      SpreadsheetApp,
      ADMIN_SHEET_ID,
      getTelegramChatMemberName: (chat_id, uid) => (uid === "222" ? "Aishwarya" : "")
    });
    var group = { chat_id: "-100", group_members: ["111", "222"] };
    var kb = buildSplitLevel1Keyboard(group, "111", "m1");
    var labels = kb.inline_keyboard.map((r) => r.map((b) => b.text));
    expect(labels[0][0]).toBe("👥 50-50 with Aishwarya");
    expect(labels[1][0]).toBe("💝 Aishwarya owes 100%");
  });

  it("2-person group: 50-50 + paid-100% buttons", () => {
    var { SpreadsheetApp } = setupRegistry([
      ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var { buildSplitLevel1Keyboard } = load({ SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID });
    var group = { chat_id: "-100", group_members: ["111", "222"] };
    var kb = buildSplitLevel1Keyboard(group, "111", "m1");
    var labels = kb.inline_keyboard.map((r) => r.map((b) => b.text));
    expect(labels[0][0]).toBe("👥 50-50 with Bob");
    expect(labels[1][0]).toBe("💝 Bob owes 100%");
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

  it("4-person group: All 4 + 3 'Without X' + 3 'With X' buttons", () => {
    var { SpreadsheetApp } = setupRegistry([]);
    var { buildSplitLevel1Keyboard } = load({ SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID });
    var group = { chat_id: "-100", group_members: ["111", "222", "333", "444"] };
    var kb = buildSplitLevel1Keyboard(group, "111", "m1");
    expect(kb.inline_keyboard[0][0].text).toBe("👥 All 4");
    expect(kb.inline_keyboard[1].length).toBe(3); // "Without" row
    expect(kb.inline_keyboard[1][0].text).toBe("➖ Without 222");
    expect(kb.inline_keyboard[1][0].callback_data).toBe("gsp:m1:-100:w1");
    expect(kb.inline_keyboard[2].length).toBe(3); // "With" row (2-person sub-splits)
    expect(kb.inline_keyboard[2][0].text).toBe("👥 With 222");
    expect(kb.inline_keyboard[2][0].callback_data).toBe("gsp:m1:-100:i1");
    expect(kb.inline_keyboard[2][2].callback_data).toBe("gsp:m1:-100:i3");
    // No paid-100% in 3+ groups
    var allText = kb.inline_keyboard
      .flat()
      .map((b) => b.text)
      .join("|");
    expect(allText).not.toContain("owes 100%");
  });

  it("3-person group does NOT add a 'With X' row (Without X already covers 2-person subsets)", () => {
    var { SpreadsheetApp } = setupRegistry([]);
    var { buildSplitLevel1Keyboard } = load({ SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID });
    var group = { chat_id: "-100", group_members: ["111", "222", "333"] };
    var kb = buildSplitLevel1Keyboard(group, "111", "m1");
    var allText = kb.inline_keyboard
      .flat()
      .map((b) => b.text)
      .join("|");
    expect(allText).not.toContain("👥 With");
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
    // First row should be the group parent button; last row is the action
    // row. Legacy ✂️ Split is dropped when the user has at least one group.
    expect(kb.inline_keyboard[0][0].text).toContain("Split with Pad");
    var lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(lastRow.map((b) => b.text)).toEqual(["✏️ Category", "🗑️ Delete"]);
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
});

describe("computeSplitShareSet", () => {
  function load() {
    return loadAppsScript(["Groups.js"], ["computeSplitShareSet"], {});
  }

  it("50/50 splits a 2-person group across both members", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222"] };
    var out = computeSplitShareSet(group, "111", "50", 100);
    expect(out.holders).toEqual(["111", "222"]);
    expect(out.shares).toEqual([50, 50]);
  });

  it("p100 (partner owes 100%) only includes the other member", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222"] };
    var out = computeSplitShareSet(group, "111", "p100", 100);
    expect(out.holders).toEqual(["222"]);
    expect(out.shares).toEqual([100]);
  });

  it("p100 is rejected for groups with more than 2 members", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333"] };
    expect(computeSplitShareSet(group, "111", "p100", 100)).toBeNull();
  });

  it("'all' splits across every member preserving CSV order", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333"] };
    var out = computeSplitShareSet(group, "111", "all", 99);
    expect(out.holders).toEqual(["111", "222", "333"]);
    expect(out.shares).toEqual([33, 33, 33]);
  });

  it("'all' absorbs rounding remainder in shares[0] so the sum equals total", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333"] };
    var out = computeSplitShareSet(group, "111", "all", 100);
    // 100 / 3 = 33.33 each → residual 0.01 lands on holders[0]
    expect(out.shares[0]).toBe(33.34);
    expect(out.shares[1]).toBe(33.33);
    expect(out.shares[2]).toBe(33.33);
    expect(out.shares[0] + out.shares[1] + out.shares[2]).toBeCloseTo(100, 5);
  });

  it("'wK' excludes the member at CSV index K", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333", "444"] };
    var out = computeSplitShareSet(group, "111", "w2", 90); // exclude "333"
    expect(out.holders).toEqual(["111", "222", "444"]);
    expect(out.shares).toEqual([30, 30, 30]);
  });

  it("'wK' rejects when the excluded index is the caller (would leave them out of their own debt)", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333"] };
    expect(computeSplitShareSet(group, "111", "w0", 90)).toBeNull();
  });

  it("'iK' splits between caller and only group_members[K] (4-person 2-way sub-split)", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333", "444"] };
    var out = computeSplitShareSet(group, "111", "i2", 100); // caller + "333"
    expect(out.holders).toEqual(["111", "333"]);
    expect(out.shares).toEqual([50, 50]);
  });

  it("'iK' rejects when K points at the caller (no-op)", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333", "444"] };
    expect(computeSplitShareSet(group, "111", "i0", 100)).toBeNull();
  });

  it("rejects unknown modes and out-of-range indices", () => {
    var { computeSplitShareSet } = load();
    var group = { group_members: ["111", "222", "333"] };
    expect(computeSplitShareSet(group, "111", "wQ", 100)).toBeNull();
    expect(computeSplitShareSet(group, "111", "w99", 100)).toBeNull();
    expect(computeSplitShareSet(group, "111", "garbage", 100)).toBeNull();
    expect(computeSplitShareSet(group, "111", "50", "not-a-number")).toBeNull();
  });
});

describe("formatGroupSplitNotification", () => {
  function load() {
    return loadAppsScript(["TelegramUtils.js", "Groups.js"], ["formatGroupSplitNotification"], {
      // TelegramUtils references Telegram URL constants we don't exercise here.
      UrlFetchApp: {},
      PropertiesService: {}
    });
  }

  it("renders payer, holders with per-share amounts, and category", () => {
    var { formatGroupSplitNotification } = load();
    var msg = formatGroupSplitNotification({
      merchant: "Swiggy",
      amount: 600,
      currency: "INR",
      category: "Food",
      payerChatId: "111",
      payerName: "Alice",
      holders: ["111", "222", "333"],
      shares: [200, 200, 200],
      nameOf: function (id) {
        return { 111: "Alice", 222: "Bob", 333: "Charlie" }[id] || id;
      }
    });
    expect(msg).toContain("Swiggy");
    expect(msg).toContain("INR 600");
    expect(msg).toContain("Paid by Alice");
    expect(msg).toContain("Alice (INR 200)");
    expect(msg).toContain("Bob (INR 200)");
    expect(msg).toContain("Charlie (INR 200)");
    expect(msg).toContain("Food");
  });

  it("escapes Markdown-special characters in merchant and member names", () => {
    var { formatGroupSplitNotification } = load();
    var msg = formatGroupSplitNotification({
      merchant: "Some_Place",
      amount: 100,
      currency: "INR",
      payerChatId: "111",
      payerName: "Al*ice",
      holders: ["222"],
      shares: [100],
      nameOf: function () {
        return "B_ob";
      }
    });
    expect(msg).toContain("Some\\_Place");
    expect(msg).toContain("Al\\*ice");
    expect(msg).toContain("B\\_ob");
  });

  it("omits the category line when no category is supplied", () => {
    var { formatGroupSplitNotification } = load();
    var msg = formatGroupSplitNotification({
      merchant: "X",
      amount: 50,
      currency: "INR",
      payerName: "A",
      holders: ["222"],
      shares: [50],
      nameOf: function () {
        return "B";
      }
    });
    expect(msg).not.toContain("📂");
  });
});

// Personal-sheet column constants used by executeGroupSplit. Mirrors Constants.js
// (which isn't loadable in this sandbox because it depends on BOT_TOKEN).
var PERSONAL_COL_STUBS = {
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
  GROUP_MESSAGE_ID_COLUMN: 13,
  G_TX_ID_COLUMN: 9
};

// Build a SpreadsheetApp mock with: admin Tenants tab + one personal sheet
// for the caller (sheet id "s1") seeded with one transaction row + an empty
// group sheet (sheet id "g1"). Returns the mock and direct handles.
function setupSplitFixture(tenantRows, txn) {
  var SpreadsheetApp = makeSpreadsheetApp();
  // Admin Tenants tab.
  var adminSs = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var tab = adminSs.insertSheet("Tenants");
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
  tenantRows.forEach(function (r) {
    tab.appendRow(r);
  });
  // Personal sheet for caller.
  var personalSs = SpreadsheetApp.openById("s1");
  var personalSheet = personalSs.getSheets()[0];
  personalSheet.appendRow([
    "Email Date",
    "Transaction Date",
    "Merchant",
    "Amount",
    "Category",
    "Transaction Type",
    "User",
    "Split",
    "Message ID",
    "Currency",
    "Email Link",
    "Group Ref",
    "Group Message ID"
  ]);
  personalSheet.appendRow([
    txn.emailDate || "2026-05-01",
    txn.txDate || "2026-05-01",
    txn.merchant || "Swiggy",
    txn.amount,
    txn.category || "Food",
    txn.txType || "Debit",
    txn.user || "Alice",
    txn.split || "Personal",
    txn.messageId,
    txn.currency || "INR",
    txn.emailLink || "https://mail.google.com/x",
    txn.groupRef || "",
    txn.groupMessageId || ""
  ]);
  // Group sheet (for the appendRow targets). Pre-create so openGroupSheet works.
  SpreadsheetApp.openById("g1");
  return { SpreadsheetApp: SpreadsheetApp, personalSheet: personalSheet };
}

describe("handleGroupCallback gsp execution", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "GroupSheet.js", "Groups.js"],
      ["handleGroupCallback", "setCurrentTenant", "findTenantByChatId"],
      stubs
    );
  }

  function makeStubs(SpreadsheetApp, sent) {
    return {
      ...urlStubs(),
      ...PERSONAL_COL_STUBS,
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {}, getUuid: () => "tx-uuid-1" },
      PropertiesService: { getScriptProperties: () => makeProps() },
      Logger: { log: () => {} }
    };
  }

  it("happy path: writes N share rows, posts notification, stamps personal row, swaps DM keyboard", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 600 }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gsp:msg-X:-100:50",
        message: { chat: { id: 111 }, message_id: 42, text: "💸 INR 600 Debited\n🏪 Merchant: Swiggy" }
      }
    });

    // Group sheet got 2 rows (50/50 → both members are share holders).
    var groupSheet = fix.SpreadsheetApp.openById("g1").getSheets()[0];
    expect(groupSheet.getLastRow()).toBe(2);
    var r1 = groupSheet.getRange(1, 1, 1, 13).getValues()[0];
    expect(r1[2]).toBe("Swiggy"); // merchant
    expect(r1[3]).toBe(600); // amount
    expect(r1[5]).toBe("111"); // paid by
    expect([r1[6], groupSheet.getRange(2, 7).getValue()].sort()).toEqual(["111", "222"]); // share holders
    expect(r1[7]).toBe(300); // share amount
    expect(r1[8]).toBe("tx-uuid-1"); // tx id
    expect(r1[11]).toBe("1"); // group msg id (from makeFetch stub)

    // Personal row was stamped with group ref + group message id.
    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_REF_COLUMN).getValue()).toBe("-100:tx-uuid-1");
    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_MESSAGE_ID_COLUMN).getValue()).toBe("1");

    // Group chat received the notification.
    var groupSend = sent.find((s) => s.url.indexOf("/sendMessage") !== -1 && s.payload.chat_id === "-100");
    expect(groupSend).toBeTruthy();
    expect(groupSend.payload.text).toContain("Swiggy");
    expect(groupSend.payload.text).toContain("Paid by Alice");
    expect(groupSend.payload.text).toContain("Bob");

    // DM keyboard was swapped via editMessageText.
    var dmEdit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1);
    var kb = JSON.parse(dmEdit.payload.reply_markup);
    expect(kb.inline_keyboard[0][0].text).toContain("Make personal again");
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gun:msg-X");
    expect(kb.inline_keyboard[1].map((b) => b.text)).toEqual(["✏️ Category", "🗑️ Delete"]);

    // Toast acknowledges.
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Split recorded");
  });

  it("rejects re-split when GROUP_REF is already set, makes no writes", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 600, groupRef: "-100:old-tx", groupMessageId: "99" }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gsp:msg-X:-100:50",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    expect(fix.SpreadsheetApp.openById("g1").getSheets()[0].getLastRow()).toBe(0);
    // Personal row's GROUP_REF unchanged.
    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_REF_COLUMN).getValue()).toBe("-100:old-tx");
    expect(sent.find((s) => s.url.indexOf("/editMessageText") !== -1)).toBeUndefined();
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Already split");
  });

  it("rejects when caller is not a member of the group", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["999", "Eve", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 600 }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "999", sheet_id: "s1", name: "Eve", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 999 },
        data: "gsp:msg-X:-100:50",
        message: { chat: { id: 999 }, message_id: 42, text: "txn" }
      }
    });

    expect(fix.SpreadsheetApp.openById("g1").getSheets()[0].getLastRow()).toBe(0);
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("not a member");
  });

  it("3-person 'all' split writes 3 rows with rounding remainder absorbed in shares[0]", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["333", "Charlie", "", "s3", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222,333", "INR"]
      ],
      { messageId: "msg-X", amount: 100 }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gsp:msg-X:-100:all",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    var groupSheet = fix.SpreadsheetApp.openById("g1").getSheets()[0];
    expect(groupSheet.getLastRow()).toBe(3);
    var shares = [
      groupSheet.getRange(1, 8).getValue(),
      groupSheet.getRange(2, 8).getValue(),
      groupSheet.getRange(3, 8).getValue()
    ];
    expect(shares[0]).toBe(33.34); // residual
    expect(shares[1]).toBe(33.33);
    expect(shares[2]).toBe(33.33);
  });

  it("p100 in 2-person group writes a single share row charging the partner", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 600 }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gsp:msg-X:-100:p100",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    var groupSheet = fix.SpreadsheetApp.openById("g1").getSheets()[0];
    expect(groupSheet.getLastRow()).toBe(1);
    var row = groupSheet.getRange(1, 1, 1, 13).getValues()[0];
    expect(row[5]).toBe("111"); // paid by
    expect(row[6]).toBe("222"); // share holder = the partner
    expect(row[7]).toBe(600); // share amount = full
  });
});

// Seed N share rows on the group sheet for an existing Tx ID. Used by undo tests.
function seedGroupShareRows(SpreadsheetApp, sheetId, txId, holders, sharePerHolder) {
  var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
  // Header (matches GROUP_SHEET_HEADERS — only really need col 9 = Tx ID for
  // the undo logic, but appending full rows mirrors what gsp wrote).
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "Email Date",
      "Transaction Date",
      "Merchant",
      "Amount",
      "Currency",
      "Paid By",
      "Share Holder",
      "Share Amount",
      "Tx ID",
      "Category",
      "Transaction Type",
      "Message ID",
      "Email Link"
    ]);
  }
  for (var i = 0; i < holders.length; i++) {
    sheet.appendRow([
      "2026-05-01",
      "2026-05-01",
      "Swiggy",
      sharePerHolder * holders.length,
      "INR",
      "111",
      holders[i],
      sharePerHolder,
      txId,
      "Food",
      "Debit",
      "1",
      "https://mail.google.com/x"
    ]);
  }
}

describe("handleGroupCallback gun execution (undo)", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "GroupSheet.js", "Groups.js"],
      ["handleGroupCallback", "setCurrentTenant"],
      stubs
    );
  }

  function makeStubs(SpreadsheetApp, sent, fetchOverride) {
    return {
      ...urlStubs(),
      ...PERSONAL_COL_STUBS,
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: fetchOverride || makeFetch(sent),
      Utilities: { sleep: () => {}, getUuid: () => "tx-uuid-1" },
      PropertiesService: { getScriptProperties: () => makeProps() },
      Logger: { log: () => {} }
    };
  }

  it("happy path: edits group msg, deletes group rows, clears personal cells, restores DM keyboard", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 600, groupRef: "-100:tx-uuid-1", groupMessageId: "55" }
    );
    seedGroupShareRows(fix.SpreadsheetApp, "g1", "tx-uuid-1", ["111", "222"], 300);
    // Add a stray row from a different transaction — must NOT be deleted.
    seedGroupShareRows(fix.SpreadsheetApp, "g1", "tx-other", ["111", "222"], 100);

    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gun:msg-X",
        message: { chat: { id: 111 }, message_id: 42, text: "txn body" }
      }
    });

    // Group notification was edited (HTML strikethrough).
    var groupEdit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1 && s.payload.chat_id === "-100");
    expect(groupEdit).toBeTruthy();
    expect(groupEdit.payload.message_id).toBe("55");
    expect(groupEdit.payload.parse_mode).toBe("HTML");
    expect(groupEdit.payload.text).toContain("<s>");
    expect(groupEdit.payload.text).toContain("split reverted");

    // Only the matching Tx ID rows were deleted. Header (row 1) + the stray
    // tx-other rows (2 of them) survive. Original 2 share rows for tx-uuid-1
    // are gone.
    var groupSheet = fix.SpreadsheetApp.openById("g1").getSheets()[0];
    expect(groupSheet.getLastRow()).toBe(3); // 1 header + 2 stray
    var remainingTxIds = groupSheet
      .getRange(2, 9, 2, 1)
      .getValues()
      .map((r) => r[0]);
    expect(remainingTxIds).toEqual(["tx-other", "tx-other"]);

    // Personal row cells cleared.
    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_REF_COLUMN).getValue()).toBe("");
    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_MESSAGE_ID_COLUMN).getValue()).toBe("");

    // DM keyboard restored to Level 0 (parent + action row). Legacy ✂️ Split
    // is dropped because the user is in at least one group.
    var dmEdit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1 && s.payload.chat_id === 111);
    expect(dmEdit).toBeTruthy();
    var kb = JSON.parse(dmEdit.payload.reply_markup);
    expect(kb.inline_keyboard[0][0].text).toContain("Split with Pad");
    var lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(lastRow.map((b) => b.text)).toEqual(["✏️ Category", "🗑️ Delete"]);

    // Toast.
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Made personal again");
  });

  it("rejects when GROUP_REF is empty (row was never split)", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 600 } // no groupRef set
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gun:msg-X",
        message: { chat: { id: 111 }, message_id: 42, text: "txn body" }
      }
    });

    expect(sent.find((s) => s.url.indexOf("/editMessageText") !== -1)).toBeUndefined();
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Not a group split");
  });

  it("aborts when group editMessageText fails (>48h cutoff), keeps group rows and personal cells", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 600, groupRef: "-100:tx-uuid-1", groupMessageId: "55" }
    );
    seedGroupShareRows(fix.SpreadsheetApp, "g1", "tx-uuid-1", ["111", "222"], 300);

    // Custom fetch: editMessageText returns ok:false (Telegram-style 48h reject).
    var fetch = {
      fetch: vi.fn((url, opts) => {
        sent.push({ url: url, payload: JSON.parse(opts.payload) });
        if (url.indexOf("/editMessageText") !== -1) {
          return {
            getResponseCode: () => 400,
            getContentText: () => JSON.stringify({ ok: false, description: "Bad Request: message can't be edited" })
          };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } })
        };
      })
    };
    var mod = load(makeStubs(fix.SpreadsheetApp, sent, fetch));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gun:msg-X",
        message: { chat: { id: 111 }, message_id: 42, text: "txn body" }
      }
    });

    // Group rows still there (header + 2 share rows).
    var groupSheet = fix.SpreadsheetApp.openById("g1").getSheets()[0];
    expect(groupSheet.getLastRow()).toBe(3);
    // Personal row's group ref unchanged.
    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_REF_COLUMN).getValue()).toBe("-100:tx-uuid-1");
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Couldn't edit the group message");
  });

  it("clears local refs when the group tenant has been deleted from the registry", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"]
        // No -100 group row in registry.
      ],
      { messageId: "msg-X", amount: 600, groupRef: "-100:tx-uuid-1", groupMessageId: "55" }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gun:msg-X",
        message: { chat: { id: 111 }, message_id: 42, text: "txn body" }
      }
    });

    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_REF_COLUMN).getValue()).toBe("");
    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_MESSAGE_ID_COLUMN).getValue()).toBe("");
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("no longer exists");
  });
});

describe("handleGroupCallback gst execution (settlement)", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "GroupSheet.js", "Groups.js"],
      ["handleGroupCallback", "setCurrentTenant"],
      stubs
    );
  }

  function makeStubs(SpreadsheetApp, sent) {
    return {
      ...urlStubs(),
      ...PERSONAL_COL_STUBS,
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {}, getUuid: () => "tx-settle-1" },
      PropertiesService: { getScriptProperties: () => makeProps() },
      Logger: { log: () => {} }
    };
  }

  it("happy path: writes a single Settlement row, posts notification, stamps personal row, swaps keyboard", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["333", "Charlie", "", "s3", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222,333", "INR"]
      ],
      { messageId: "msg-X", amount: 500 }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    // Caller (111=Alice) settles with member at index 1 (222=Bob).
    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gst:msg-X:-100:1",
        message: { chat: { id: 111 }, message_id: 42, text: "txn body" }
      }
    });

    var groupSheet = fix.SpreadsheetApp.openById("g1").getSheets()[0];
    expect(groupSheet.getLastRow()).toBe(1); // exactly one row, no per-member fan-out
    var row = groupSheet.getRange(1, 1, 1, 13).getValues()[0];
    expect(row[5]).toBe("111"); // paid by
    expect(row[6]).toBe("222"); // share holder = settlement target
    expect(row[7]).toBe(500); // share amount = full
    expect(row[9]).toBe("Settlement"); // category
    expect(row[10]).toBe("Settlement"); // tx type

    var groupSend = sent.find((s) => s.url.indexOf("/sendMessage") !== -1 && s.payload.chat_id === "-100");
    expect(groupSend).toBeTruthy();
    expect(groupSend.payload.text).toContain("Alice");
    expect(groupSend.payload.text).toContain("settled");
    expect(groupSend.payload.text).toContain("INR 500");
    expect(groupSend.payload.text).toContain("Bob");

    expect(fix.personalSheet.getRange(2, PERSONAL_COL_STUBS.GROUP_REF_COLUMN).getValue()).toBe("-100:tx-settle-1");

    // DM keyboard same shape as gsp's post-split keyboard.
    var dmEdit = sent.find((s) => s.url.indexOf("/editMessageText") !== -1 && s.payload.chat_id === 111);
    var kb = JSON.parse(dmEdit.payload.reply_markup);
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gun:msg-X");

    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Settlement recorded");
  });

  it("rejects when target index points at the caller (can't settle with self)", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 500 }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gst:msg-X:-100:0", // index 0 = caller
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    expect(fix.SpreadsheetApp.openById("g1").getSheets()[0].getLastRow()).toBe(0);
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("yourself");
  });

  it("rejects an out-of-range target index without writing", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 500 }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gst:msg-X:-100:9",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    expect(fix.SpreadsheetApp.openById("g1").getSheets()[0].getLastRow()).toBe(0);
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Invalid settlement target");
  });

  it("rejects re-split when the row already has a GROUP_REF", () => {
    var sent = [];
    var fix = setupSplitFixture(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      { messageId: "msg-X", amount: 500, groupRef: "-100:old", groupMessageId: "55" }
    );
    var mod = load(makeStubs(fix.SpreadsheetApp, sent));
    mod.setCurrentTenant({ chat_id: "111", sheet_id: "s1", name: "Alice", status: "active" });

    mod.handleGroupCallback({
      callback_query: {
        id: "cb1",
        from: { id: 111 },
        data: "gst:msg-X:-100:1",
        message: { chat: { id: 111 }, message_id: 42, text: "txn" }
      }
    });

    expect(fix.SpreadsheetApp.openById("g1").getSheets()[0].getLastRow()).toBe(0);
    var ack = sent.find((s) => s.url.indexOf("/answerCallbackQuery") !== -1);
    expect(ack.payload.text).toContain("Already split");
  });
});

describe("aggregatePairwiseDebts", () => {
  function load() {
    return loadAppsScript(
      ["Groups.js"],
      ["aggregatePairwiseDebts"],
      // β-row column indices match the production constants.
      {
        G_CURRENCY_COLUMN: 5,
        G_PAID_BY_COLUMN: 6,
        G_SHARE_HOLDER_COLUMN: 7,
        G_SHARE_AMOUNT_COLUMN: 8,
        G_TX_ID_COLUMN: 9,
        G_CATEGORY_COLUMN: 10
      }
    );
  }
  // Build a 13-col β row. Only the columns the helper reads are populated.
  function row(currency, payer, holder, share, category) {
    return ["", "", "", "", currency, payer, holder, share, "tx", category || "Food", "Debit", "msg", "link"];
  }

  it("empty input → empty object", () => {
    var { aggregatePairwiseDebts } = load();
    expect(aggregatePairwiseDebts([])).toEqual({});
  });

  it("self-share rows (holder === payer) are ignored", () => {
    var { aggregatePairwiseDebts } = load();
    // 50/50 split: both members are share holders, but the payer's own share is not a debt.
    var rows = [row("INR", "111", "111", 300), row("INR", "111", "222", 300)];
    expect(aggregatePairwiseDebts(rows)).toEqual({
      INR: [{ debtor: "222", creditor: "111", amount: 300 }]
    });
  });

  it("nets opposing splits between the same pair", () => {
    var { aggregatePairwiseDebts } = load();
    // Alice paid 300 for Bob; later Bob paid 100 for Alice. Net: Bob owes Alice 200.
    var rows = [row("INR", "111", "222", 300), row("INR", "222", "111", 100)];
    expect(aggregatePairwiseDebts(rows)).toEqual({
      INR: [{ debtor: "222", creditor: "111", amount: 200 }]
    });
  });

  it("settlement rows reduce what payer owes recipient", () => {
    var { aggregatePairwiseDebts } = load();
    // Alice paid 500 for Bob, then Bob settled 200 to Alice. Net: Bob owes Alice 300.
    var rows = [
      row("INR", "111", "222", 500), //
      row("INR", "222", "111", 200, "Settlement")
    ];
    expect(aggregatePairwiseDebts(rows)).toEqual({
      INR: [{ debtor: "222", creditor: "111", amount: 300 }]
    });
  });

  it("settlement that fully cancels the debt drops the pair", () => {
    var { aggregatePairwiseDebts } = load();
    var rows = [row("INR", "111", "222", 500), row("INR", "222", "111", 500, "Settlement")];
    expect(aggregatePairwiseDebts(rows)).toEqual({});
  });

  it("groups debts by currency", () => {
    var { aggregatePairwiseDebts } = load();
    var rows = [row("INR", "111", "222", 300), row("USD", "222", "111", 50)];
    var out = aggregatePairwiseDebts(rows);
    expect(out.INR).toEqual([{ debtor: "222", creditor: "111", amount: 300 }]);
    expect(out.USD).toEqual([{ debtor: "111", creditor: "222", amount: 50 }]);
  });

  it("orders entries by amount descending then debtor/creditor", () => {
    var { aggregatePairwiseDebts } = load();
    var rows = [
      row("INR", "111", "222", 100), // 222 owes 111: 100
      row("INR", "111", "333", 500), // 333 owes 111: 500
      row("INR", "222", "333", 200) // 333 owes 222: 200
    ];
    var out = aggregatePairwiseDebts(rows);
    expect(out.INR.map((e) => e.debtor + "→" + e.creditor + ":" + e.amount)).toEqual([
      "333→111:500",
      "333→222:200",
      "222→111:100"
    ]);
  });

  it("ignores rows missing payer/holder/amount/currency", () => {
    var { aggregatePairwiseDebts } = load();
    var rows = [
      row("", "111", "222", 300), // no currency
      row("INR", "", "222", 300), // no payer
      row("INR", "111", "", 300), // no holder
      row("INR", "111", "222", 0), // zero amount
      row("INR", "111", "222", "abc"), // non-numeric
      row("INR", "111", "222", 300) // valid
    ];
    expect(aggregatePairwiseDebts(rows)).toEqual({
      INR: [{ debtor: "222", creditor: "111", amount: 300 }]
    });
  });
});

describe("formatGroupStats", () => {
  function load() {
    return loadAppsScript(["TelegramUtils.js", "Groups.js"], ["formatGroupStats"], {});
  }

  it("renders 'all settled up' when no balances remain", () => {
    var { formatGroupStats } = load();
    var text = formatGroupStats({}, () => "x", "Pad");
    expect(text).toContain("Pad");
    expect(text).toContain("All settled up");
  });

  it("renders one section per currency with name resolution", () => {
    var { formatGroupStats } = load();
    var nameOf = (id) => ({ 111: "Alice", 222: "Bob" })[id] || id;
    var text = formatGroupStats(
      {
        INR: [{ debtor: "222", creditor: "111", amount: 1234.5 }],
        USD: [{ debtor: "111", creditor: "222", amount: 50 }]
      },
      nameOf,
      "Pad"
    );
    expect(text).toContain("*INR*");
    expect(text).toContain("Bob owes Alice INR 1234.50");
    expect(text).toContain("*USD*");
    expect(text).toContain("Alice owes Bob USD 50.00");
  });
});

describe("handleGroupStatsCommand", () => {
  function load(stubs) {
    return loadAppsScript(
      ["TelegramUtils.js", "GoogleSheetUtils.js", "TenantRegistry.js", "GroupSheet.js", "Groups.js"],
      ["handleGroupStatsCommand"],
      stubs
    );
  }

  function setup(tenantRows, groupRows) {
    var SpreadsheetApp = makeSpreadsheetApp();
    var adminSs = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var tab = adminSs.insertSheet("Tenants");
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
    tenantRows.forEach((r) => tab.appendRow(r));
    var grp = SpreadsheetApp.openById("g1").getSheets()[0];
    // Header row matches G_COL_COUNT=13.
    grp.appendRow([
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
      "Message ID",
      "Email Link"
    ]);
    (groupRows || []).forEach((r) => grp.appendRow(r));
    return SpreadsheetApp;
  }

  it("posts the netted summary in the group", () => {
    var sent = [];
    var SpreadsheetApp = setup(
      [
        ["111", "Alice", "", "s1", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["222", "Bob", "", "s2", "active", "", "", "", "", 0, "personal", "", "INR"],
        ["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]
      ],
      [
        // Alice paid 600, 50/50 → Bob owes Alice 300.
        ["d", "d", "Swiggy", 600, "INR", "111", "111", 300, "tx1", "Food", "Debit", "1", ""],
        ["d", "d", "Swiggy", 600, "INR", "111", "222", 300, "tx1", "Food", "Debit", "1", ""],
        // Bob settled 100. Net: Bob owes Alice 200.
        ["d", "d", "UPI", 100, "INR", "222", "111", 100, "tx2", "Settlement", "Settlement", "2", ""]
      ]
    );
    var { handleGroupStatsCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4,
      G_CURRENCY_COLUMN: 5,
      G_PAID_BY_COLUMN: 6,
      G_SHARE_HOLDER_COLUMN: 7,
      G_SHARE_AMOUNT_COLUMN: 8,
      G_TX_ID_COLUMN: 9,
      G_CATEGORY_COLUMN: 10,
      G_COL_COUNT: 13
    });
    handleGroupStatsCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent.length).toBe(1);
    expect(sent[0].payload.chat_id).toBe(-100);
    expect(sent[0].payload.text).toContain("Bob owes Alice INR 200.00");
    expect(sent[0].payload.text).toContain("*Pad*");
  });

  it("posts 'all settled up' when no balances remain", () => {
    var sent = [];
    var SpreadsheetApp = setup(
      [["-100", "Pad", "", "g1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]],
      [] // empty group sheet
    );
    var { handleGroupStatsCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4,
      G_CURRENCY_COLUMN: 5,
      G_PAID_BY_COLUMN: 6,
      G_SHARE_HOLDER_COLUMN: 7,
      G_SHARE_AMOUNT_COLUMN: 8,
      G_TX_ID_COLUMN: 9,
      G_CATEGORY_COLUMN: 10,
      G_COL_COUNT: 13
    });
    handleGroupStatsCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent[0].payload.text).toContain("All settled up");
  });

  it("nudges to /start when the group isn't provisioned", () => {
    var sent = [];
    var SpreadsheetApp = setup([], []);
    var { handleGroupStatsCommand } = load({
      ...urlStubs(),
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      UrlFetchApp: makeFetch(sent),
      Utilities: { sleep: () => {} },
      PropertiesService: { getScriptProperties: () => makeProps() },
      MAX_GROUP_MEMBERS: 4,
      G_CURRENCY_COLUMN: 5,
      G_PAID_BY_COLUMN: 6,
      G_SHARE_HOLDER_COLUMN: 7,
      G_SHARE_AMOUNT_COLUMN: 8,
      G_TX_ID_COLUMN: 9,
      G_CATEGORY_COLUMN: 10,
      G_COL_COUNT: 13
    });
    handleGroupStatsCommand({ message: { chat: { id: -100, type: "group" } } });
    expect(sent[0].payload.text).toContain("isn't set up yet");
  });
});
