import { describe, it, expect } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "admin-sheet";

// Set up a fresh in-memory Tenants sheet and load the script against it.
// Each test gets its own isolated sandbox + sheet store.
function setup(rows) {
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
  return loadAppsScript(
    ["TenantRegistry.js"],
    ["stampLastForward", "reactivateIfDormant", "loadTenants", "invalidateTenantCache", "TENANT_STATUS", "TENANT_COLS"],
    { SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID }
  );
}

describe("stampLastForward", () => {
  it("writes ISO timestamp into LAST_FORWARD_AT for the matching tenant", () => {
    var s = setup([
      ["111", "Alice", "alice@gmail.com", "sheet-a", "active", "2026-04-01T00:00:00.000Z", "", "", "", 0],
      ["222", "Bob", "bob@gmail.com", "sheet-b", "active", "2026-04-01T00:00:00.000Z", "", "", "", 0]
    ]);

    var now = new Date("2026-04-28T12:00:00.000Z");
    expect(s.stampLastForward("222", now)).toBe(true);

    s.invalidateTenantCache();
    var tenants = s.loadTenants();
    expect(tenants.find((t) => t.chat_id === "222").last_forward_at).toBe("2026-04-28T12:00:00.000Z");
    expect(tenants.find((t) => t.chat_id === "111").last_forward_at).toBe(""); // untouched
  });

  it("returns false when chat_id not found", () => {
    var s = setup([["111", "Alice", "", "sheet-a", "active", "", "", "", "", 0]]);
    expect(s.stampLastForward("999", new Date())).toBe(false);
  });

  it("uses current time when `now` not provided", () => {
    var s = setup([["111", "Alice", "", "sheet-a", "active", "", "", "", "", 0]]);
    var before = Date.now();
    s.stampLastForward("111");
    s.invalidateTenantCache();
    var stamped = new Date(s.loadTenants()[0].last_forward_at).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it("skips the write when existing stamp is within the freshness window", () => {
    var now = new Date("2026-04-28T12:00:00.000Z");
    var twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    var s = setup([["111", "Alice", "", "sheet-a", "active", "", "", twoDaysAgo, "", 0]]);

    expect(s.stampLastForward("111", now)).toBe(false);
    s.invalidateTenantCache();
    expect(s.loadTenants()[0].last_forward_at).toBe(twoDaysAgo); // unchanged
  });

  it("writes when existing stamp is older than the freshness window", () => {
    var now = new Date("2026-04-28T12:00:00.000Z");
    var fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    var s = setup([["111", "Alice", "", "sheet-a", "active", "", "", fiveDaysAgo, "", 0]]);

    expect(s.stampLastForward("111", now)).toBe(true);
    s.invalidateTenantCache();
    expect(s.loadTenants()[0].last_forward_at).toBe(now.toISOString());
  });

  it("writes when existing stamp is empty regardless of freshness rule", () => {
    var now = new Date("2026-04-28T12:00:00.000Z");
    var s = setup([["111", "Alice", "", "sheet-a", "active", "", "", "", "", 0]]);

    expect(s.stampLastForward("111", now)).toBe(true);
    s.invalidateTenantCache();
    expect(s.loadTenants()[0].last_forward_at).toBe(now.toISOString());
  });
});

describe("reactivateIfDormant", () => {
  it("flips dormant -> active and clears nag counters", () => {
    var s = setup([
      ["111", "Alice", "", "sheet-a", "dormant", "2026-04-01T00:00:00.000Z", "", "", "2026-04-20T00:00:00.000Z", 3]
    ]);

    expect(s.reactivateIfDormant("111")).toBe(true);

    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.status).toBe(s.TENANT_STATUS.ACTIVE);
    expect(t.last_nag_at).toBe("");
    expect(t.nag_count).toBe(0);
  });

  it("is a no-op for an active tenant", () => {
    var s = setup([["111", "Alice", "", "sheet-a", "active", "", "", "", "", 0]]);
    expect(s.reactivateIfDormant("111")).toBe(false);
  });

  it("is a no-op for pending or disabled tenants", () => {
    var s = setup([
      ["111", "Alice", "", "", "pending", "", "", "", "", 0],
      ["222", "Bob", "", "sheet-b", "disabled", "", "", "", "", 0]
    ]);
    expect(s.reactivateIfDormant("111")).toBe(false);
    expect(s.reactivateIfDormant("222")).toBe(false);
  });

  it("returns false when chat_id not found", () => {
    var s = setup([["111", "Alice", "", "sheet-a", "dormant", "", "", "", "", 1]]);
    expect(s.reactivateIfDormant("999")).toBe(false);
  });
});

describe("schema", () => {
  it("exposes the new column constants and DORMANT status", () => {
    var s = setup([]);
    expect(s.TENANT_COLS.LAST_FORWARD_AT).toBe(8);
    expect(s.TENANT_COLS.LAST_NAG_AT).toBe(9);
    expect(s.TENANT_COLS.NAG_COUNT).toBe(10);
    expect(s.TENANT_STATUS.DORMANT).toBe("dormant");
  });
});
