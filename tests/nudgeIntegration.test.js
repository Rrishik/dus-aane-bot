import { describe, it, expect } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "admin-sheet";
const NOW_FIXED = new Date("2026-04-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// Build a Tenants tab pre-loaded with rows, then load TenantRegistry + Nudge
// against it. Stubs sendTelegramMessage to capture calls instead of hitting
// Telegram. Returns { mod, sentMessages, getSheetRow }.
function setupNudgeEnv(rows) {
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
    "nag_count"
  ]);
  rows.forEach(function (r) {
    tab.appendRow(r);
  });

  var sentMessages = [];
  var stubs = {
    SpreadsheetApp: SpreadsheetApp,
    ADMIN_SHEET_ID: ADMIN_SHEET_ID,
    sendTelegramMessage: function (chatId, msg, opts) {
      sentMessages.push({ chatId: String(chatId), msg: msg, opts: opts });
    },
    // Freeze "now" for deterministic shouldNudge decisions.
    Date: class extends Date {
      constructor() {
        if (arguments.length === 0) {
          super(NOW_FIXED.getTime());
        } else {
          super(...arguments);
        }
      }
      static now() {
        return NOW_FIXED.getTime();
      }
    }
  };

  var mod = loadAppsScript(
    ["TenantRegistry.js", "Nudge.js"],
    [
      "nudgeDormantTenants",
      "loadTenants",
      "invalidateTenantCache",
      "stampLastForward",
      "reactivateIfDormant",
      "TENANT_STATUS",
      "TENANT_COLS"
    ],
    stubs
  );

  return {
    mod: mod,
    sentMessages: sentMessages,
    getRow: function (chatId) {
      mod.invalidateTenantCache();
      var all = mod.loadTenants();
      return all.find((t) => t.chat_id === String(chatId));
    }
  };
}

describe("nudgeDormantTenants — multi-tenant loop", () => {
  it("nudges only the eligible tenant; skips fresh and cooled-down rows", () => {
    var env = setupNudgeEnv([
      // Alice — inactive 6 days, should be nudged.
      [
        "111",
        "Alice",
        "",
        "sheet-a",
        "active",
        new Date(NOW_FIXED.getTime() - 60 * DAY_MS).toISOString(),
        "",
        new Date(NOW_FIXED.getTime() - 6 * DAY_MS).toISOString(),
        "",
        0
      ],
      // Bob — forwarded yesterday, fresh — skip.
      [
        "222",
        "Bob",
        "",
        "sheet-b",
        "active",
        new Date(NOW_FIXED.getTime() - 60 * DAY_MS).toISOString(),
        "",
        new Date(NOW_FIXED.getTime() - 1 * DAY_MS).toISOString(),
        "",
        0
      ],
      // Carol — inactive 20 days but nudged 3 days ago — cooldown, skip.
      [
        "333",
        "Carol",
        "",
        "sheet-c",
        "active",
        new Date(NOW_FIXED.getTime() - 60 * DAY_MS).toISOString(),
        "",
        new Date(NOW_FIXED.getTime() - 20 * DAY_MS).toISOString(),
        new Date(NOW_FIXED.getTime() - 3 * DAY_MS).toISOString(),
        1
      ]
    ]);

    env.mod.nudgeDormantTenants();

    expect(env.sentMessages.length).toBe(1);
    expect(env.sentMessages[0].chatId).toBe("111");

    var alice = env.getRow("111");
    expect(alice.nag_count).toBe(1);
    expect(alice.last_nag_at).toBeTruthy();
    expect(alice.status).toBe("active"); // not yet capped

    var bob = env.getRow("222");
    expect(bob.nag_count).toBe(0);
    expect(bob.last_nag_at).toBe("");

    var carol = env.getRow("333");
    expect(carol.nag_count).toBe(1); // unchanged
  });

  it("flips to DORMANT after the final nudge hits maxNudges", () => {
    var env = setupNudgeEnv([
      [
        "111",
        "Alice",
        "",
        "sheet-a",
        "active",
        new Date(NOW_FIXED.getTime() - 60 * DAY_MS).toISOString(),
        "",
        new Date(NOW_FIXED.getTime() - 30 * DAY_MS).toISOString(),
        new Date(NOW_FIXED.getTime() - 8 * DAY_MS).toISOString(), // cooldown elapsed
        2 // one more nudge -> hits cap of 3
      ]
    ]);

    env.mod.nudgeDormantTenants();

    expect(env.sentMessages.length).toBe(1);
    var alice = env.getRow("111");
    expect(alice.nag_count).toBe(3);
    expect(alice.status).toBe("dormant");
  });

  it("does not nudge tenants already marked dormant", () => {
    var env = setupNudgeEnv([
      [
        "111",
        "Alice",
        "",
        "sheet-a",
        "dormant",
        new Date(NOW_FIXED.getTime() - 60 * DAY_MS).toISOString(),
        "",
        new Date(NOW_FIXED.getTime() - 30 * DAY_MS).toISOString(),
        new Date(NOW_FIXED.getTime() - 30 * DAY_MS).toISOString(),
        3
      ]
    ]);

    env.mod.nudgeDormantTenants();

    expect(env.sentMessages.length).toBe(0);
  });
});

describe("dormant -> active reactivation", () => {
  it("stampLastForward + reactivateIfDormant flips a dormant tenant back and clears counters", () => {
    var env = setupNudgeEnv([
      [
        "111",
        "Alice",
        "",
        "sheet-a",
        "dormant",
        new Date(NOW_FIXED.getTime() - 60 * DAY_MS).toISOString(),
        "",
        new Date(NOW_FIXED.getTime() - 30 * DAY_MS).toISOString(),
        new Date(NOW_FIXED.getTime() - 8 * DAY_MS).toISOString(),
        3
      ]
    ]);

    // Simulate the extractTransactions success path.
    env.mod.stampLastForward("111", NOW_FIXED);
    env.mod.reactivateIfDormant("111");

    var alice = env.getRow("111");
    expect(alice.status).toBe("active");
    expect(alice.last_forward_at).toBe(NOW_FIXED.toISOString());
    expect(alice.nag_count).toBe(0);
    expect(alice.last_nag_at).toBe("");
  });

  it("subsequent nudgeDormantTenants does not re-nudge the reactivated tenant", () => {
    var env = setupNudgeEnv([
      [
        "111",
        "Alice",
        "",
        "sheet-a",
        "dormant",
        new Date(NOW_FIXED.getTime() - 60 * DAY_MS).toISOString(),
        "",
        new Date(NOW_FIXED.getTime() - 30 * DAY_MS).toISOString(),
        new Date(NOW_FIXED.getTime() - 8 * DAY_MS).toISOString(),
        3
      ]
    ]);
    env.mod.stampLastForward("111", NOW_FIXED);
    env.mod.reactivateIfDormant("111");

    env.mod.nudgeDormantTenants();

    expect(env.sentMessages.length).toBe(0);
    expect(env.getRow("111").nag_count).toBe(0);
  });
});
