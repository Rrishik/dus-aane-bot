import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

// Loads only what the migration helper needs — no Drive, no Telegram.
function load(SpreadsheetApp) {
  return loadAppsScript(
    ["GroupSheet.js", "AdminHelpers.js"],
    [
      "adminMigrateLegacyGroupSheet",
      "adminInspectLegacyGroupSheet",
      "_classifyLegacyGroupRow",
      "_convertPreBetaRow",
      "_convertPreBetaSplitRow",
      "GROUP_SHEET_HEADERS"
    ],
    {
      SpreadsheetApp: SpreadsheetApp,
      // Stubs so the GROUP_SHEET_HEADERS table can construct.
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
      G_COL_COUNT: 12
    }
  );
}

// Legacy pre-β personal row:
// [emailDate, txDate, merchant, amount, category, txType, user, split, msgId, currency, link]
function preBetaRow(merchant, amount, category, user, split) {
  return [
    "5/1/2026 18:40:59",
    "2026-05-01",
    merchant,
    amount,
    category,
    "Debit",
    user,
    split,
    "19de3aa261cce063",
    "INR",
    "https://mail.google.com/..."
  ];
}

// β row (already in the correct shape):
// [emailDate, txDate, merchant, amount, currency, paidBy, holder, share, txId, category, txType, msgId]
function betaRow(merchant, amount, payer, holder, share) {
  return [
    "5/9/2026 17:16:29",
    "5/9/2026",
    merchant,
    amount,
    "INR",
    payer,
    holder,
    share,
    "c8ef59e4-d0eb-4795-ad71-fakefake",
    "Shopping",
    "Debit",
    ""
  ];
}

describe("_classifyLegacyGroupRow", () => {
  it("identifies β rows by currency-code col 5 + numeric share col 8", () => {
    var { _classifyLegacyGroupRow } = load(makeSpreadsheetApp());
    expect(_classifyLegacyGroupRow(betaRow("Anurag", 700, "1205002551", "1205002551", 350))).toBe("beta");
    expect(_classifyLegacyGroupRow(betaRow("Swiggy", 695, "111", "222", 347.5))).toBe("beta");
  });

  it("identifies pre-β personal rows by col 8 = 'Personal'", () => {
    var { _classifyLegacyGroupRow } = load(makeSpreadsheetApp());
    expect(_classifyLegacyGroupRow(preBetaRow("Unknown", 600, "Bills & Utilities", "ramen", "Personal"))).toBe(
      "pre-beta-personal"
    );
  });

  it("identifies pre-β split rows by col 8 = 'Split'", () => {
    var { _classifyLegacyGroupRow } = load(makeSpreadsheetApp());
    expect(_classifyLegacyGroupRow(preBetaRow("Mygate", 1000, "Bills & Utilities", "aishwarya", "Split"))).toBe(
      "pre-beta-split"
    );
  });

  it("flags everything else as unknown", () => {
    var { _classifyLegacyGroupRow } = load(makeSpreadsheetApp());
    // Empty row.
    expect(_classifyLegacyGroupRow(["", "", "", "", "", "", "", "", "", "", ""])).toBe("unknown");
    // Mixed garbage.
    expect(_classifyLegacyGroupRow(["x", "y", "z", 1, "Food", "Debit", "u", "??", "m", "INR", "l"])).toBe("unknown");
  });
});

describe("_convertPreBetaRow", () => {
  it("emits a self-share β row (payer === holder) preserving amount + metadata", () => {
    var { _convertPreBetaRow } = load(makeSpreadsheetApp());
    var src = preBetaRow("Mygate", 1000, "Bills & Utilities", "aishwarya", "Split");
    var out = _convertPreBetaRow(src, 495, { aishwarya: "222" });
    expect(out).toHaveLength(12);
    expect(out[3]).toBe(1000); // amount
    expect(out[4]).toBe("INR"); // currency
    expect(out[5]).toBe("222"); // paid by (resolved via map)
    expect(out[6]).toBe("222"); // share holder (== payer → no debt)
    expect(out[7]).toBe(1000); // full self-share
    expect(out[8]).toBe("legacy-495"); // stable tx id
    expect(out[9]).toBe("Bills & Utilities");
    expect(out[10]).toBe("Debit");
    expect(out[11]).toBe("19de3aa261cce063"); // original Gmail msg id
  });

  it("falls back to the raw User string when not in the map", () => {
    var { _convertPreBetaRow } = load(makeSpreadsheetApp());
    var src = preBetaRow("Unknown", 600, "Bills & Utilities", "ramen", "Personal");
    var out = _convertPreBetaRow(src, 494, {});
    expect(out[5]).toBe("ramen");
    expect(out[6]).toBe("ramen");
  });

  it("defaults currency to INR when col 9 is empty", () => {
    var { _convertPreBetaRow } = load(makeSpreadsheetApp());
    var src = preBetaRow("X", 50, "Food", "u", "Personal");
    src[9] = ""; // wipe currency
    var out = _convertPreBetaRow(src, 1, {});
    expect(out[4]).toBe("INR");
  });
});

describe("_convertPreBetaSplitRow", () => {
  it("expands one Split row into two β rows (payer self + partner share)", () => {
    var { _convertPreBetaSplitRow } = load(makeSpreadsheetApp());
    var src = preBetaRow("Mygate", 1000, "Bills & Utilities", "aishwarya", "Split");
    var out = _convertPreBetaSplitRow(src, 495, { aishwarya: "222", ramen: "111" }, ["111", "222"]);
    expect(out).toHaveLength(2);
    // Payer resolved to "222" via the userMap.
    expect(out[0][5]).toBe("222"); // payer
    expect(out[0][6]).toBe("222"); // payer's own share (self, no debt)
    expect(out[0][7]).toBe(500);
    expect(out[1][5]).toBe("222"); // same payer on both rows
    expect(out[1][6]).toBe("111"); // partner = the other chat_id
    expect(out[1][7]).toBe(500);
    // Same tx id ties the two rows.
    expect(out[0][8]).toBe(out[1][8]);
    expect(out[0][8]).toBe("legacy-495");
    // Amount preserved on each row's "amount" column (full tx amount).
    expect(out[0][3]).toBe(1000);
    expect(out[1][3]).toBe(1000);
  });

  it("falls back to splitPartners[0] as payer when the User cell maps to neither partner", () => {
    var { _convertPreBetaSplitRow } = load(makeSpreadsheetApp());
    var src = preBetaRow("X", 200, "Food", "stranger", "Split");
    var out = _convertPreBetaSplitRow(src, 1, {}, ["111", "222"]);
    expect(out[0][5]).toBe("111"); // default payer
    expect(out[1][6]).toBe("222"); // partner
  });

  it("rounds odd amounts to 2dp halves", () => {
    var { _convertPreBetaSplitRow } = load(makeSpreadsheetApp());
    var src = preBetaRow("Coffee", 333.33, "Food", "ramen", "Split");
    var out = _convertPreBetaSplitRow(src, 7, { ramen: "111" }, ["111", "222"]);
    expect(out[0][7]).toBe(166.67);
    expect(out[1][7]).toBe(166.67);
  });
});

describe("adminMigrateLegacyGroupSheet — dry run", () => {
  it("reports counts and writes nothing", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    // Legacy header (matches the screenshot).
    sheet.appendRow([
      "Email Date",
      "Transaction Date",
      "Merchant",
      "Amount",
      "Category",
      "Transaction Type",
      "User",
      "Split",
      "Message ID",
      "Currency",
      "Link"
    ]);
    sheet.appendRow(preBetaRow("Unknown", 600, "Bills & Utilities", "ramen", "Personal"));
    sheet.appendRow(preBetaRow("Mygate", 1000, "Bills & Utilities", "aishwarya", "Split"));
    sheet.appendRow(betaRow("Anurag", 700, "1205002551", "1205002551", 350));
    sheet.appendRow(betaRow("Swiggy", 695, "111", "222", 347.5));

    var { adminMigrateLegacyGroupSheet } = load(SpreadsheetApp);
    var stats = adminMigrateLegacyGroupSheet("g1");

    expect(stats).toEqual({
      beta: 2,
      preBetaPersonal: 1,
      preBetaPersonalDropped: 0,
      preBetaSplit: 1,
      splitExpanded: 0,
      unknown: 0
    });
    // Header untouched.
    expect(sheet.getRange(1, 5).getValue()).toBe("Category");
    // No backup tab created on dry run.
    expect(ss.getSheetByName(/Pre-β Backup/)).toBe(null);
    expect(ss.getSheets().length).toBe(1);
  });
});

describe("adminMigrateLegacyGroupSheet — commit", () => {
  it("backs up the original tab, rewrites header to β, and converts pre-β rows in place", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      "Email Date",
      "Transaction Date",
      "Merchant",
      "Amount",
      "Category",
      "Transaction Type",
      "User",
      "Split",
      "Message ID",
      "Currency",
      "Link"
    ]);
    sheet.appendRow(preBetaRow("Unknown", 600, "Bills & Utilities", "ramen", "Personal"));
    sheet.appendRow(betaRow("Anurag", 700, "1205002551", "1205002551", 350));

    var { adminMigrateLegacyGroupSheet, GROUP_SHEET_HEADERS } = load(SpreadsheetApp);
    var stats = adminMigrateLegacyGroupSheet("g1", { commit: true, userToChatId: { ramen: "111" } });

    expect(stats.beta).toBe(1);
    expect(stats.preBetaPersonal).toBe(1);

    // Backup tab present + has the original header.
    expect(ss.getSheets().length).toBe(2);
    var backup = ss.getSheets()[1];
    expect(backup.getName()).toMatch(/Pre-β Backup/);
    expect(backup.getRange(1, 5).getValue()).toBe("Category");

    // Active sheet now has the β header.
    expect(sheet.getRange(1, 1, 1, GROUP_SHEET_HEADERS.length).getValues()[0]).toEqual(GROUP_SHEET_HEADERS);

    // Row 2 = converted personal → self-share β row.
    var row2 = sheet.getRange(2, 1, 1, 12).getValues()[0];
    expect(row2[3]).toBe(600); // amount preserved
    expect(row2[5]).toBe("111"); // payer resolved via userToChatId map
    expect(row2[6]).toBe("111"); // holder == payer
    expect(row2[7]).toBe(600); // full self-share
    expect(row2[8]).toMatch(/^legacy-/); // synthetic tx id

    // Row 3 = β row preserved verbatim.
    var row3 = sheet.getRange(3, 1, 1, 12).getValues()[0];
    expect(row3[3]).toBe(700); // amount
    expect(row3[5]).toBe("1205002551"); // payer
    expect(row3[7]).toBe(350); // share
  });

  it("appends a counter to backup name when one already exists for today", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    sheet.appendRow(["Email Date"]); // minimal header
    sheet.appendRow(betaRow("X", 100, "111", "222", 50));
    // Pre-existing backup tab from earlier run.
    var stamp = new Date().toISOString().slice(0, 10);
    ss.insertSheet("Pre-β Backup " + stamp);

    var { adminMigrateLegacyGroupSheet } = load(SpreadsheetApp);
    adminMigrateLegacyGroupSheet("g1", { commit: true });

    expect(ss.getSheetByName("Pre-β Backup " + stamp + " (2)")).not.toBe(null);
  });

  it("splitPartners option: pre-β Split rows expand to 2 β rows with shared tx_id", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      "Email Date",
      "Transaction Date",
      "Merchant",
      "Amount",
      "Category",
      "Transaction Type",
      "User",
      "Split",
      "Message ID",
      "Currency",
      "Link"
    ]);
    // Two Split rows + one Personal + one already-β row.
    sheet.appendRow(preBetaRow("Mygate", 1000, "Bills", "aishwarya", "Split"));
    sheet.appendRow(preBetaRow("Dinner", 800, "Food", "ramen", "Split"));
    sheet.appendRow(preBetaRow("Unknown", 600, "Bills", "ramen", "Personal"));
    sheet.appendRow(betaRow("Anurag", 700, "1205002551", "1205002551", 350));

    var { adminMigrateLegacyGroupSheet, GROUP_SHEET_HEADERS } = load(SpreadsheetApp);
    var stats = adminMigrateLegacyGroupSheet("g1", {
      commit: true,
      userToChatId: { aishwarya: "222", ramen: "111" },
      splitPartners: ["111", "222"]
    });

    expect(stats.beta).toBe(1);
    expect(stats.preBetaPersonal).toBe(1);
    expect(stats.preBetaSplit).toBe(2);
    expect(stats.splitExpanded).toBe(2);

    // Output: 2 (Split×2 expanded) + 2 (1 Split→2 expanded) + 1 (Personal) + 1 (β) = 6 rows.
    // Layout: rows 2-3 = first Split expansion, 4-5 = second, 6 = personal, 7 = β.
    expect(sheet.getLastRow()).toBe(7);
    expect(sheet.getRange(1, 1, 1, GROUP_SHEET_HEADERS.length).getValues()[0]).toEqual(GROUP_SHEET_HEADERS);

    // First Split (Mygate, payer=aishwarya=222): two rows with same tx id.
    var r2 = sheet.getRange(2, 1, 1, 12).getValues()[0];
    var r3 = sheet.getRange(3, 1, 1, 12).getValues()[0];
    expect(r2[5]).toBe("222"); // payer
    expect(r2[6]).toBe("222"); // self share
    expect(r2[7]).toBe(500);
    expect(r3[5]).toBe("222");
    expect(r3[6]).toBe("111"); // partner owes half
    expect(r3[7]).toBe(500);
    expect(r2[8]).toBe(r3[8]); // shared tx id

    // Second Split (Dinner, payer=ramen=111).
    var r4 = sheet.getRange(4, 1, 1, 12).getValues()[0];
    var r5 = sheet.getRange(5, 1, 1, 12).getValues()[0];
    expect(r4[5]).toBe("111");
    expect(r5[6]).toBe("222");
    expect(r4[7]).toBe(400);
    expect(r5[7]).toBe(400);
  });

  it("rejects splitPartners that isn't exactly 2 chat_ids", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    ss.getSheets()[0].appendRow(["Email Date"]);

    var { adminMigrateLegacyGroupSheet } = load(SpreadsheetApp);
    expect(() => adminMigrateLegacyGroupSheet("g1", { splitPartners: ["111"] })).toThrow(/exactly 2/);
  });

  it("no-ops cleanly when the sheet has only a header row", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    ss.getSheets()[0].appendRow(["Email Date"]);

    var { adminMigrateLegacyGroupSheet } = load(SpreadsheetApp);
    var stats = adminMigrateLegacyGroupSheet("g1", { commit: true });

    expect(stats).toEqual({ migrated: 0, kept: 0, unknown: 0 });
    expect(ss.getSheets().length).toBe(1); // no backup created
  });

  it("dropPersonal: discards pre-β personal rows entirely (not even self-share)", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    sheet.appendRow([
      "Email Date",
      "Tx Date",
      "Merchant",
      "Amount",
      "Category",
      "Tx Type",
      "User",
      "Split",
      "Message ID",
      "Currency",
      "Link"
    ]);
    sheet.appendRow(preBetaRow("Personal-1", 100, "Food", "ramen", "Personal"));
    sheet.appendRow(preBetaRow("Personal-2", 200, "Food", "ramen", "Personal"));
    sheet.appendRow(preBetaRow("Split-1", 600, "Food", "ramen", "Split"));
    sheet.appendRow(betaRow("β-row", 700, "111", "222", 350));

    var { adminMigrateLegacyGroupSheet, GROUP_SHEET_HEADERS } = load(SpreadsheetApp);
    var stats = adminMigrateLegacyGroupSheet("g1", {
      commit: true,
      dropPersonal: true,
      splitPartners: ["111", "222"],
      userToChatId: { ramen: "111" }
    });

    expect(stats.preBetaPersonal).toBe(2);
    expect(stats.preBetaPersonalDropped).toBe(2);
    expect(sheet.getRange(1, 1, 1, GROUP_SHEET_HEADERS.length).getValues()[0]).toEqual(GROUP_SHEET_HEADERS);
    // No personal merchant survives. (Don't lean on getLastRow — the mock
    // doesn't shrink data[] after clearContent; real Apps Script does.)
    var merchants = [];
    for (var r = 2; r <= 4; r++) merchants.push(sheet.getRange(r, 3).getValue());
    expect(merchants).not.toContain("Personal-1");
    expect(merchants).not.toContain("Personal-2");
    // The remaining 3 written rows are: 2 split-expanded + 1 β.
    expect(
      merchants.filter(function (m) {
        return m === "Split-1";
      }).length
    ).toBe(2);
    expect(merchants).toContain("β-row");
  });
});

describe("adminInspectLegacyGroupSheet", () => {
  it("returns rows the classifier flags as unknown, capped by limit", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    sheet.appendRow(["Email Date"]); // header
    sheet.appendRow(betaRow("OK", 100, "111", "222", 50)); // beta
    sheet.appendRow(preBetaRow("OK", 100, "Food", "u", "Personal")); // pre-beta
    sheet.appendRow(["", "", "junk", "", "", "", "", "", "", "", ""]); // unknown
    sheet.appendRow(["x", "y", "z", 1, "Food", "Debit", "u", "??", "m", "INR", "l"]); // unknown

    var { adminInspectLegacyGroupSheet } = load(SpreadsheetApp);
    var hits = adminInspectLegacyGroupSheet("g1");
    expect(hits.length).toBe(2);
    expect(hits[0].rowNum).toBe(4);
    expect(hits[1].rowNum).toBe(5);
    expect(hits[0].cells[2]).toBe("junk");
  });

  it("respects the limit option", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    sheet.appendRow(["Email Date"]);
    for (var i = 0; i < 5; i++) {
      sheet.appendRow(["", "", "junk" + i, "", "", "", "", "", "", "", ""]);
    }
    var { adminInspectLegacyGroupSheet } = load(SpreadsheetApp);
    var hits = adminInspectLegacyGroupSheet("g1", { limit: 2 });
    expect(hits.length).toBe(2);
  });

  it("returns [] when there are no unknown rows", () => {
    var SpreadsheetApp = makeSpreadsheetApp();
    var ss = SpreadsheetApp.openById("g1");
    var sheet = ss.getSheets()[0];
    sheet.appendRow(["Email Date"]);
    sheet.appendRow(betaRow("OK", 100, "111", "222", 50));

    var { adminInspectLegacyGroupSheet } = load(SpreadsheetApp);
    expect(adminInspectLegacyGroupSheet("g1")).toEqual([]);
  });
});
