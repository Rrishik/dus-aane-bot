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
    [
      "stampLastForward",
      "reactivateIfDormant",
      "loadTenants",
      "invalidateTenantCache",
      "findTenantByChatId",
      "findTenantByEmail",
      "findPendingTenantByEmail",
      "findGroupTenantByChatId",
      "insertGroupTenant",
      "addGroupMember",
      "removeGroupMember",
      "setGroupMembers",
      "findGroupsForMember",
      "getGroupAdminChatId",
      "upsertPendingTenant",
      "activateTenant",
      "sameChatId",
      "TENANT_STATUS",
      "TENANT_COLS",
      "TENANT_CHAT_TYPE",
      "TENANT_HEADERS",
      "TENANT_COL_COUNT"
    ],
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
    expect(s.TENANT_COLS.CHAT_TYPE).toBe(11);
    expect(s.TENANT_COLS.GROUP_MEMBERS).toBe(12);
    expect(s.TENANT_COLS.PRIMARY_CURRENCY).toBe(13);
    expect(s.TENANT_STATUS.DORMANT).toBe("dormant");
  });

  it("legacy 10-column rows default chat_type=personal, primary_currency=INR, group_members=[]", () => {
    var s = setup([["111", "Alice", "", "sheet-a", "active", "2026-04-01T00:00:00.000Z", "", "", "", 0]]);
    var t = s.loadTenants()[0];
    expect(t.chat_type).toBe("personal");
    expect(t.primary_currency).toBe("INR");
    expect(t.group_members).toEqual([]);
  });

  it("13-column rows surface chat_type, group_members (CSV split), and primary_currency", () => {
    var s = setup([
      [
        "g1",
        "Bachelor Pad",
        "",
        "grp-sheet",
        "active",
        "2026-05-01T00:00:00.000Z",
        "",
        "",
        "",
        0,
        "group",
        "111,222,333",
        "USD"
      ]
    ]);
    var t = s.loadTenants()[0];
    expect(t.chat_type).toBe("group");
    expect(t.group_members).toEqual(["111", "222", "333"]);
    expect(t.primary_currency).toBe("USD");
  });
});

describe("group tenant helpers", () => {
  it("insertGroupTenant writes an active group row with admin in notes", () => {
    var s = setup([]);
    s.insertGroupTenant("g1", "Bachelor Pad", "grp-sheet", ["111", "222"], "111");
    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.chat_id).toBe("g1");
    expect(t.chat_type).toBe("group");
    expect(t.status).toBe("active");
    expect(t.sheet_id).toBe("grp-sheet");
    expect(t.group_members).toEqual(["111", "222"]);
    expect(s.getGroupAdminChatId(t)).toBe("111");
  });

  it("findGroupTenantByChatId returns null for personal tenants", () => {
    var s = setup([
      ["111", "Alice", "", "sheet-a", "active", "", "", "", "", 0, "personal", "", "INR"],
      ["g1", "Pad", "", "grp", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]
    ]);
    expect(s.findGroupTenantByChatId("111")).toBe(null);
    expect(s.findGroupTenantByChatId("g1").chat_id).toBe("g1");
  });

  it("addGroupMember dedups and removeGroupMember strips", () => {
    var s = setup([["g1", "Pad", "", "grp", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]]);
    expect(s.addGroupMember("g1", "222")).toBe(true);
    expect(s.addGroupMember("g1", "222")).toBe(false); // dedup
    s.invalidateTenantCache();
    expect(s.findTenantByChatId("g1").group_members).toEqual(["111", "222"]);
    expect(s.removeGroupMember("g1", "111")).toBe(true);
    expect(s.removeGroupMember("g1", "111")).toBe(false); // already gone
    s.invalidateTenantCache();
    expect(s.findTenantByChatId("g1").group_members).toEqual(["222"]);
  });

  it("addGroupMember refuses on a personal tenant", () => {
    var s = setup([["111", "Alice", "", "sheet-a", "active", "", "", "", "", 0, "personal", "", "INR"]]);
    expect(s.addGroupMember("111", "222")).toBe(false);
  });

  it("setGroupMembers overwrites the CSV", () => {
    var s = setup([["g1", "Pad", "", "grp", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"]]);
    expect(s.setGroupMembers("g1", ["333", "444"])).toBe(true);
    s.invalidateTenantCache();
    expect(s.findTenantByChatId("g1").group_members).toEqual(["333", "444"]);
  });

  it("findGroupsForMember enumerates active groups containing the member", () => {
    var s = setup([
      ["g1", "Pad", "", "s1", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"],
      ["g2", "Trip", "", "s2", "active", "", "admin=111", "", "", 0, "group", "111,333", "INR"],
      ["g3", "Old", "", "s3", "disabled", "", "admin=111", "", "", 0, "group", "111", "INR"],
      ["111", "Alice", "", "sa", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var groups = s.findGroupsForMember("111");
    expect(groups.map((g) => g.chat_id).sort()).toEqual(["g1", "g2"]); // g3 is disabled
    expect(s.findGroupsForMember("999")).toEqual([]);
  });

  it("getGroupAdminChatId returns '' when notes lacks admin marker", () => {
    var s = setup([]);
    expect(s.getGroupAdminChatId({ notes: "" })).toBe("");
    expect(s.getGroupAdminChatId({ notes: "some other note" })).toBe("");
    expect(s.getGroupAdminChatId({ notes: "admin=42 extra" })).toBe("42");
  });
});

describe("findTenantByEmail", () => {
  it("only matches PERSONAL tenants — group tenants store member emails for sheet-sharing, not forwarder routing", () => {
    // Group row first (would have been matched before the chat_type filter).
    var s = setup([
      ["-100", "Pad", "alice@x.com,bob@x.com", "grp", "active", "", "admin=111", "", "", 0, "group", "111,222", "INR"],
      ["111", "Alice", "alice@x.com", "sheet-a", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    var t = s.findTenantByEmail("alice@x.com");
    expect(t).not.toBe(null);
    expect(t.chat_id).toBe("111"); // personal, not the group
    expect(t.chat_type).toBe("personal");
  });

  it("returns null when only a group tenant carries the address", () => {
    var s = setup([["-100", "Pad", "alice@x.com", "grp", "active", "", "admin=111", "", "", 0, "group", "111", "INR"]]);
    expect(s.findTenantByEmail("alice@x.com")).toBe(null);
  });
});

describe("findPendingTenantByEmail", () => {
  it("returns the pending tenant whose emails list contains the address", () => {
    var s = setup([
      ["111", "Alice", "alice@x.com", "", "pending", "", "", "", "", 0, "personal", "", "INR"],
      ["222", "Bob", "bob@x.com", "sheet-b", "active", "", "", "", "", 0, "personal", "", "INR"]
    ]);
    expect(s.findPendingTenantByEmail("alice@x.com").chat_id).toBe("111");
  });

  it("ignores active tenants that share an address (only pending ones match)", () => {
    var s = setup([["222", "Bob", "alice@x.com", "sheet-b", "active", "", "", "", "", 0, "personal", "", "INR"]]);
    expect(s.findPendingTenantByEmail("alice@x.com")).toBe(null);
  });

  it("returns null for empty/missing input", () => {
    var s = setup([["111", "Alice", "alice@x.com", "", "pending", "", "", "", "", 0]]);
    expect(s.findPendingTenantByEmail("")).toBe(null);
    expect(s.findPendingTenantByEmail(null)).toBe(null);
  });
});

describe("upsertPendingTenant", () => {
  function freshSetup() {
    // Don't use setup() — it pre-creates the Tenants tab with a 10-col header.
    // We want a clean sandbox so upsertPendingTenant has to provision rows itself.
    var SpreadsheetApp = makeSpreadsheetApp();
    return loadAppsScript(
      ["TenantRegistry.js"],
      [
        "upsertPendingTenant",
        "activateTenant",
        "loadTenants",
        "invalidateTenantCache",
        "findTenantByChatId",
        "TENANT_STATUS",
        "TENANT_CHAT_TYPE",
        "TENANT_HEADERS"
      ],
      { SpreadsheetApp: SpreadsheetApp, ADMIN_SHEET_ID: ADMIN_SHEET_ID }
    );
  }

  it("inserts a new pending row with chat_id, name, email, and INR default", () => {
    var s = freshSetup();
    s.upsertPendingTenant("111", "alice@x.com", "Alice");
    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.chat_id).toBe("111");
    expect(t.name).toBe("Alice");
    expect(t.emails).toEqual(["alice@x.com"]);
    expect(t.status).toBe(s.TENANT_STATUS.PENDING);
    expect(t.chat_type).toBe(s.TENANT_CHAT_TYPE.PERSONAL);
    expect(t.primary_currency).toBe("INR");
  });

  it("merges a second email into an existing pending row (lowercased, deduped)", () => {
    var s = freshSetup();
    s.upsertPendingTenant("111", "alice@x.com", "Alice");
    s.upsertPendingTenant("111", "Alice@X.com", "Alice"); // dup, different case
    s.upsertPendingTenant("111", "alias@x.com", null); // new address, no name change
    s.invalidateTenantCache();
    var t = s.loadTenants()[0];
    expect(t.emails).toEqual(["alice@x.com", "alias@x.com"]);
    expect(t.name).toBe("Alice");
  });

  it("updates the name when the merge call supplies a non-empty name", () => {
    var s = freshSetup();
    s.upsertPendingTenant("111", "alice@x.com", "Alice");
    s.upsertPendingTenant("111", "alice@x.com", "Alice Smith");
    s.invalidateTenantCache();
    expect(s.loadTenants()[0].name).toBe("Alice Smith");
  });
});

describe("activateTenant", () => {
  it("flips a pending tenant to active and stamps sheet_id", () => {
    var s = setup([["111", "Alice", "alice@x.com", "", "pending", "", "", "", "", 0, "personal", "", "INR"]]);
    expect(s.activateTenant("111", "sheet-a")).toBe(true);
    s.invalidateTenantCache();
    var t = s.findTenantByChatId("111");
    expect(t.sheet_id).toBe("sheet-a");
    expect(t.status).toBe(s.TENANT_STATUS.ACTIVE);
  });

  it("returns false when the chat_id has no row", () => {
    var s = setup([]);
    expect(s.activateTenant("999", "sheet-x")).toBe(false);
  });
});

describe("_getOrCreateTenantsTab header migration", () => {
  it("auto-extends a short header row up to the canonical TENANT_HEADERS schema", () => {
    // Pre-seed Tenants tab with the legacy 10-col header (matches what
    // existed before chat_type / group_members / primary_currency landed).
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
    // Existing data row in the old shape — must survive untouched.
    tab.appendRow(["111", "Alice", "alice@x.com", "sheet-a", "active", "2026-04-01T00:00:00.000Z", "", "", "", 0]);

    // Any read triggers _getOrCreateTenantsTab → header top-up.
    var s = loadAppsScript(["TenantRegistry.js"], ["loadTenants", "TENANT_HEADERS"], {
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID
    });
    s.loadTenants();

    var headers = tab.getRange(1, 1, 1, s.TENANT_HEADERS.length).getValues()[0];
    expect(headers).toEqual(s.TENANT_HEADERS);

    // Data row stays untouched on disk; defaults appear via _rowToTenant.
    var t = s.loadTenants()[0];
    expect(t.chat_id).toBe("111");
    expect(t.chat_type).toBe("personal");
    expect(t.primary_currency).toBe("INR");
  });
});

describe("sameChatId", () => {
  it("compares chat ids as strings (cross-type)", () => {
    var s = setup([]);
    expect(s.sameChatId(111, "111")).toBe(true);
    expect(s.sameChatId("111", 222)).toBe(false);
    expect(s.sameChatId(null, "null")).toBe(true); // documents existing String() coercion
  });
});
