import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

const TENANT_STATUS = { ACTIVE: "active", PENDING: "pending", DISABLED: "disabled" };

// In-memory PropertiesService — every test gets a fresh map.
// We expose write/delete histories so tests can verify what *was* written even
// if a later step (e.g. continueBackfill's done path) deleted the key again.
function makeProps() {
  var store = {};
  var setHistory = [];
  var deleteHistory = [];
  return {
    store: store,
    setHistory: setHistory,
    deleteHistory: deleteHistory,
    api: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => {
          store[k] = String(v);
          setHistory.push({ k: k, v: String(v) });
        },
        deleteProperty: (k) => {
          delete store[k];
          deleteHistory.push(k);
        }
      })
    }
  };
}

// Stub Utilities.formatDate — vm-eval-safe; matches the production format
// callsites consume (only the YYYY-MM-DD'T'HH:mm:ss variant is read back).
function fakeUtilities() {
  return {
    formatDate: (d, _tz, fmt) => {
      function pad(n) {
        return String(n).padStart(2, "0");
      }
      var s = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      if (fmt.indexOf("HH:mm:ss") !== -1) {
        s += "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
      } else if (fmt.indexOf("HH:mm") !== -1) {
        s += " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      }
      return s;
    },
    sleep: () => undefined
  };
}

function fakeScriptApp() {
  var triggers = [];
  var created = [];
  var nextId = 1;
  function makeTrigger(name) {
    var id = "uid-" + nextId++;
    return { getHandlerFunction: () => name, getUniqueId: () => id };
  }
  return {
    triggers: triggers,
    created: created,
    makeTrigger: makeTrigger,
    api: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => {
        var i = triggers.indexOf(t);
        if (i >= 0) triggers.splice(i, 1);
      },
      newTrigger: (name) => {
        var spec = { name: name, afterMs: null };
        created.push(spec);
        return {
          timeBased: () => ({
            after: (ms) => {
              spec.afterMs = ms;
              return {
                create: () => {
                  var t = makeTrigger(name);
                  spec.uid = t.getUniqueId();
                  triggers.push(t);
                  return t;
                }
              };
            }
          })
        };
      }
    }
  };
}

function makeStubs(overrides) {
  var props = makeProps();
  var script = fakeScriptApp();
  var sent = [];
  var deleted = [];
  var stubs = {
    TENANT_STATUS: TENANT_STATUS,
    PropertiesService: props.api,
    ScriptApp: script.api,
    Session: { getScriptTimeZone: () => "Asia/Kolkata" },
    Utilities: fakeUtilities(),
    sendTelegramMessage: (chat, text, opts) => sent.push({ chat: chat, text: text, opts: opts }),
    deleteTelegramMessage: (chat, mid) => deleted.push({ chat: chat, mid: mid }),
    getTenantChatId: () => "100",
    getTenantSheetId: () => "sheet-xyz",
    setCurrentTenant: vi.fn(),
    findTenantByChatId: vi.fn((id) => ({ chat_id: String(id), status: TENANT_STATUS.ACTIVE, emails: ["a@b.com"] })),
    sheetUrl: (id) => "https://sheets/" + id,
    formatDurationMs: () => "10m",
    backfillTransactions: vi.fn(() => ({
      savedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      totalEmails: 0,
      timedOut: false
    }))
  };
  Object.assign(stubs, overrides || {});
  return { stubs: stubs, props: props, script: script, sent: sent, deleted: deleted };
}

function load(stubs) {
  return loadAppsScript(
    ["Code.js", "Backfill.js"],
    ["handleBackfillCommand", "startChunkedBackfill", "continueBackfill"],
    stubs
  );
}

function stateFor(props, chatId) {
  var raw = props.store["backfill:" + chatId];
  return raw ? JSON.parse(raw) : undefined;
}

function firstStateWrite(props, chatId) {
  var hit = props.setHistory.find((e) => e.k === "backfill:" + chatId);
  return hit ? JSON.parse(hit.v) : undefined;
}

describe("handleBackfillCommand", () => {
  it("dispatches to startChunkedBackfill on parse success", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 10m");

    expect(env.sent[0].text).toMatch(/Backfill started/);
    expect(firstStateWrite(env.props, "100")).toBeDefined();
  });

  it("sends usage hint when /backfill has no args", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Invalid format/);
    expect(stateFor(env.props, "100")).toBeUndefined();
  });

  it("deletes the doPost ack on a parse error too", () => {
    var env = makeStubs();
    env.props.store["backfill_ack:100"] = "42";
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill");

    expect(env.deleted).toEqual([{ chat: "100", mid: 42 }]);
    expect(env.props.store["backfill_ack:100"]).toBeUndefined();
  });

  it("sends 'Unknown unit' when the unit isn't in the alias map", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 5 fortnights");
    expect(env.sent[0].text).toMatch(/Unknown unit/);
  });

  it("sends 'Invalid dates' on garbage YYYY-MM-DD input", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill notadate alsobad");
    expect(env.sent[0].text).toMatch(/Invalid dates/);
  });

  it("sends 'Start date must be before end date' on inverted range", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 2026-05-01 2026-04-01");
    expect(env.sent[0].text).toMatch(/before end date/);
  });

  it("refuses a second backfill for the same chat while one is running", () => {
    var env = makeStubs();
    env.props.store["backfill:100"] = JSON.stringify({ start: "x", end: "y", chunk: 2, updatedAt: Date.now() });
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 10m");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/already running/);
    expect(env.stubs.backfillTransactions).not.toHaveBeenCalled();
  });

  it("replaces a stale state left by a crashed chain", () => {
    var env = makeStubs();
    env.props.store["backfill:100"] = JSON.stringify({ start: "x", end: "y", chunk: 9, updatedAt: 1 });
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 10m");

    expect(env.sent[0].text).toMatch(/Backfill started/);
    expect(env.stubs.backfillTransactions).toHaveBeenCalledTimes(1);
  });
});

describe("startChunkedBackfill", () => {
  it("stores one per-chat state object with zeroed totals", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));

    var first = firstStateWrite(env.props, "100");
    expect(first).toMatchObject({ saved: 0, dupes: 0, failed: 0, chunk: 1, start: "2026-04-01T00:00:00" });
    // The inline continueBackfill finished (timedOut=false) and cleared it.
    expect(stateFor(env.props, "100")).toBeUndefined();
    // No legacy global keys.
    expect(env.props.setHistory.some((e) => /^backfill_(start|end|chunk|tenant_chat_id)$/.test(e.k))).toBe(false);
  });

  it("extends a midnight endDate to end-of-day before persisting", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));
    expect(firstStateWrite(env.props, "100").end).toBe("2026-04-03T23:59:59");
  });

  it("preserves a sub-day endDate's exact time (no end-of-day extension)", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-15T14:20:00"), new Date("2026-04-15T14:30:00"));
    expect(firstStateWrite(env.props, "100").end).toBe("2026-04-15T14:30:00");
  });

  it("deletes the doPost ack message for this chat", () => {
    var env = makeStubs();
    env.props.store["backfill_ack:100"] = "42";
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));

    expect(env.deleted).toEqual([{ chat: "100", mid: 42 }]);
    expect(env.props.store["backfill_ack:100"]).toBeUndefined();
  });

  it("invokes continueBackfill synchronously after persisting state", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));
    expect(env.stubs.backfillTransactions).toHaveBeenCalledTimes(1);
  });
});

describe("continueBackfill", () => {
  function seedRunningBackfill(env, chatId) {
    chatId = chatId || "100";
    env.props.store["backfill:" + chatId] = JSON.stringify({
      start: "2026-04-01T00:00:00",
      end: "2026-04-03T23:59:59",
      saved: 0,
      dupes: 0,
      failed: 0,
      chunk: 1,
      updatedAt: Date.now()
    });
    var trigger = env.script.makeTrigger("continueBackfill");
    env.script.triggers.push(trigger);
    env.props.store["backfill_trigger:" + trigger.getUniqueId()] = chatId;
    return { triggerUid: trigger.getUniqueId() };
  }

  it("deletes only the trigger that invoked it", () => {
    var env = makeStubs();
    var evA = seedRunningBackfill(env, "100");
    seedRunningBackfill(env, "200");
    env.script.triggers.push(env.script.makeTrigger("unrelatedTrigger"));
    var api = load(env.stubs);
    api.continueBackfill(evA);

    var names = env.script.triggers.map((t) => t.getHandlerFunction());
    expect(names).toEqual(["continueBackfill", "unrelatedTrigger"]);
    expect(env.props.store["backfill_trigger:" + evA.triggerUid]).toBeUndefined();
  });

  it("runs two users' backfills independently", () => {
    var env = makeStubs({
      backfillTransactions: vi.fn(() => ({
        savedCount: 1,
        duplicateCount: 0,
        failedCount: 0,
        totalEmails: 1,
        timedOut: true
      }))
    });
    var evA = seedRunningBackfill(env, "100");
    var evB = seedRunningBackfill(env, "200");
    var api = load(env.stubs);
    api.continueBackfill(evA);
    api.continueBackfill(evB);

    expect(stateFor(env.props, "100").chunk).toBe(2);
    expect(stateFor(env.props, "200").chunk).toBe(2);
    expect(env.sent.map((s) => s.chat)).toEqual(["100", "200"]);
    // Each new chunk trigger maps back to its own chat.
    var mapped = env.script.created.map((c) => env.props.store["backfill_trigger:" + c.uid]);
    expect(mapped).toEqual(["100", "200"]);
  });

  it("aborts and clears state when the tenant is gone", () => {
    var env = makeStubs({ findTenantByChatId: () => null });
    var ev = seedRunningBackfill(env);
    var api = load(env.stubs);
    api.continueBackfill(ev);

    expect(env.stubs.backfillTransactions).not.toHaveBeenCalled();
    expect(stateFor(env.props, "100")).toBeUndefined();
  });

  it("aborts when the tenant is disabled, but keeps going for dormant tenants", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "100", status: TENANT_STATUS.DISABLED, emails: [] })
    });
    var ev = seedRunningBackfill(env);
    load(env.stubs).continueBackfill(ev);
    expect(env.stubs.backfillTransactions).not.toHaveBeenCalled();

    var env2 = makeStubs({ findTenantByChatId: () => ({ chat_id: "100", status: "dormant", emails: [] }) });
    var ev2 = seedRunningBackfill(env2);
    load(env2.stubs).continueBackfill(ev2);
    expect(env2.stubs.backfillTransactions).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a trigger with no chat mapping (stale trigger)", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.continueBackfill({ triggerUid: "uid-unknown" });

    expect(env.stubs.backfillTransactions).not.toHaveBeenCalled();
    expect(env.sent).toEqual([]);
  });

  it("calls backfillTransactions with (start, end, timeLimitMs) only", () => {
    var env = makeStubs();
    var ev = seedRunningBackfill(env);
    load(env.stubs).continueBackfill(ev);

    var args = env.stubs.backfillTransactions.mock.calls[0];
    expect(args).toHaveLength(3);
    expect(args[0]).toBeInstanceOf(Date);
    expect(args[1]).toBeInstanceOf(Date);
    expect(typeof args[2]).toBe("number");
  });

  it("on timeout: bumps chunk, sends progress, and schedules a trigger after 10s", () => {
    var env = makeStubs({
      backfillTransactions: vi.fn(() => ({
        savedCount: 5,
        duplicateCount: 2,
        failedCount: 1,
        totalEmails: 100,
        timedOut: true
      }))
    });
    var ev = seedRunningBackfill(env);
    load(env.stubs).continueBackfill(ev);

    expect(stateFor(env.props, "100")).toMatchObject({ chunk: 2, saved: 5, dupes: 2, failed: 1 });
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/chunk 1 done/);
    expect(env.script.created).toEqual([{ name: "continueBackfill", afterMs: 10000, uid: expect.any(String) }]);
  });

  it("on completion: sends summary and clears state", () => {
    var env = makeStubs({
      backfillTransactions: vi.fn(() => ({
        savedCount: 17,
        duplicateCount: 3,
        failedCount: 0,
        totalEmails: 20,
        timedOut: false
      }))
    });
    var ev = seedRunningBackfill(env);
    load(env.stubs).continueBackfill(ev);

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Backfill Complete/);
    expect(env.sent[0].text).toMatch(/Transactions saved.*17/s);
    expect(env.sent[0].text).toMatch(/Duplicates skipped.*3/s);
    expect(env.sent[0].text).toMatch(/\/sheet/);
    expect(stateFor(env.props, "100")).toBeUndefined();
    expect(env.script.created).toEqual([]);
  });

  it("accumulates totals across two chunks (timeout then done)", () => {
    var calls = 0;
    var env = makeStubs({
      backfillTransactions: vi.fn(() => {
        calls++;
        return calls === 1
          ? { savedCount: 3, duplicateCount: 1, failedCount: 0, totalEmails: 50, timedOut: true }
          : { savedCount: 4, duplicateCount: 2, failedCount: 1, totalEmails: 50, timedOut: false };
      })
    });
    var ev = seedRunningBackfill(env);
    var api = load(env.stubs);
    api.continueBackfill(ev);
    api.continueBackfill({ triggerUid: env.script.created[0].uid });

    var summary = env.sent[env.sent.length - 1].text;
    expect(summary).toMatch(/Transactions saved.*7/s);
    expect(summary).toMatch(/Duplicates skipped.*3/s);
    expect(summary).toMatch(/Failed.*1/s);
    expect(summary).toMatch(/Chunks.*2/s);
  });

  it("omits Duplicates and Failed lines when both are zero", () => {
    var env = makeStubs({
      backfillTransactions: vi.fn(() => ({
        savedCount: 5,
        duplicateCount: 0,
        failedCount: 0,
        totalEmails: 5,
        timedOut: false
      }))
    });
    var ev = seedRunningBackfill(env);
    load(env.stubs).continueBackfill(ev);

    var summary = env.sent[0].text;
    expect(summary).toMatch(/Transactions saved.*5/s);
    expect(summary).not.toMatch(/Duplicates/);
    expect(summary).not.toMatch(/Failed/);
    expect(summary).not.toMatch(/Chunks/);
  });
});
