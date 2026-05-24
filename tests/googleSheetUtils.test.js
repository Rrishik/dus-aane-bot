import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "ADMIN";
const CATEGORIES = ["Shopping", "Groceries", "Food & Dining"];
const CREDIT_CATEGORIES = ["Salary", "Refund"];

const SYMBOLS = [
  "getCategoryListForType",
  "isDebit",
  "findRowByColumnValue",
  "updateGoogleSheetCellWithFeedback",
  "ensureSheetHeaders",
  "addNewMerchantIfNeeded",
  "setMerchantResolution",
  "setCategoryOverride",
  "getCategoryOverrides",
  "getMerchantResolutions",
  "shortenMerchantPattern",
  "deleteSheetRow",
  "setCurrentTenant",
  "getCurrentTenant",
  "getTenantSheetId",
  "getTenantChatId",
  "sheetUrl",
  "getSpreadsheet",
  "appendRowToGoogleSheet",
  "populateResolutionSheet",
  "reapplyMerchantResolutions",
  "populateCategoryOverridesForReview",
  "applyCategoryOverridesToMainSheet"
];

let app, api;

// Helpers to seed sheets before each test.
function mainSheet() {
  return app.openById(ADMIN_SHEET_ID).getSheets()[0];
}
function tab(name) {
  return app.openById(ADMIN_SHEET_ID).getSheetByName(name);
}
function seed(sheet, rows) {
  rows.forEach((r) => sheet.appendRow(r));
}

beforeEach(() => {
  // Fresh sandbox + fresh in-memory store per test (modules cache the
  // spreadsheet handle, so we must reload).
  app = makeSpreadsheetApp();
  api = loadAppsScript(["GoogleSheetUtils.js"], SYMBOLS, {
    SpreadsheetApp: app,
    ADMIN_SHEET_ID,
    ADMIN_CHAT_ID: "CHAT",
    CATEGORIES,
    CREDIT_CATEGORIES,
    MESSAGE_ID_COLUMN: 8,
    GROUP_REF_COLUMN: 10,
    GROUP_MESSAGE_ID_COLUMN: 11,
    Logger: { log: () => {} }
  });
});

describe("getCategoryListForType", () => {
  it("returns CREDIT_CATEGORIES for 'Credit' (case-insensitive)", () => {
    expect(api.getCategoryListForType("Credit")).toBe(CREDIT_CATEGORIES);
    expect(api.getCategoryListForType("credit")).toBe(CREDIT_CATEGORIES);
    expect(api.getCategoryListForType("CREDIT")).toBe(CREDIT_CATEGORIES);
  });

  it("returns CATEGORIES for 'Debit', empty, null, undefined", () => {
    expect(api.getCategoryListForType("Debit")).toBe(CATEGORIES);
    expect(api.getCategoryListForType("")).toBe(CATEGORIES);
    expect(api.getCategoryListForType(null)).toBe(CATEGORIES);
    expect(api.getCategoryListForType(undefined)).toBe(CATEGORIES);
  });
});

describe("isDebit", () => {
  it("matches 'Debit' case-insensitively and trimmed", () => {
    expect(api.isDebit("Debit")).toBe(true);
    expect(api.isDebit("debit")).toBe(true);
    expect(api.isDebit("DEBIT")).toBe(true);
    expect(api.isDebit("  Debit  ")).toBe(true);
  });

  it("returns false for credit and empty/missing values", () => {
    expect(api.isDebit("Credit")).toBe(false);
    expect(api.isDebit("")).toBe(false);
    expect(api.isDebit(null)).toBe(false);
    expect(api.isDebit(undefined)).toBe(false);
    expect(api.isDebit("Unknown")).toBe(false);
  });
});

describe("findRowByColumnValue", () => {
  it("returns -1 on empty sheet (only header)", () => {
    seed(mainSheet(), [["Email Date", "Transaction Date", "Merchant"]]);
    expect(api.findRowByColumnValue(3, "Anything")).toBe(-1);
  });

  it("returns -1 when no matching value", () => {
    seed(mainSheet(), [
      ["h1", "h2", "h3"],
      ["x", "y", "Amazon"]
    ]);
    expect(api.findRowByColumnValue(3, "Flipkart")).toBe(-1);
  });

  it("returns the row number (1-indexed) when found", () => {
    seed(mainSheet(), [
      ["h1", "h2", "h3"],
      ["a", "b", "Amazon"],
      ["c", "d", "Flipkart"]
    ]);
    expect(api.findRowByColumnValue(3, "Flipkart")).toBe(3);
  });

  it("scans bottom-up (returns the latest match)", () => {
    seed(mainSheet(), [["h"], ["dup"], ["x"], ["dup"]]);
    expect(api.findRowByColumnValue(1, "dup")).toBe(4);
  });

  it("compares as strings (numeric and string match)", () => {
    seed(mainSheet(), [["h"], [42]]);
    expect(api.findRowByColumnValue(1, "42")).toBe(2);
  });
});

describe("updateGoogleSheetCellWithFeedback", () => {
  beforeEach(() => {
    seed(mainSheet(), [
      ["h1", "h2"],
      ["a", "b"]
    ]);
  });

  it("rejects invalid row number", () => {
    var r = api.updateGoogleSheetCellWithFeedback(0, 1, "x", "");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Invalid row/);
  });

  it("rejects invalid column number", () => {
    var r = api.updateGoogleSheetCellWithFeedback(2, 0, "x", "");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Invalid column/);
  });

  it("rejects header row", () => {
    var r = api.updateGoogleSheetCellWithFeedback(1, 1, "x", "h1");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/header row/);
  });

  it("updates the cell on success and returns old/new values", () => {
    var r = api.updateGoogleSheetCellWithFeedback(2, 1, "NEW", "a");
    expect(r.success).toBe(true);
    expect(r.oldValue).toBe("a");
    expect(r.newValue).toBe("NEW");
    expect(mainSheet().getRange(2, 1).getValue()).toBe("NEW");
  });

  it("returns { success:false, message:'Error: ...' } when setValue throws", () => {
    var sheet = mainSheet();
    var origGetRange = sheet.getRange;
    sheet.getRange = () => ({
      setValue: () => {
        throw new Error("write failed");
      }
    });
    var r = api.updateGoogleSheetCellWithFeedback(2, 1, "NEW", "a");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Error: write failed/);
    sheet.getRange = origGetRange;
  });
});

describe("ensureSheetHeaders", () => {
  it("appends headers when sheet is empty", () => {
    api.ensureSheetHeaders();
    var headers = mainSheet().getRange(1, 1, 1, 11).getValues()[0];
    expect(headers).toEqual([
      "Email Date",
      "Transaction Date",
      "Merchant",
      "Amount",
      "Category",
      "Transaction Type",
      "User",
      "Message ID",
      "Currency",
      "Group Ref",
      "Group Message ID"
    ]);
  });

  it("is a no-op when headers already exist", () => {
    seed(mainSheet(), [["existing"]]);
    api.ensureSheetHeaders();
    expect(mainSheet().getLastRow()).toBe(1);
    expect(mainSheet().getRange(1, 1).getValue()).toBe("existing");
  });
});

describe("addNewMerchantIfNeeded", () => {
  it("returns false on empty input", () => {
    expect(api.addNewMerchantIfNeeded("")).toBe(false);
    expect(api.addNewMerchantIfNeeded(null)).toBe(false);
  });

  it("creates the MerchantResolution tab on first call and adds the row", () => {
    expect(api.addNewMerchantIfNeeded("amzn_pay")).toBe(true);
    var t = tab("MerchantResolution");
    expect(t).not.toBeNull();
    expect(t.getRange(2, 1, 1, 2).getValues()[0]).toEqual(["amzn_pay", ""]);
  });

  it("does not duplicate existing merchant (case-insensitive)", () => {
    api.addNewMerchantIfNeeded("AMZN_PAY");
    expect(api.addNewMerchantIfNeeded("amzn_pay")).toBe(false);
    expect(tab("MerchantResolution").getLastRow()).toBe(2); // header + 1 row
  });
});

describe("setMerchantResolution", () => {
  it("returns failure when merchant is empty", () => {
    expect(api.setMerchantResolution("", "X").success).toBe(false);
  });

  it("returns failure when MerchantResolution has no rows", () => {
    api.addNewMerchantIfNeeded("seed"); // create the tab so it exists but empty data is irrelevant
    var t = tab("MerchantResolution");
    // Reset to header-only
    t.data = [["Raw Pattern", "Resolved Name"]];
    var r = api.setMerchantResolution("anything", "X");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/No merchants/);
  });

  it("updates resolved name on existing pattern", () => {
    api.addNewMerchantIfNeeded("flipkart_mws");
    var r = api.setMerchantResolution("FLIPKART_MWS", "Flipkart");
    expect(r.success).toBe(true);
    expect(tab("MerchantResolution").getRange(2, 2).getValue()).toBe("Flipkart");
  });

  it("returns failure when pattern not in sheet", () => {
    api.addNewMerchantIfNeeded("known");
    var r = api.setMerchantResolution("unknown", "X");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/not found/);
  });
});

describe("setCategoryOverride", () => {
  it("rejects empty merchant or category", () => {
    expect(api.setCategoryOverride("", "Shopping").success).toBe(false);
    expect(api.setCategoryOverride("X", "").success).toBe(false);
  });

  it("appends a new row when merchant not present", () => {
    var r = api.setCategoryOverride("Flipkart", "Shopping");
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/added/);
    var rows = tab("CategoryOverrides").getRange(2, 1, 1, 2).getValues()[0];
    expect(rows).toEqual(["Flipkart", "Shopping"]);
  });

  it("updates existing row case-insensitively without duplicating", () => {
    api.setCategoryOverride("Flipkart", "Shopping");
    var r = api.setCategoryOverride("FLIPKART", "Groceries");
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/updated/);
    expect(tab("CategoryOverrides").getLastRow()).toBe(2); // header + 1
    expect(tab("CategoryOverrides").getRange(2, 2).getValue()).toBe("Groceries");
  });
});

describe("getCategoryOverrides", () => {
  it("returns empty object on empty sheet", () => {
    expect(api.getCategoryOverrides()).toEqual({});
  });

  it("builds a lowercase merchant -> category map and skips blank rows", () => {
    api.setCategoryOverride("Flipkart", "Shopping");
    api.setCategoryOverride("Swiggy", "Food & Dining");
    // Inject a blank-merchant row to ensure it's filtered
    tab("CategoryOverrides").appendRow(["", "Junk"]);
    expect(api.getCategoryOverrides()).toEqual({
      flipkart: "Shopping",
      swiggy: "Food & Dining"
    });
  });
});

describe("getMerchantResolutions", () => {
  it("returns [] on empty sheet", () => {
    expect(api.getMerchantResolutions()).toEqual([]);
  });

  it("joins MerchantResolution rows with CategoryOverrides", () => {
    api.addNewMerchantIfNeeded("flipkart_mws");
    api.setMerchantResolution("flipkart_mws", "Flipkart");
    api.setCategoryOverride("Flipkart", "Shopping");

    api.addNewMerchantIfNeeded("amzn_pay"); // resolved name blank → no override match

    var out = api.getMerchantResolutions();
    expect(out).toContainEqual({ pattern: "flipkart_mws", resolved: "Flipkart", category: "Shopping" });
    expect(out).toContainEqual({ pattern: "amzn_pay", resolved: "", category: "" });
  });

  it("uses raw pattern as override key when resolved name is blank", () => {
    api.addNewMerchantIfNeeded("zomato"); // resolved blank
    api.setCategoryOverride("zomato", "Food & Dining");
    var out = api.getMerchantResolutions();
    expect(out[0]).toEqual({ pattern: "zomato", resolved: "", category: "Food & Dining" });
  });
});

describe("shortenMerchantPattern", () => {
  it("strips trailing transaction-id digits", () => {
    expect(api.shortenMerchantPattern("bundl tech 12345")).toBe("bundl tech");
    expect(api.shortenMerchantPattern("AMAZON #123-456")).toBe("AMAZON");
    expect(api.shortenMerchantPattern("Uber Trip 2026-05")).toBe("Uber Trip");
  });

  it("is a no-op when the tail isn't a digit run", () => {
    expect(api.shortenMerchantPattern("Spotify 9.99 USD")).toBe("Spotify 9.99 USD");
    expect(api.shortenMerchantPattern("Amazon")).toBe("Amazon");
  });

  it("leaves leading digits and embedded digits alone", () => {
    expect(api.shortenMerchantPattern("7Eleven")).toBe("7Eleven");
    expect(api.shortenMerchantPattern("B12 Vitamins Store")).toBe("B12 Vitamins Store");
  });

  it("returns the original value when shortening would empty the string", () => {
    expect(api.shortenMerchantPattern("12345")).toBe("12345");
    expect(api.shortenMerchantPattern("")).toBe("");
  });
});

describe("deleteSheetRow", () => {
  it("removes the row at the given index", () => {
    seed(mainSheet(), [["h"], ["a"], ["b"], ["c"]]);
    api.deleteSheetRow(3); // remove "b"
    expect(
      mainSheet()
        .getRange(1, 1, 3, 1)
        .getValues()
        .map((r) => r[0])
    ).toEqual(["h", "a", "c"]);
  });
});

describe("tenant context helpers", () => {
  it("falls back to ADMIN_SHEET_ID / ADMIN_CHAT_ID when no tenant is set", () => {
    expect(api.getCurrentTenant()).toBe(null);
    expect(api.getTenantSheetId()).toBe(ADMIN_SHEET_ID);
    expect(api.getTenantChatId()).toBe("CHAT");
  });

  it("returns the tenant sheet_id / chat_id once set", () => {
    api.setCurrentTenant({ sheet_id: "TENANT1", chat_id: "111" });
    expect(api.getCurrentTenant()).toEqual({ sheet_id: "TENANT1", chat_id: "111" });
    expect(api.getTenantSheetId()).toBe("TENANT1");
    expect(api.getTenantChatId()).toBe("111");
  });

  it("invalidates the cached spreadsheet when sheet_id changes between tenants", () => {
    api.setCurrentTenant({ sheet_id: "TENANT1", chat_id: "111" });
    var ss1 = api.getSpreadsheet();
    expect(ss1.getId()).toBe("TENANT1");
    // Same tenant — cached handle is reused.
    expect(api.getSpreadsheet()).toBe(ss1);

    api.setCurrentTenant({ sheet_id: "TENANT2", chat_id: "222" });
    var ss2 = api.getSpreadsheet();
    expect(ss2).not.toBe(ss1);
    expect(ss2.getId()).toBe("TENANT2");
  });

  it("invalidates the cached spreadsheet when clearing tenant context", () => {
    api.setCurrentTenant({ sheet_id: "TENANT1", chat_id: "111" });
    var ss1 = api.getSpreadsheet();
    api.setCurrentTenant(null);
    var ss2 = api.getSpreadsheet();
    expect(ss2).not.toBe(ss1);
    expect(ss2.getId()).toBe(ADMIN_SHEET_ID);
  });
});

describe("sheetUrl", () => {
  it("returns the canonical Google Sheets URL prefix for an id", () => {
    expect(api.sheetUrl("abc123")).toBe("https://docs.google.com/spreadsheets/d/abc123");
  });
});

describe("findRowByColumnValue head-scan fallback", () => {
  it("finds a match older than the 500-row tail window", () => {
    // Header + 502 data rows: target sits at row 2 (sheet row 2), only the
    // head scan can see it. The tail window covers the trailing 500 rows.
    var rows = [["h"], ["TARGET"]];
    for (var i = 0; i < 501; i++) rows.push(["filler-" + i]);
    seed(mainSheet(), rows);
    expect(api.findRowByColumnValue(1, "TARGET")).toBe(2);
  });

  it("still returns -1 when the value is in neither window", () => {
    var rows = [["h"]];
    for (var i = 0; i < 600; i++) rows.push(["filler-" + i]);
    seed(mainSheet(), rows);
    expect(api.findRowByColumnValue(1, "ghost")).toBe(-1);
  });
});

describe("appendRowToGoogleSheet", () => {
  it("appends to the first sheet", () => {
    seed(mainSheet(), [["h"]]);
    api.appendRowToGoogleSheet(["x"]);
    expect(mainSheet().getRange(2, 1).getValue()).toBe("x");
  });

  it("swallows errors and logs (does not throw)", () => {
    // Force getSheets to throw on the next access.
    var ss = app.openById(ADMIN_SHEET_ID);
    var origGetSheets = ss.getSheets;
    ss.getSheets = () => {
      throw new Error("boom");
    };
    var errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => api.appendRowToGoogleSheet(["x"])).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    ss.getSheets = origGetSheets;
  });
});

describe("populateResolutionSheet", () => {
  it("is a no-op on an empty main sheet", () => {
    api.populateResolutionSheet();
    expect(tab("MerchantResolution")).toBeNull();
  });

  it("adds unique merchants from main sheet col C", () => {
    // Header + 4 data rows; col C = merchant.
    seed(mainSheet(), [
      ["EmailDate", "TxnDate", "Merchant"],
      ["d", "d", "Flipkart"],
      ["d", "d", "flipkart"], // dup case-insensitive
      ["d", "d", "Amazon"],
      ["d", "d", ""] // blank skipped
    ]);
    api.populateResolutionSheet();
    var t = tab("MerchantResolution");
    var rows = t
      .getRange(2, 1, t.getLastRow() - 1, 2)
      .getValues()
      .map((r) => r[0])
      .sort();
    expect(rows).toEqual(["Amazon", "Flipkart"]);
  });
});

describe("reapplyMerchantResolutions", () => {
  it("is a no-op when the main sheet has no data rows", () => {
    expect(() => api.reapplyMerchantResolutions()).not.toThrow();
  });

  it("is a no-op when MerchantResolution is empty", () => {
    seed(mainSheet(), [
      ["h", "h", "h"],
      ["d", "d", "Flipkart Pay 123"]
    ]);
    api.reapplyMerchantResolutions();
    // Col C (sheet col 3) is the merchant column. Unchanged.
    expect(mainSheet().getRange(2, 3).getValue()).toBe("Flipkart Pay 123");
  });

  it("rewrites raw merchant names to resolved names from MerchantResolution", () => {
    seed(mainSheet(), [
      ["h", "h", "h"],
      ["d", "d", "FLIPKART_MWS_MERCH 12345"],
      ["d", "d", "AMAZON_INDIA"],
      ["d", "d", "untouched"]
    ]);
    api.addNewMerchantIfNeeded("flipkart_mws");
    api.setMerchantResolution("flipkart_mws", "Flipkart");
    api.addNewMerchantIfNeeded("amazon_india");
    api.setMerchantResolution("amazon_india", "Amazon");

    api.reapplyMerchantResolutions();
    var merchants = mainSheet()
      .getRange(2, 3, 3, 1)
      .getValues()
      .map((r) => r[0]);
    expect(merchants).toEqual(["Flipkart", "Amazon", "untouched"]);
  });
});

describe("populateCategoryOverridesForReview", () => {
  it("is a no-op on an empty main sheet", () => {
    api.populateCategoryOverridesForReview();
    expect(tab("CategoryOverrides")).toBeNull();
  });

  it("appends most-frequent category per merchant, skipping existing overrides", () => {
    // Cols C..E = merchant, amount, category. Flipkart has 2 Shopping + 1
    // Groceries → Shopping wins. Amazon already in overrides → skipped.
    // Zomato has only "uncategorized" entries → ignored.
    seed(mainSheet(), [
      ["h", "h", "h", "h", "h"],
      ["d", "d", "Flipkart", 100, "Shopping"],
      ["d", "d", "Flipkart", 100, "Shopping"],
      ["d", "d", "Flipkart", 50, "Groceries"],
      ["d", "d", "Amazon", 200, "Shopping"],
      ["d", "d", "Zomato", 80, "Uncategorized"]
    ]);
    api.setCategoryOverride("Amazon", "Shopping"); // pre-existing

    api.populateCategoryOverridesForReview();
    var t = tab("CategoryOverrides");
    var rows = t
      .getRange(2, 1, t.getLastRow() - 1, 2)
      .getValues()
      .map((r) => [r[0], r[1]]);
    // Flipkart appended once with Shopping; Amazon stays single; Zomato skipped.
    expect(rows.filter((r) => r[0] === "Flipkart")).toEqual([["Flipkart", "Shopping"]]);
    expect(rows.filter((r) => r[0] === "Amazon").length).toBe(1);
    expect(rows.find((r) => r[0] === "Zomato")).toBeUndefined();
  });
});

describe("applyCategoryOverridesToMainSheet", () => {
  it("is a no-op when overrides table is empty", () => {
    seed(mainSheet(), [
      ["h", "h", "h", "h", "h"],
      ["d", "d", "Flipkart", 100, "Old"]
    ]);
    api.applyCategoryOverridesToMainSheet();
    expect(mainSheet().getRange(2, 5).getValue()).toBe("Old");
  });

  it("is a no-op when main sheet has no data rows", () => {
    api.setCategoryOverride("Flipkart", "Shopping");
    expect(() => api.applyCategoryOverridesToMainSheet()).not.toThrow();
  });

  it("rewrites col E for rows whose merchant matches an override (case-insensitive)", () => {
    seed(mainSheet(), [
      ["h", "h", "h", "h", "h"],
      ["d", "d", "Flipkart", 100, "Old"],
      ["d", "d", "FLIPKART", 200, "Old"],
      ["d", "d", "Unknown", 50, "Misc"]
    ]);
    api.setCategoryOverride("Flipkart", "Shopping");
    api.applyCategoryOverridesToMainSheet();
    var cats = mainSheet()
      .getRange(2, 5, 3, 1)
      .getValues()
      .map((r) => r[0]);
    expect(cats).toEqual(["Shopping", "Shopping", "Misc"]);
  });
});
