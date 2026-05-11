import { describe, it, expect, beforeEach } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "admin-sheet";
const IST_TIMEZONE = "Asia/Kolkata";
const FREE_ASK_LIMIT = 5;

// Minimal Utilities.formatDate stub that handles IST ("Asia/Kolkata") by
// shifting the UTC instant +5:30 and reading the resulting "UTC" components.
// Only supports the format strings Quota.js uses: "yyyy-MM-dd" and "HH:mm:ss".
function makeUtilities() {
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  return {
    formatDate(date, tz, fmt) {
      if (tz !== "Asia/Kolkata") throw new Error("test stub only supports Asia/Kolkata, got " + tz);
      var shifted = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
      return fmt
        .replace("yyyy", shifted.getUTCFullYear())
        .replace("MM", pad(shifted.getUTCMonth() + 1))
        .replace("dd", pad(shifted.getUTCDate()))
        .replace("HH", pad(shifted.getUTCHours()))
        .replace("mm", pad(shifted.getUTCMinutes()))
        .replace("ss", pad(shifted.getUTCSeconds()));
    }
  };
}

// LockService stub that always succeeds — quota tests don't exercise
// contention, only the read-modify-write logic inside the critical section.
function makeLockService() {
  var lock = {
    tryLock: () => true,
    releaseLock: () => {}
  };
  return { getDocumentLock: () => lock };
}

// Standard tenant column headers + 4 quota columns.
var TENANT_HEADERS = [
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
  "primary_currency",
  "ask_used_today",
  "ask_used_date",
  "ask_lifetime_count",
  "ask_cap_hit_count"
];

// Build a tenant row with optional quota field overrides. Defaults to a clean
// row with zero counters and empty ask_used_date.
function tenantRow(chatId, overrides) {
  overrides = overrides || {};
  return [
    String(chatId),
    overrides.name || "",
    "",
    "sheet-" + chatId,
    "active",
    "",
    "",
    "",
    "",
    0,
    "personal",
    "",
    "INR",
    overrides.ask_used_today == null ? 0 : overrides.ask_used_today,
    overrides.ask_used_date == null ? "" : overrides.ask_used_date,
    overrides.ask_lifetime_count == null ? 0 : overrides.ask_lifetime_count,
    overrides.ask_cap_hit_count == null ? 0 : overrides.ask_cap_hit_count
  ];
}

function setup(rows, options) {
  options = options || {};
  var SpreadsheetApp = makeSpreadsheetApp();
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var tab = ss.insertSheet("Tenants");
  // If `headers` override is provided, use it (lets us simulate legacy
  // sheets missing the new quota columns).
  tab.appendRow(options.headers || TENANT_HEADERS);
  rows.forEach(function (r) {
    tab.appendRow(r);
  });
  return loadAppsScript(
    ["TenantRegistry.js", "Quota.js"],
    [
      "consumeAskQuota",
      "refundAskQuota",
      "formatTimeUntilIstMidnight",
      "formatAskCapHitMessage",
      "buildAskCapHitKeyboard",
      "loadTenants",
      "invalidateTenantCache",
      "TENANT_COLS"
    ],
    {
      SpreadsheetApp: SpreadsheetApp,
      LockService: makeLockService(),
      Utilities: makeUtilities(),
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      FREE_ASK_LIMIT: FREE_ASK_LIMIT,
      IST_TIMEZONE: IST_TIMEZONE
    }
  );
}

// 2026-04-28 12:00:00 UTC === 2026-04-28 17:30 IST → IST date "2026-04-28"
var NOON_UTC = new Date("2026-04-28T12:00:00.000Z");
// 2026-04-28 19:00:00 UTC === 2026-04-29 00:30 IST → IST date "2026-04-29"
var LATE_UTC = new Date("2026-04-28T19:00:00.000Z");

describe("consumeAskQuota", () => {
  it("allows a fresh tenant and increments usedToday + lifetime", () => {
    var s = setup([tenantRow("111")]);
    var result = s.consumeAskQuota("111", NOON_UTC);
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(1);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(1);
    expect(t.ask_used_date).toBe("2026-04-28");
    expect(t.ask_lifetime_count).toBe(1);
    expect(t.ask_cap_hit_count).toBe(0);
  });

  it("blocks once the day's cap is reached and surfaces resetInMinutes", () => {
    var s = setup([
      tenantRow("111", { ask_used_today: FREE_ASK_LIMIT, ask_used_date: "2026-04-28", ask_lifetime_count: 12 })
    ]);
    var result = s.consumeAskQuota("111", NOON_UTC);
    expect(result.allowed).toBe(false);
    expect(result.usedToday).toBe(FREE_ASK_LIMIT);
    // Noon UTC = 17:30 IST → 6h 30m to midnight = 390 minutes.
    expect(result.resetInMinutes).toBe(390);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    // Blocked attempt doesn't increment used or lifetime.
    expect(t.ask_used_today).toBe(FREE_ASK_LIMIT);
    expect(t.ask_lifetime_count).toBe(12);
  });

  it("resets the per-day counter when ask_used_date is from a previous IST day", () => {
    var s = setup([
      tenantRow("111", {
        ask_used_today: FREE_ASK_LIMIT,
        ask_used_date: "2026-04-27", // yesterday in IST
        ask_lifetime_count: 30,
        ask_cap_hit_count: 4
      })
    ]);
    var result = s.consumeAskQuota("111", NOON_UTC);
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(1);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(1);
    expect(t.ask_used_date).toBe("2026-04-28");
    expect(t.ask_lifetime_count).toBe(31); // lifetime keeps climbing
    expect(t.ask_cap_hit_count).toBe(4); // unchanged — not at cap today yet
  });

  it("handles IST midnight rollover (UTC late evening → IST next day)", () => {
    // ask_used_date is the IST date matching NOON_UTC (2026-04-28). LATE_UTC
    // falls into the next IST day (2026-04-29), so the counter should reset.
    var s = setup([
      tenantRow("111", {
        ask_used_today: 3,
        ask_used_date: "2026-04-28",
        ask_lifetime_count: 8
      })
    ]);
    var result = s.consumeAskQuota("111", LATE_UTC);
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(1);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(1);
    expect(t.ask_used_date).toBe("2026-04-29");
    expect(t.ask_lifetime_count).toBe(9);
  });

  it("increments cap_hit_count exactly on the 4→5 transition (the 5th ask of the day)", () => {
    var s = setup([
      tenantRow("111", {
        ask_used_today: FREE_ASK_LIMIT - 1,
        ask_used_date: "2026-04-28",
        ask_lifetime_count: 4,
        ask_cap_hit_count: 0
      })
    ]);
    var result = s.consumeAskQuota("111", NOON_UTC);
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(FREE_ASK_LIMIT);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_cap_hit_count).toBe(1);
  });

  it("does not increment cap_hit_count on earlier asks of the day", () => {
    var s = setup([tenantRow("111", { ask_used_today: 2, ask_used_date: "2026-04-28", ask_cap_hit_count: 0 })]);
    s.consumeAskQuota("111", NOON_UTC);
    s.invalidateTenantCache();
    expect(s.loadTenants()[0].ask_cap_hit_count).toBe(0);
  });

  it("fails open (allowed=true, no writes) when the tenant row is missing", () => {
    var s = setup([tenantRow("111")]);
    var result = s.consumeAskQuota("999", NOON_UTC);
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(0);
    // Existing row is untouched.
    s.invalidateTenantCache();
    expect(s.loadTenants()[0].ask_used_today).toBe(0);
  });

  it("treats older rows missing the quota columns as fresh 0/empty", () => {
    // Legacy schema: 13-column headers, only the first 13 row values present.
    var legacyHeaders = TENANT_HEADERS.slice(0, 13);
    var legacyRow = ["111", "", "", "sheet-111", "active", "", "", "", "", 0, "personal", "", "INR"];
    var s = setup([legacyRow], { headers: legacyHeaders });

    var result = s.consumeAskQuota("111", NOON_UTC);
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(1);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(1);
    expect(t.ask_used_date).toBe("2026-04-28");
    expect(t.ask_lifetime_count).toBe(1);
  });
});

describe("refundAskQuota", () => {
  it("decrements ask_used_today and ask_lifetime_count after a same-day consume", () => {
    var s = setup([tenantRow("111")]);
    s.consumeAskQuota("111", NOON_UTC);
    s.refundAskQuota("111", NOON_UTC);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(0);
    expect(t.ask_lifetime_count).toBe(0);
    expect(t.ask_cap_hit_count).toBe(0);
  });

  it("also decrements cap_hit_count when refunding a call that took the user to the cap", () => {
    var s = setup([
      tenantRow("111", {
        ask_used_today: FREE_ASK_LIMIT - 1,
        ask_used_date: "2026-04-28",
        ask_lifetime_count: 4,
        ask_cap_hit_count: 0
      })
    ]);
    s.consumeAskQuota("111", NOON_UTC); // 4 → 5, cap_hit_count 0 → 1
    s.refundAskQuota("111", NOON_UTC); // 5 → 4, cap_hit_count 1 → 0

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(FREE_ASK_LIMIT - 1);
    expect(t.ask_lifetime_count).toBe(4);
    expect(t.ask_cap_hit_count).toBe(0);
  });

  it("is a no-op when ask_used_date is from a prior IST day", () => {
    var s = setup([
      tenantRow("111", {
        ask_used_today: 3,
        ask_used_date: "2026-04-27",
        ask_lifetime_count: 10
      })
    ]);
    s.refundAskQuota("111", NOON_UTC);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(3);
    expect(t.ask_lifetime_count).toBe(10);
  });

  it("does not push counters below zero on a double refund", () => {
    var s = setup([tenantRow("111", { ask_used_today: 1, ask_used_date: "2026-04-28", ask_lifetime_count: 1 })]);
    s.refundAskQuota("111", NOON_UTC);
    s.refundAskQuota("111", NOON_UTC); // already at 0; should no-op

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.ask_used_today).toBe(0);
    expect(t.ask_lifetime_count).toBe(0);
  });
});

describe("formatTimeUntilIstMidnight", () => {
  it("formats hours and minutes from IST wall clock", () => {
    // 12:00 UTC = 17:30 IST → 6h 30m to midnight IST.
    expect(formatNow(NOON_UTC)).toBe("6h 30m");
  });

  it("hides minutes when zero", () => {
    // 18:00 UTC = 23:30 IST → exactly 30m. Use slightly earlier time to land
    // on a clean hour: 12:30 UTC = 18:00 IST → 6h to midnight.
    var t = new Date("2026-04-28T12:30:00.000Z");
    expect(formatNow(t)).toBe("6h");
  });

  it("hides hours when under one hour remains", () => {
    // 18:31 UTC = 00:01 IST next day → 23h 59m. So use 18:01 UTC = 23:31 IST → 29m.
    var t = new Date("2026-04-28T18:01:00.000Z");
    expect(formatNow(t)).toBe("29m");
  });

  // Helper: ad-hoc setup to call formatTimeUntilIstMidnight in isolation.
  function formatNow(now) {
    var s = setup([tenantRow("111")]);
    return s.formatTimeUntilIstMidnight(now);
  }
});

describe("formatAskCapHitMessage", () => {
  it("includes the limit and reset window", () => {
    var s = setup([tenantRow("111")]);
    var msg = s.formatAskCapHitMessage(NOON_UTC);
    expect(msg).toContain("Daily /ask limit reached");
    expect(msg).toContain(String(FREE_ASK_LIMIT) + " /ask questions");
    expect(msg).toContain("6h 30m");
  });
});

describe("buildAskCapHitKeyboard", () => {
  it("returns a single inline button with premium_info callback", () => {
    var s = setup([tenantRow("111")]);
    var kb = s.buildAskCapHitKeyboard();
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toHaveLength(1);
    expect(kb.inline_keyboard[0][0].callback_data).toBe("premium_info");
  });
});
