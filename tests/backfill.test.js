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

// Pluck the LAST value written for a given key (most recent setProperty).
function lastSet(props, key) {
  for (var i = props.setHistory.length - 1; i >= 0; i--) {
    if (props.setHistory[i].k === key) return props.setHistory[i].v;
  }
  return undefined;
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
  return {
    triggers: triggers,
    created: created,
    api: {
      getProjectTriggers: () => triggers,
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
              return { create: () => triggers.push({ getHandlerFunction: () => name }) };
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
    findTenantByChatId: vi.fn(() => ({ chat_id: "100", status: TENANT_STATUS.ACTIVE, emails: ["a@b.com"] })),
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
  return loadAppsScript(["Backfill.js"], ["handleBackfillCommand", "startChunkedBackfill", "continueBackfill"], stubs);
}

describe("handleBackfillCommand", () => {
  it("dispatches to startChunkedBackfill on parse success", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 10m");

    // startChunkedBackfill ran → "Backfill started" was sent + props were stashed at some point.
    expect(env.sent.length).toBeGreaterThan(0);
    expect(env.sent[0].text).toMatch(/Backfill started/);
    expect(lastSet(env.props, "backfill_start")).toBeDefined();
    expect(lastSet(env.props, "backfill_end")).toBeDefined();
  });

  it("sends usage hint when /backfill has no args", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Invalid format/);
    expect(env.props.store.backfill_start).toBeUndefined();
  });

  it("sends 'Unknown unit' when the unit isn't in the alias map", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 5 fortnights");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Unknown unit/);
  });

  it("sends 'Invalid dates' on garbage YYYY-MM-DD input", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill notadate alsobad");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Invalid dates/);
  });

  it("sends 'Start date must be before end date' on inverted range", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleBackfillCommand("100", "/backfill 2026-05-01 2026-04-01");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/before end date/);
  });
});

describe("startChunkedBackfill", () => {
  it("stashes all props and stamps the current tenant chat_id", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));

    expect(lastSet(env.props, "backfill_start")).toBeDefined();
    expect(lastSet(env.props, "backfill_end")).toBeDefined();
    expect(lastSet(env.props, "backfill_total_saved")).toBe("0");
    expect(lastSet(env.props, "backfill_total_dupes")).toBe("0");
    expect(lastSet(env.props, "backfill_total_failed")).toBe("0");
    // backfill_chunk is set to "1" by startChunkedBackfill, but continueBackfill (called inline)
    // sees timedOut=false from our default stub and goes through the "done" path, which deletes
    // the chunk prop. We assert the first write to chunk was "1".
    expect(env.props.setHistory.find((e) => e.k === "backfill_chunk").v).toBe("1");
    expect(lastSet(env.props, "backfill_tenant_chat_id")).toBe("100");
    // No total_processed prop anymore (refactor: server-side label exclusion handles cross-chunk dedup).
    expect(env.props.setHistory.some((e) => e.k === "backfill_total_processed")).toBe(false);
  });

  it("extends a midnight endDate to end-of-day before persisting", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));

    // Stored end carries 23:59:59 (the formatter strips millis but keeps seconds).
    expect(lastSet(env.props, "backfill_end")).toBe("2026-04-03T23:59:59");
  });

  it("preserves a sub-day endDate's exact time (no end-of-day extension)", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    var end = new Date("2026-04-15T14:30:00");
    api.startChunkedBackfill(new Date("2026-04-15T14:20:00"), end);

    expect(lastSet(env.props, "backfill_end")).toBe("2026-04-15T14:30:00");
  });

  it("deletes the doPost ack message when ack props are present", () => {
    var env = makeStubs();
    env.props.store.backfill_ack_msg_id = "42";
    env.props.store.backfill_ack_chat_id = "100";
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));

    expect(env.deleted).toEqual([{ chat: "100", mid: 42 }]);
    expect(env.props.store.backfill_ack_msg_id).toBeUndefined();
    expect(env.props.store.backfill_ack_chat_id).toBeUndefined();
  });

  it("invokes continueBackfill synchronously after persisting state", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.startChunkedBackfill(new Date("2026-04-01T00:00:00"), new Date("2026-04-03T00:00:00"));

    // continueBackfill ran inline (proxy: backfillTransactions was called).
    expect(env.stubs.backfillTransactions).toHaveBeenCalledTimes(1);
  });
});

describe("continueBackfill", () => {
  function seedRunningBackfill(props) {
    props.store.backfill_start = "2026-04-01T00:00:00";
    props.store.backfill_end = "2026-04-03T23:59:59";
    props.store.backfill_total_saved = "0";
    props.store.backfill_total_dupes = "0";
    props.store.backfill_total_failed = "0";
    props.store.backfill_chunk = "1";
    props.store.backfill_tenant_chat_id = "100";
  }

  it("deletes the continueBackfill trigger that invoked it", () => {
    var env = makeStubs();
    seedRunningBackfill(env.props);
    env.script.triggers.push({ getHandlerFunction: () => "continueBackfill" });
    env.script.triggers.push({ getHandlerFunction: () => "unrelatedTrigger" });
    var api = load(env.stubs);
    api.continueBackfill();

    // Only the unrelated trigger survives.
    expect(env.script.triggers).toHaveLength(1);
    expect(env.script.triggers[0].getHandlerFunction()).toBe("unrelatedTrigger");
  });

  it("aborts and cleans all backfill_* props when tenant is gone", () => {
    var env = makeStubs({ findTenantByChatId: () => null });
    seedRunningBackfill(env.props);
    var api = load(env.stubs);
    api.continueBackfill();

    expect(env.stubs.backfillTransactions).not.toHaveBeenCalled();
    expect(env.props.store.backfill_start).toBeUndefined();
    expect(env.props.store.backfill_end).toBeUndefined();
    expect(env.props.store.backfill_chunk).toBeUndefined();
    expect(env.props.store.backfill_tenant_chat_id).toBeUndefined();
  });

  it("aborts and cleans props when tenant is no longer ACTIVE", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "100", status: TENANT_STATUS.DISABLED, emails: [] })
    });
    seedRunningBackfill(env.props);
    var api = load(env.stubs);
    api.continueBackfill();

    expect(env.stubs.backfillTransactions).not.toHaveBeenCalled();
    expect(env.props.store.backfill_start).toBeUndefined();
  });

  it("is a no-op when backfill_start/end props are missing (stale trigger)", () => {
    var env = makeStubs();
    // No seedRunningBackfill — props are empty.
    var api = load(env.stubs);
    api.continueBackfill();

    expect(env.stubs.backfillTransactions).not.toHaveBeenCalled();
    expect(env.sent).toEqual([]);
  });

  it("calls backfillTransactions WITHOUT a skipCount (regression: refactor dropped the param)", () => {
    var env = makeStubs();
    seedRunningBackfill(env.props);
    // Even with a pre-existing total_processed value (legacy state), it must not be passed through.
    env.props.store.backfill_total_processed = "30";
    var api = load(env.stubs);
    api.continueBackfill();

    expect(env.stubs.backfillTransactions).toHaveBeenCalledTimes(1);
    var args = env.stubs.backfillTransactions.mock.calls[0];
    // backfillTransactions(startDate, endDate, timeLimitMs) — no 4th arg.
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
    seedRunningBackfill(env.props);
    var api = load(env.stubs);
    api.continueBackfill();

    expect(env.props.store.backfill_chunk).toBe("2");
    expect(env.props.store.backfill_total_saved).toBe("5");
    expect(env.props.store.backfill_total_dupes).toBe("2");
    expect(env.props.store.backfill_total_failed).toBe("1");
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/chunk 1 done/);
    expect(env.script.created).toEqual([{ name: "continueBackfill", afterMs: 10000 }]);
  });

  it("on completion: sends summary with sheet button and clears all props", () => {
    var env = makeStubs({
      backfillTransactions: vi.fn(() => ({
        savedCount: 17,
        duplicateCount: 3,
        failedCount: 0,
        totalEmails: 20,
        timedOut: false
      }))
    });
    seedRunningBackfill(env.props);
    var api = load(env.stubs);
    api.continueBackfill();

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Backfill Complete/);
    expect(env.sent[0].text).toMatch(/Transactions saved.*17/s);
    expect(env.sent[0].text).toMatch(/Duplicates skipped.*3/s);
    expect(env.sent[0].text).toMatch(/\/sheet/);
    expect(env.sent[0].opts.reply_markup).toBeUndefined();

    // All cleaned up.
    expect(env.props.store.backfill_start).toBeUndefined();
    expect(env.props.store.backfill_end).toBeUndefined();
    expect(env.props.store.backfill_total_saved).toBeUndefined();
    expect(env.props.store.backfill_total_dupes).toBeUndefined();
    expect(env.props.store.backfill_total_failed).toBeUndefined();
    expect(env.props.store.backfill_chunk).toBeUndefined();
    expect(env.props.store.backfill_tenant_chat_id).toBeUndefined();

    // No follow-up trigger scheduled.
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
    seedRunningBackfill(env.props);
    var api = load(env.stubs);

    api.continueBackfill(); // chunk 1
    api.continueBackfill(); // chunk 2 (done)

    expect(env.stubs.backfillTransactions).toHaveBeenCalledTimes(2);

    // Final summary message reflects accumulated totals (3+4=7 saved, 1+2=3 dupes, 0+1=1 failed).
    var summary = env.sent[env.sent.length - 1].text;
    expect(summary).toMatch(/Backfill Complete/);
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
    seedRunningBackfill(env.props);
    var api = load(env.stubs);
    api.continueBackfill();

    var summary = env.sent[0].text;
    expect(summary).toMatch(/Transactions saved.*5/s);
    expect(summary).not.toMatch(/Duplicates/);
    expect(summary).not.toMatch(/Failed/);
    expect(summary).not.toMatch(/Chunks/); // single chunk → no Chunks line
  });
});
