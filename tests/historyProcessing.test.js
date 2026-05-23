import { describe, it, expect, beforeEach } from "vitest";
import { loadAppsScript } from "./_loader.js";

// Mirrors Constants.js so we don't have to load it (it depends on BOT_TOKEN
// being globally defined, which other tests deliberately avoid).
const PROCESSED_LABEL_NAME = "processed-by-bot";

function makePropsStore(initial) {
  var store = Object.assign({}, initial || {});
  return {
    getProperty(k) {
      return k in store ? store[k] : null;
    },
    setProperty(k, v) {
      store[k] = String(v);
    },
    deleteProperty(k) {
      delete store[k];
    }
  };
}

function makeCacheStore() {
  var store = {};
  return {
    get(k) {
      return k in store ? store[k] : null;
    },
    put(k, v) {
      store[k] = v;
    }
  };
}

describe("getProcessedLabelId", () => {
  let propsStore;
  let gmail;
  let getProcessedLabelId;

  function load() {
    return loadAppsScript(["TransactionProcessor.js"], ["getProcessedLabelId"], {
      PROCESSED_LABEL_NAME,
      PropertiesService: { getScriptProperties: () => propsStore },
      Gmail: gmail
    }).getProcessedLabelId;
  }

  beforeEach(() => {
    propsStore = makePropsStore();
    gmail = {
      Users: {
        Labels: {
          list: () => ({ labels: [] }),
          create: () => ({ id: "Label_unused" })
        }
      }
    };
  });

  it("returns the cached id and skips Gmail entirely", () => {
    propsStore.setProperty("gmail.processedLabelId", "Label_cached_123");
    let listCalls = 0;
    let createCalls = 0;
    gmail.Users.Labels.list = () => {
      listCalls++;
      return { labels: [] };
    };
    gmail.Users.Labels.create = () => {
      createCalls++;
      return { id: "X" };
    };

    getProcessedLabelId = load();
    expect(getProcessedLabelId()).toBe("Label_cached_123");
    expect(listCalls).toBe(0);
    expect(createCalls).toBe(0);
  });

  it("finds the existing label by name and caches its id", () => {
    gmail.Users.Labels.list = () => ({
      labels: [
        { id: "Label_other", name: "Other" },
        { id: "Label_4711", name: PROCESSED_LABEL_NAME }
      ]
    });
    let createCalls = 0;
    gmail.Users.Labels.create = () => {
      createCalls++;
      return { id: "X" };
    };

    getProcessedLabelId = load();
    expect(getProcessedLabelId()).toBe("Label_4711");
    expect(propsStore.getProperty("gmail.processedLabelId")).toBe("Label_4711");
    expect(createCalls).toBe(0);
  });

  it("creates the label with labelShow visibility when missing", () => {
    gmail.Users.Labels.list = () => ({
      labels: [{ id: "Label_other", name: "Other" }]
    });
    let createPayload = null;
    let createUserId = null;
    gmail.Users.Labels.create = (resource, userId) => {
      createPayload = resource;
      createUserId = userId;
      return { id: "Label_new_999" };
    };

    getProcessedLabelId = load();
    expect(getProcessedLabelId()).toBe("Label_new_999");
    expect(createPayload).toEqual({
      name: PROCESSED_LABEL_NAME,
      labelListVisibility: "labelShow",
      messageListVisibility: "show"
    });
    expect(createUserId).toBe("me");
    expect(propsStore.getProperty("gmail.processedLabelId")).toBe("Label_new_999");
  });

  it("handles an empty labels.list response without throwing", () => {
    gmail.Users.Labels.list = () => ({});
    gmail.Users.Labels.create = () => ({ id: "Label_fresh" });

    getProcessedLabelId = load();
    expect(getProcessedLabelId()).toBe("Label_fresh");
  });
});

describe("listNewMessageIdsViaHistory", () => {
  let gmail;
  let listNewMessageIdsViaHistory;

  function load() {
    return loadAppsScript(["TransactionProcessor.js"], ["listNewMessageIdsViaHistory"], {
      PROCESSED_LABEL_NAME,
      PropertiesService: { getScriptProperties: () => makePropsStore() },
      Gmail: gmail
    }).listNewMessageIdsViaHistory;
  }

  beforeEach(() => {
    gmail = { Users: { History: { list: () => ({}) } } };
  });

  it("returns empty messageIds when history.list reports no records", () => {
    gmail.Users.History.list = () => ({ historyId: "555" });
    listNewMessageIdsViaHistory = load();

    var result = listNewMessageIdsViaHistory("100");
    expect(result.messageIds).toEqual([]);
    expect(result.newHistoryId).toBe("555");
  });

  it("extracts ids from messagesAdded across multiple history records", () => {
    gmail.Users.History.list = () => ({
      historyId: "200",
      history: [
        { id: "h1", messagesAdded: [{ message: { id: "m_a", threadId: "t1" } }] },
        {
          id: "h2",
          messagesAdded: [{ message: { id: "m_b", threadId: "t1" } }, { message: { id: "m_c", threadId: "t2" } }]
        }
      ]
    });
    listNewMessageIdsViaHistory = load();

    var result = listNewMessageIdsViaHistory("100");
    expect(result.messageIds).toEqual(["m_a", "m_b", "m_c"]);
    expect(result.newHistoryId).toBe("200");
  });

  it("deduplicates repeated message ids", () => {
    gmail.Users.History.list = () => ({
      historyId: "300",
      history: [
        { id: "h1", messagesAdded: [{ message: { id: "m_a" } }] },
        { id: "h2", messagesAdded: [{ message: { id: "m_a" } }] }
      ]
    });
    listNewMessageIdsViaHistory = load();

    expect(listNewMessageIdsViaHistory("100").messageIds).toEqual(["m_a"]);
  });

  it("follows nextPageToken across pages and accumulates ids", () => {
    var calls = [];
    var pages = [
      {
        historyId: "10",
        history: [{ id: "h1", messagesAdded: [{ message: { id: "m1" } }] }],
        nextPageToken: "tok2"
      },
      {
        historyId: "20",
        history: [{ id: "h2", messagesAdded: [{ message: { id: "m2" } }] }],
        nextPageToken: "tok3"
      },
      {
        historyId: "30",
        history: [{ id: "h3", messagesAdded: [{ message: { id: "m3" } }] }]
      }
    ];
    var i = 0;
    gmail.Users.History.list = (_userId, params) => {
      calls.push(params);
      return pages[i++];
    };
    listNewMessageIdsViaHistory = load();

    var result = listNewMessageIdsViaHistory("1");
    expect(result.messageIds).toEqual(["m1", "m2", "m3"]);
    expect(result.newHistoryId).toBe("30");
    expect(calls).toHaveLength(3);
    expect(calls[0].pageToken).toBeUndefined();
    expect(calls[1].pageToken).toBe("tok2");
    expect(calls[2].pageToken).toBe("tok3");
    // Every page should carry the original startHistoryId, not the cursor we
    // just received — Gmail's API requires it for pagination consistency.
    expect(calls.every((c) => c.startHistoryId === "1")).toBe(true);
    expect(calls.every((c) => Array.isArray(c.historyTypes) && c.historyTypes[0] === "messageAdded")).toBe(true);
  });

  it("returns null when Gmail throws (expired/invalid startHistoryId)", () => {
    gmail.Users.History.list = () => {
      throw new Error("Invalid startHistoryId");
    };
    listNewMessageIdsViaHistory = load();

    expect(listNewMessageIdsViaHistory("999")).toBeNull();
  });

  it("ignores history records that lack messagesAdded (e.g. labelAdded-only)", () => {
    gmail.Users.History.list = () => ({
      historyId: "42",
      history: [{ id: "h1" }, { id: "h2", messagesAdded: [{ message: { id: "m_z" } }] }]
    });
    listNewMessageIdsViaHistory = load();

    expect(listNewMessageIdsViaHistory("1").messageIds).toEqual(["m_z"]);
  });
});

describe("bootstrapHistoryState", () => {
  it("captures profile.historyId and stores it under gmail.lastHistoryId", () => {
    var propsStore = makePropsStore();
    var gmail = {
      Users: { getProfile: () => ({ historyId: "9001", emailAddress: "x@y" }) }
    };
    var { bootstrapHistoryState } = loadAppsScript(["TransactionProcessor.js"], ["bootstrapHistoryState"], {
      PROCESSED_LABEL_NAME,
      PropertiesService: { getScriptProperties: () => propsStore },
      Gmail: gmail
    });

    expect(bootstrapHistoryState()).toBe("9001");
    expect(propsStore.getProperty("gmail.lastHistoryId")).toBe("9001");
  });
});

describe("markProcessed", () => {
  let propsStore;
  let cacheStore;
  let gmail;
  let markProcessed;

  function makeMessage(id) {
    return { getId: () => id };
  }

  function load() {
    return loadAppsScript(["TransactionProcessor.js"], ["markProcessed"], {
      PROCESSED_LABEL_NAME,
      PropertiesService: { getScriptProperties: () => propsStore },
      CacheService: { getScriptCache: () => cacheStore },
      Gmail: gmail
    }).markProcessed;
  }

  beforeEach(() => {
    propsStore = makePropsStore({ "gmail.processedLabelId": "Label_cached" });
    cacheStore = makeCacheStore();
    gmail = {
      Users: {
        Labels: { list: () => ({ labels: [] }), create: () => ({ id: "X" }) },
        Messages: { modify: () => ({}) }
      }
    };
  });

  it("writes the cache entry and calls Messages.modify with the cached label id", () => {
    var modifyArgs = null;
    gmail.Users.Messages.modify = (resource, userId, msgId) => {
      modifyArgs = { resource, userId, msgId };
    };
    markProcessed = load();

    markProcessed(makeMessage("msg_42"));

    expect(cacheStore.get("processed:msg_42")).toBe("1");
    expect(modifyArgs).toEqual({
      resource: { addLabelIds: ["Label_cached"] },
      userId: "me",
      msgId: "msg_42"
    });
  });

  it("clears the cached label id when modify fails with a label error", () => {
    gmail.Users.Messages.modify = () => {
      throw new Error("Invalid label id");
    };
    markProcessed = load();

    markProcessed(makeMessage("msg_43"));

    expect(propsStore.getProperty("gmail.processedLabelId")).toBeNull();
  });

  it("keeps the cached label id when modify fails with a non-label error", () => {
    gmail.Users.Messages.modify = () => {
      throw new Error("Network timeout");
    };
    markProcessed = load();

    markProcessed(makeMessage("msg_44"));

    expect(propsStore.getProperty("gmail.processedLabelId")).toBe("Label_cached");
  });

  it("still attempts modify when cache.put throws (and does not propagate)", () => {
    cacheStore.put = () => {
      throw new Error("cache quota exceeded");
    };
    var modifyCalled = false;
    gmail.Users.Messages.modify = () => {
      modifyCalled = true;
    };
    markProcessed = load();

    expect(() => markProcessed(makeMessage("msg_45"))).not.toThrow();
    expect(modifyCalled).toBe(true);
  });

  it("falls back to getProcessedLabelId (creating the label) when cache is cold", () => {
    propsStore = makePropsStore();
    var createCalls = 0;
    gmail.Users.Labels.list = () => ({ labels: [] });
    gmail.Users.Labels.create = () => {
      createCalls++;
      return { id: "Label_fresh" };
    };
    var modifyArgs = null;
    gmail.Users.Messages.modify = (resource, userId, msgId) => {
      modifyArgs = { resource, userId, msgId };
    };
    markProcessed = load();

    markProcessed(makeMessage("msg_46"));

    expect(createCalls).toBe(1);
    expect(modifyArgs.resource.addLabelIds).toEqual(["Label_fresh"]);
    expect(propsStore.getProperty("gmail.processedLabelId")).toBe("Label_fresh");
  });
});

describe("markProcessed batch buffer", () => {
  let propsStore;
  let cacheStore;
  let gmail;
  let api;

  function makeMessage(id) {
    return { getId: () => id };
  }

  function load() {
    return loadAppsScript(["TransactionProcessor.js"], ["markProcessed", "beginProcessedBatch", "endProcessedBatch"], {
      PROCESSED_LABEL_NAME,
      PropertiesService: { getScriptProperties: () => propsStore },
      CacheService: { getScriptCache: () => cacheStore },
      Gmail: gmail
    });
  }

  beforeEach(() => {
    propsStore = makePropsStore({ "gmail.processedLabelId": "Label_cached" });
    cacheStore = makeCacheStore();
    gmail = {
      Users: {
        Labels: { list: () => ({ labels: [] }), create: () => ({ id: "X" }) },
        Messages: { modify: () => ({}), batchModify: () => ({}) }
      }
    };
    api = load();
  });

  it("defers per-message modify when a batch is active and flushes via batchModify", () => {
    var modifyCalls = 0;
    var batchCalls = [];
    gmail.Users.Messages.modify = () => {
      modifyCalls++;
    };
    gmail.Users.Messages.batchModify = (resource, userId) => {
      batchCalls.push({ resource, userId });
    };

    api.beginProcessedBatch();
    api.markProcessed(makeMessage("m1"));
    api.markProcessed(makeMessage("m2"));
    api.markProcessed(makeMessage("m3"));

    expect(modifyCalls).toBe(0);
    expect(batchCalls).toHaveLength(0);
    // Cache writes still happen inline so isAlreadyProcessed sees them mid-loop.
    expect(cacheStore.get("processed:m1")).toBe("1");
    expect(cacheStore.get("processed:m3")).toBe("1");

    api.endProcessedBatch();

    expect(batchCalls).toEqual([
      { resource: { ids: ["m1", "m2", "m3"], addLabelIds: ["Label_cached"] }, userId: "me" }
    ]);
  });

  it("endProcessedBatch is a no-op when no ids accumulated", () => {
    var batchCalls = 0;
    gmail.Users.Messages.batchModify = () => batchCalls++;

    api.beginProcessedBatch();
    api.endProcessedBatch();

    expect(batchCalls).toBe(0);
  });

  it("falls back to per-message modify after endProcessedBatch", () => {
    var modifyCalls = 0;
    gmail.Users.Messages.modify = () => modifyCalls++;

    api.beginProcessedBatch();
    api.endProcessedBatch();
    api.markProcessed(makeMessage("m_after"));

    expect(modifyCalls).toBe(1);
  });

  it("chunks batchModify into groups of 1000 ids", () => {
    var batchSizes = [];
    gmail.Users.Messages.batchModify = (resource) => {
      batchSizes.push(resource.ids.length);
    };

    api.beginProcessedBatch();
    for (var i = 0; i < 2300; i++) api.markProcessed(makeMessage("m" + i));
    api.endProcessedBatch();

    expect(batchSizes).toEqual([1000, 1000, 300]);
  });

  it("clears the cached label id when batchModify fails with a label error", () => {
    gmail.Users.Messages.batchModify = () => {
      throw new Error("Invalid label id in addLabelIds");
    };

    api.beginProcessedBatch();
    api.markProcessed(makeMessage("m1"));
    api.endProcessedBatch();

    expect(propsStore.getProperty("gmail.processedLabelId")).toBeNull();
  });
});
