import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

function setup(propsInit) {
  var store = Object.assign({}, propsInit || {});
  var sent = [];
  var SpreadsheetApp = makeSpreadsheetApp();
  var api = loadAppsScript(
    ["ParserTelemetry.js"],
    [
      "getParserMode",
      "isParserTemplateDisabled",
      "disableParserTemplate",
      "logParserEvent",
      "checkParserAutoDisable",
      "formatParserDigest",
      "parserTemplateIdFrom",
      "channelForMessageId"
    ],
    {
      ADMIN_SHEET_ID: "admin",
      ADMIN_CHAT_ID: "999",
      SpreadsheetApp: SpreadsheetApp,
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => (k in store ? store[k] : null),
          setProperty: (k, v) => {
            store[k] = String(v);
          }
        })
      },
      sendTelegramMessage: (chat, text) => sent.push({ chat: chat, text: text })
    }
  );
  var tab = () => SpreadsheetApp.openById("admin").getSheetByName("ParserEvents");
  return { api: api, store: store, sent: sent, tab: tab };
}

describe("parser rollout controls", () => {
  it("mode defaults to shadow and only accepts off/shadow/on", () => {
    expect(setup().api.getParserMode()).toBe("shadow");
    expect(setup({ "parser.mode": "on" }).api.getParserMode()).toBe("on");
    expect(setup({ "parser.mode": "yolo" }).api.getParserMode()).toBe("shadow");
  });

  it("disabled templates come from a CSV property", () => {
    var t = setup({ "parser.disabledTemplates": "a_v1, b_v1" });
    expect(t.api.isParserTemplateDisabled("b_v1")).toBe(true);
    expect(t.api.isParserTemplateDisabled("c_v1")).toBe(false);
    expect(t.api.disableParserTemplate("c_v1")).toBe(true);
    expect(t.api.disableParserTemplate("c_v1")).toBe(false);
    expect(t.store["parser.disabledTemplates"]).toBe("a_v1,b_v1,c_v1");
  });

  it("parserTemplateIdFrom strips the Re-read marker; channel comes from the id prefix", () => {
    var t = setup();
    expect(t.api.parserTemplateIdFrom("generic_v1|rr")).toBe("generic_v1");
    expect(t.api.channelForMessageId("sms-abc")).toBe("sms");
    expect(t.api.channelForMessageId("18f2a")).toBe("email");
  });
});

describe("logParserEvent", () => {
  it("appends field names only — no values or text", () => {
    var t = setup();
    t.api.logParserEvent({
      chatId: 111,
      channel: "sms",
      templateId: "tpl_v1",
      event: "reparse_accepted",
      fieldsChanged: ["amount", "transaction_date"],
      messageId: "sms-1"
    });
    var rows = t.tab().data;
    expect(rows[0]).toEqual(["time", "chat_id", "channel", "template_id", "event", "fields_changed", "message_id"]);
    expect(rows[1].slice(1)).toEqual(["111", "sms", "tpl_v1", "reparse_accepted", "amount,transaction_date", "sms-1"]);
  });

  it("never throws into the caller", () => {
    var t = setup();
    var api = loadAppsScript(["ParserTelemetry.js"], ["logParserEvent"], {
      ADMIN_SHEET_ID: "x",
      SpreadsheetApp: {
        openById: () => {
          throw new Error("sheet down");
        }
      }
    });
    expect(() => api.logParserEvent({ event: "saved" })).not.toThrow();
  });
});

describe("checkParserAutoDisable", () => {
  it("disables a template after 3 accepted Re-reads in 7 days and tells the admin", () => {
    var t = setup();
    t.api.logParserEvent({ templateId: "tpl_v1", event: "reparse_accepted" });
    t.api.logParserEvent({ templateId: "tpl_v1", event: "reparse_accepted" });
    t.api.logParserEvent({ templateId: "other_v1", event: "reparse_accepted" });
    expect(t.api.checkParserAutoDisable("tpl_v1")).toBe(false);

    t.api.logParserEvent({ templateId: "tpl_v1", event: "reparse_accepted" });
    expect(t.api.checkParserAutoDisable("tpl_v1")).toBe(true);
    expect(t.api.isParserTemplateDisabled("tpl_v1")).toBe(true);
    expect(t.sent[0].chat).toBe("999");
    expect(t.sent[0].text).toMatch(/auto-disabled/);
    // Already disabled → no second DM.
    expect(t.api.checkParserAutoDisable("tpl_v1")).toBe(false);
  });

  it("ignores old events and the llm pseudo-template", () => {
    var t = setup();
    for (var i = 0; i < 3; i++) t.api.logParserEvent({ templateId: "tpl_v1", event: "reparse_accepted" });
    t.tab()
      .data.slice(1)
      .forEach((r) => (r[0] = "2020-01-01T00:00:00Z"));
    expect(t.api.checkParserAutoDisable("tpl_v1")).toBe(false);
    expect(t.api.checkParserAutoDisable("llm")).toBe(false);
  });
});

describe("formatParserDigest", () => {
  it("summarises saves, error rate and shadow agreement per template", () => {
    var t = setup();
    var ev = (id, e, n) => Array.from({ length: n }, () => ({ templateId: id, event: e }));
    var events = [].concat(
      ev("tpl_v1", "saved", 10),
      ev("tpl_v1", "reparse_requested", 2),
      ev("tpl_v1", "reparse_accepted", 1),
      ev("generic_v1", "shadow_match", 9),
      ev("generic_v1", "shadow_mismatch", 1)
    );
    var text = t.api.formatParserDigest(events, "shadow", ["old_v1"]);
    expect(text).toMatch(/mode: `shadow`/);
    expect(text).toMatch(/`tpl_v1` — saved 10, re-read 2, wrong 1 \(10%\)/);
    expect(text).toMatch(/`generic_v1` — saved 0, shadow agree 90% of 10/);
    expect(text).toMatch(/Disabled: `old_v1`/);
  });

  it("says so when there was no activity", () => {
    expect(setup().api.formatParserDigest([], "on", [])).toMatch(/No parser activity/);
  });
});
