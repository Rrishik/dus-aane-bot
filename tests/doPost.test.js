import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

function setup(opts) {
  opts = opts || {};
  var store = {};
  var triggers = [];
  var nextUid = 1;
  var tenants = opts.tenants || {};
  var stubs = {
    WEBHOOK_SECRET: opts.secret === undefined ? "s3cret" : opts.secret,
    getWebhookSecret: () => (opts.secret === undefined ? "s3cret" : opts.secret),
    ContentService: {
      createTextOutput: (t) => ({ setMimeType: () => t }),
      MimeType: { TEXT: "text" }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => {
          store[k] = String(v);
        },
        deleteProperty: (k) => {
          delete store[k];
        }
      })
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (name) => ({
        timeBased: () => ({
          after: () => ({
            create: () => {
              var id = "uid-" + nextUid++;
              var t = { getHandlerFunction: () => name, getUniqueId: () => id };
              triggers.push(t);
              return t;
            }
          })
        })
      })
    },
    findTenantByChatId: (id) => tenants[String(id)] || null,
    setCurrentTenant: vi.fn(),
    handleCallbackQuery: vi.fn(),
    handleMessage: vi.fn(),
    handleResendSetupCallback: vi.fn(),
    answerCallbackQuery: vi.fn(),
    handleBotMembershipChange: vi.fn(),
    handleChatMemberChange: vi.fn(),
    sendTelegramMessage: vi.fn(() => JSON.stringify({ ok: true, result: { message_id: 77 } })),
    _parseSentMessageId: (raw) => JSON.parse(raw).result.message_id
  };
  var api = loadAppsScript(["Forwarding.js", "Code.js"], ["doPost", "processWebhookUpdate"], stubs);
  return { api: api, stubs: stubs, store: store, triggers: triggers };
}

function post(api, update, k) {
  return api.doPost({
    parameter: k === undefined ? { k: "s3cret" } : { k: k },
    postData: { contents: JSON.stringify(update) }
  });
}

const ACTIVE = { chat_id: "111", status: "active", chat_type: "personal" };
const msg = (text) => ({ message: { chat: { id: 111, type: "private" }, from: { id: 111 }, text: text } });
const tap = (data) => ({ callback_query: { id: "cb", data: data, message: { chat: { id: 111 }, message_id: 5 } } });

describe("doPost webhook auth", () => {
  it("drops updates without the right secret", () => {
    var t = setup({ tenants: { 111: ACTIVE } });
    post(t.api, msg("/help"), "wrong");
    post(t.api, msg("/help"), "");
    expect(t.stubs.handleMessage).not.toHaveBeenCalled();
  });

  it("processes updates with the right secret", () => {
    var t = setup({ tenants: { 111: ACTIVE } });
    post(t.api, msg("/help"));
    expect(t.stubs.handleMessage).toHaveBeenCalledTimes(1);
  });

  it("stays open when no secret is configured (rollout)", () => {
    var t = setup({ secret: "", tenants: { 111: ACTIVE } });
    post(t.api, msg("/help"), "");
    expect(t.stubs.handleMessage).toHaveBeenCalledTimes(1);
  });
});

describe("doPost routing", () => {
  it("routes resend_setup for a pending tenant (no 'please /start')", () => {
    var t = setup({ tenants: { 111: { chat_id: "111", status: "pending" } } });
    post(t.api, tap("resend_setup"));
    expect(t.stubs.handleResendSetupCallback).toHaveBeenCalledWith(111, "cb");
    expect(t.stubs.handleCallbackQuery).not.toHaveBeenCalled();
  });

  it("answers resend_setup from an unknown chat with the /start hint", () => {
    var t = setup();
    post(t.api, tap("resend_setup"));
    expect(t.stubs.handleResendSetupCallback).not.toHaveBeenCalled();
    expect(t.stubs.answerCallbackQuery.mock.calls[0][1]).toMatch(/\/start/);
  });

  it("lets dormant tenants use buttons", () => {
    var t = setup({ tenants: { 111: { chat_id: "111", status: "dormant" } } });
    post(t.api, tap("help_x"));
    expect(t.stubs.handleCallbackQuery).toHaveBeenCalledTimes(1);
    expect(t.stubs.setCurrentTenant).toHaveBeenCalled();
  });

  it("still blocks pending tenants from other buttons", () => {
    var t = setup({ tenants: { 111: { chat_id: "111", status: "pending" } } });
    post(t.api, tap("help_x"));
    expect(t.stubs.handleCallbackQuery).not.toHaveBeenCalled();
  });
});

describe("deferred /backfill", () => {
  it("stores each deferred update under its own trigger id and replays only that one", () => {
    var t = setup({ tenants: { 111: ACTIVE, 222: { chat_id: "222", status: "active" } } });
    post(t.api, msg("/backfill 1d"));
    var other = msg("/backfill 2d");
    other.message.chat.id = 222;
    post(t.api, other);

    expect(t.store["pending_update:uid-1"]).toMatch(/backfill 1d/);
    expect(t.store["pending_update:uid-2"]).toMatch(/backfill 2d/);
    expect(t.store["backfill_ack:111"]).toBe("77");

    t.api.processWebhookUpdate({ triggerUid: "uid-2" });
    expect(t.stubs.handleMessage).toHaveBeenCalledTimes(1);
    expect(t.stubs.handleMessage.mock.calls[0][0].message.text).toBe("/backfill 2d");
    expect(t.store["pending_update:uid-1"]).toBeDefined();
    expect(t.triggers.map((x) => x.getUniqueId())).toEqual(["uid-1"]);
  });
});
