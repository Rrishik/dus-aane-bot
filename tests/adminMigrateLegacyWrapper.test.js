// Parameterless-wrapper tests for the legacy migrator.
// These exercise _resolveLegacyAdminOpts (which reads the Tenants tab on
// ADMIN_SHEET_ID and assembles userMap/splitPartners/movePersonal) plus
// the three thin wrappers: adminInspectLegacyAdmin / adminDryRunLegacyAdmin
// / adminCommitLegacyAdmin.
import { describe, it, expect } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "admin-sheet";

// Tenants tab columns (mirrors TenantRegistry.TENANT_COLS, 18 wide).
function tenantRow(opts) {
  return [
    opts.chat_id,
    opts.name,
    opts.emails || "",
    opts.sheet_id || "",
    opts.status || "active",
    "",
    "",
    "",
    "",
    0,
    opts.chat_type || "personal",
    opts.group_members || "",
    "INR",
    0,
    "",
    0,
    0,
    ""
  ];
}

function setupAdminFixture() {
  var SpreadsheetApp = makeSpreadsheetApp();
  // Admin sheet hosts both the Tenants tab AND the legacy group's data
  // (because in this admin's pre-β setup they were the same sheet).
  var admin = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var tenantsTab = admin.insertSheet("Tenants");
  tenantsTab.appendRow([
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
    "ask_cap_hit_count",
    "pin_message_id"
  ]);
  tenantsTab.appendRow(
    tenantRow({
      chat_id: "-4775764963",
      name: "Rish & Aish",
      sheet_id: ADMIN_SHEET_ID,
      chat_type: "group",
      group_members: "1205002551,7200890432"
    })
  );
  tenantsTab.appendRow(
    tenantRow({
      chat_id: "1205002551",
      name: "Rikks",
      emails: "ramenarishik@gmail.com",
      sheet_id: "pers-rikks"
    })
  );
  tenantsTab.appendRow(
    tenantRow({
      chat_id: "7200890432",
      name: "Aishwarya",
      emails: "aishwarya.gurjar98@gmail.com",
      sheet_id: "pers-aish"
    })
  );
  // Pre-seed personal sheet headers so move-target writes are visible.
  ["pers-rikks", "pers-aish"].forEach(function (sid) {
    SpreadsheetApp.openById(sid)
      .getSheets()[0]
      .appendRow([
        "Email Date",
        "Tx Date",
        "Merchant",
        "Amount",
        "Category",
        "Tx Type",
        "User",
        "Message ID",
        "Currency",
        "Group Ref",
        "Group Msg Id"
      ]);
  });
  return SpreadsheetApp;
}

function load(SpreadsheetApp) {
  return loadAppsScript(
    ["TenantRegistry.js", "GroupSheet.js", "AdminHelpers.js"],
    [
      "_resolveLegacyAdminOpts",
      "_resolveLegacyAdminMembers",
      "adminInspectLegacyAdmin",
      "adminDryRunLegacyAdmin",
      "adminBackfillPayerPersonalCopies",
      "loadTenants",
      "invalidateTenantCache"
    ],
    {
      SpreadsheetApp: SpreadsheetApp,
      ADMIN_SHEET_ID: ADMIN_SHEET_ID,
      // Group + personal column stubs needed by GroupSheet/AdminHelpers.
      G_EMAIL_DATE_COLUMN: 1,
      G_TRANSACTION_DATE_COLUMN: 2,
      G_MERCHANT_COLUMN: 3,
      G_AMOUNT_COLUMN: 4,
      G_CURRENCY_COLUMN: 5,
      G_PAID_BY_COLUMN: 6,
      G_SHARE_HOLDER_COLUMN: 7,
      G_SHARE_AMOUNT_COLUMN: 8,
      G_TX_ID_COLUMN: 9,
      G_CATEGORY_COLUMN: 10,
      G_TRANSACTION_TYPE_COLUMN: 11,
      G_MESSAGE_ID_COLUMN: 12,
      G_COL_COUNT: 12,
      MESSAGE_ID_COLUMN: 8
    }
  );
}

describe("_resolveLegacyAdminOpts", () => {
  it("derives userMap + splitPartners + movePersonal from the Tenants tab", () => {
    var SpreadsheetApp = setupAdminFixture();
    var { _resolveLegacyAdminOpts } = load(SpreadsheetApp);

    var opts = _resolveLegacyAdminOpts(false);

    expect(opts.commit).toBe(false);
    expect(opts.splitPartners).toEqual(["1205002551", "7200890432"]);
    expect(opts.userToChatId).toEqual({
      ramenarishik: "1205002551",
      "aishwarya.gurjar98": "7200890432"
    });
    expect(opts.movePersonal).toEqual({
      ramenarishik: "pers-rikks",
      "aishwarya.gurjar98": "pers-aish"
    });
  });

  it("passes commit=true through", () => {
    var SpreadsheetApp = setupAdminFixture();
    var { _resolveLegacyAdminOpts } = load(SpreadsheetApp);
    expect(_resolveLegacyAdminOpts(true).commit).toBe(true);
  });

  it("throws when ADMIN_SHEET_ID isn't registered as a group tenant", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var admin = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var t = admin.insertSheet("Tenants");
    t.appendRow([
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
      "ask_cap_hit_count",
      "pin_message_id"
    ]);
    // Only a personal tenant, no group pointing at ADMIN_SHEET_ID.
    t.appendRow(tenantRow({ chat_id: "111", name: "Solo", sheet_id: ADMIN_SHEET_ID }));

    var { _resolveLegacyAdminOpts } = load(SpreadsheetApp);
    expect(() => _resolveLegacyAdminOpts(false)).toThrow(/No group tenant/);
  });

  it("throws when the group has != 2 members", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var admin = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var t = admin.insertSheet("Tenants");
    t.appendRow([
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
      "ask_cap_hit_count",
      "pin_message_id"
    ]);
    t.appendRow(
      tenantRow({
        chat_id: "-100",
        name: "Trio",
        sheet_id: ADMIN_SHEET_ID,
        chat_type: "group",
        group_members: "1,2,3"
      })
    );

    var { _resolveLegacyAdminOpts } = load(SpreadsheetApp);
    expect(() => _resolveLegacyAdminOpts(false)).toThrow(/exactly 2-member/);
  });
});

describe("adminInspectLegacyAdmin", () => {
  it("dispatches inspect to ADMIN_SHEET_ID", () => {
    var SpreadsheetApp = setupAdminFixture();
    // Add a single unknown-shape row to the legacy data tab (Sheet1 inside admin sheet).
    var admin = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var data = admin.getSheets()[0];
    data.appendRow(["Email Date"]);
    data.appendRow(["", "", "weird", "", "", "", "", "", "", "", ""]);

    var { adminInspectLegacyAdmin } = load(SpreadsheetApp);
    var hits = adminInspectLegacyAdmin();
    expect(hits.length).toBe(1);
    expect(hits[0].cells[2]).toBe("weird");
  });
});

// Helper for backfill tests: append a backup tab to the admin sheet shaped
// like the migrator's snapshot, then call the backfill helper.
function preBetaSplitRow(merchant, amount, user, msgId) {
  return [
    "5/1/2026",
    "5/1/2026",
    merchant,
    amount,
    "Food",
    "Debit",
    user,
    "Split",
    msgId,
    "INR",
    "https://mail.google.com/..."
  ];
}
function preBetaPartnerRow(merchant, amount, user, msgId) {
  return [
    "5/1/2026",
    "5/1/2026",
    merchant,
    amount,
    "Shopping",
    "Debit",
    user,
    "Partner",
    msgId,
    "INR",
    "https://mail.google.com/..."
  ];
}
function preBetaPersonalRow(merchant, amount, user, msgId) {
  return [
    "5/1/2026",
    "5/1/2026",
    merchant,
    amount,
    "Food",
    "Debit",
    user,
    "Personal",
    msgId,
    "INR",
    "https://mail.google.com/..."
  ];
}

function setupBackupFixture(rows, backupName) {
  var SpreadsheetApp = setupAdminFixture();
  var admin = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var backup = admin.insertSheet(backupName || "Pre-β Backup 2026-06-07");
  backup.appendRow(["Email Date"]); // header (content immaterial for classify)
  rows.forEach(function (r) {
    backup.appendRow(r);
  });
  return SpreadsheetApp;
}

describe("adminBackfillPayerPersonalCopies", () => {
  it("dry run: counts Split + Partner rows, writes nothing", () => {
    var SpreadsheetApp = setupBackupFixture([
      preBetaSplitRow("Mygate", 1000, "ramenarishik", "m1"),
      preBetaSplitRow("Coffee", 600, "aishwarya.gurjar98", "m2"),
      preBetaPartnerRow("Lalitha", 17677, "aishwarya.gurjar98", "m3"),
      preBetaPersonalRow("Lunch", 200, "ramenarishik", "m4") // ignored
    ]);
    var { adminBackfillPayerPersonalCopies } = load(SpreadsheetApp);

    var stats = adminBackfillPayerPersonalCopies();

    expect(stats.scanned).toBe(3); // Split + Split + Partner (Personal ignored)
    expect(stats.queued).toBe(3);
    expect(stats.appended).toBe(0); // dry run
    expect(stats.unresolved).toBe(0);
    // No writes to personal sheets.
    expect(SpreadsheetApp.openById("pers-rikks").getSheets()[0].getLastRow()).toBe(1);
    expect(SpreadsheetApp.openById("pers-aish").getSheets()[0].getLastRow()).toBe(1);
  });

  it("commit: writes payer-side rows with group_ref to each payer's personal sheet", () => {
    var SpreadsheetApp = setupBackupFixture([
      preBetaSplitRow("Mygate", 1000, "ramenarishik", "m1"),
      preBetaPartnerRow("Lalitha", 17677, "aishwarya.gurjar98", "m2")
    ]);
    var { adminBackfillPayerPersonalCopies } = load(SpreadsheetApp);

    var stats = adminBackfillPayerPersonalCopies({ commit: true });

    expect(stats.appended).toBe(2);
    expect(stats.skippedDup).toBe(0);
    var rikks = SpreadsheetApp.openById("pers-rikks").getSheets()[0];
    var aish = SpreadsheetApp.openById("pers-aish").getSheets()[0];
    // Rikks paid the Mygate split (row 2 in backup) → 1 row in rikks sheet.
    expect(rikks.getLastRow()).toBe(2);
    expect(rikks.getRange(2, 3).getValue()).toBe("Mygate");
    expect(rikks.getRange(2, 4).getValue()).toBe(1000); // full amount
    expect(rikks.getRange(2, 8).getValue()).toBe("m1");
    expect(rikks.getRange(2, 10).getValue()).toBe("-4775764963:legacy-2"); // group ref
    // Aishwarya paid the Lalitha partner row (row 3 in backup) → 1 row in aish sheet.
    expect(aish.getLastRow()).toBe(2);
    expect(aish.getRange(2, 3).getValue()).toBe("Lalitha");
    expect(aish.getRange(2, 4).getValue()).toBe(17677);
    expect(aish.getRange(2, 10).getValue()).toBe("-4775764963:legacy-3");
  });

  it("is idempotent — re-running skips rows that already have the Message ID", () => {
    var SpreadsheetApp = setupBackupFixture([preBetaSplitRow("Mygate", 1000, "ramenarishik", "m1")]);
    var { adminBackfillPayerPersonalCopies } = load(SpreadsheetApp);

    var first = adminBackfillPayerPersonalCopies({ commit: true });
    expect(first.appended).toBe(1);

    var second = adminBackfillPayerPersonalCopies({ commit: true });
    expect(second.appended).toBe(0);
    expect(second.skippedDup).toBe(1);
    expect(SpreadsheetApp.openById("pers-rikks").getSheets()[0].getLastRow()).toBe(2);
  });

  it("unresolved User cell falls back to splitPartners[0] and warns", () => {
    var SpreadsheetApp = setupBackupFixture([preBetaSplitRow("X", 500, "stranger", "m1")]);
    var { adminBackfillPayerPersonalCopies } = load(SpreadsheetApp);
    var stats = adminBackfillPayerPersonalCopies({ commit: true });

    expect(stats.unresolved).toBe(1);
    expect(stats.appended).toBe(1);
    // Default payer = first member = 1205002551 (rikks).
    var rikks = SpreadsheetApp.openById("pers-rikks").getSheets()[0];
    expect(rikks.getLastRow()).toBe(2);
    expect(rikks.getRange(2, 3).getValue()).toBe("X");
  });

  it("throws when no `Pre-β Backup *` tab exists", () => {
    var SpreadsheetApp = setupAdminFixture(); // no backup tab added
    var { adminBackfillPayerPersonalCopies } = load(SpreadsheetApp);
    expect(() => adminBackfillPayerPersonalCopies()).toThrow(/no `Pre-β Backup/);
  });

  it("picks the latest backup when multiple exist (lexicographic max)", () => {
    var SpreadsheetApp = setupBackupFixture(
      [preBetaSplitRow("Old", 100, "ramenarishik", "m1")],
      "Pre-β Backup 2026-06-06"
    );
    var admin = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var newer = admin.insertSheet("Pre-β Backup 2026-06-07");
    newer.appendRow(["Email Date"]);
    newer.appendRow(preBetaSplitRow("New", 200, "ramenarishik", "m2"));

    var { adminBackfillPayerPersonalCopies } = load(SpreadsheetApp);
    var stats = adminBackfillPayerPersonalCopies({ commit: true });

    // Only the newer tab's row is processed.
    expect(stats.appended).toBe(1);
    var rikks = SpreadsheetApp.openById("pers-rikks").getSheets()[0];
    expect(rikks.getRange(2, 3).getValue()).toBe("New");
  });
});
