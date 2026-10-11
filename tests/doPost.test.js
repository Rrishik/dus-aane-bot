import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

function setup() {
  var store = {};
  var triggers = [];
  var trigger = (name) => {
    var t = { getHandlerFunction: () => name, getUniqueId: () => name + "-id" };
    triggers.push(t);
    return t;
  };
  var stubs = {
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
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1)
    },
    isWorkerActionBody: (b) => !!(b && b.action && b.sig),
    handleWorkerAction: vi.fn(() => "action-response"),
    extractTransactions: vi.fn()
  };
  var api = loadAppsScript(["Code.js"], ["doPost", "triggerEmailProcessing"], stubs);
  return { api, stubs, store, triggers, trigger };
}

const post = (api, body) =>
  api.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } });

describe("doPost", () => {
  it("hands signed Worker actions to the bridge", () => {
    const { api, stubs } = setup();
    expect(post(api, { action: "get_email_body", sig: "x", ts: "1", payload: "{}" })).toBe("action-response");
    expect(stubs.handleWorkerAction).toHaveBeenCalledTimes(1);
  });

  it("answers anything else with OK and does nothing", () => {
    const { api, stubs } = setup();
    expect(post(api, { update_id: 1, message: { text: "/start" } })).toBe("OK");
    expect(post(api, "not json")).toBe("OK");
    expect(api.doPost({})).toBe("OK");
    expect(stubs.handleWorkerAction).not.toHaveBeenCalled();
  });
});

describe("triggerEmailProcessing", () => {
  it("removes triggers for handlers that no longer exist, once", () => {
    const { api, stubs, store, triggers, trigger } = setup();
    trigger("triggerEmailProcessing");
    trigger("sendWeeklySummaries");
    trigger("nudgeDormantTenants");
    trigger("continueWorkerBackfill");
    api.triggerEmailProcessing();
    expect(triggers.map((t) => t.getHandlerFunction())).toEqual(["triggerEmailProcessing", "continueWorkerBackfill"]);
    expect(store["triggers.prunedV1"]).toBeTruthy();
    expect(stubs.extractTransactions).toHaveBeenCalledTimes(1);

    trigger("somethingNew");
    api.triggerEmailProcessing();
    expect(triggers).toHaveLength(3);
  });
});
