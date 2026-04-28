import { describe, it, expect, beforeEach } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

const ADMIN_SHEET_ID = "ADMIN";
const CATEGORIES = ["Shopping", "Groceries", "Food & Dining"];
const CREDIT_CATEGORIES = ["Salary", "Refund"];

const SYMBOLS = [
  "getCategoryListForType",
  "findRowByColumnValue",
  "updateGoogleSheetCellWithFeedback",
  "ensureSheetHeaders",
  "addNewMerchantIfNeeded",
  "setMerchantResolution",
  "setCategoryOverride",
  "getCategoryOverrides",
  "getMerchantResolutions",
  "deleteSheetRow"
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

  it("rejects rows beyond last data row", () => {
    var r = api.updateGoogleSheetCellWithFeedback(99, 1, "x", "");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/exceeds last row/);
  });

  it("updates the cell on success and returns old/new values", () => {
    var r = api.updateGoogleSheetCellWithFeedback(2, 1, "NEW", "a");
    expect(r.success).toBe(true);
    expect(r.oldValue).toBe("a");
    expect(r.newValue).toBe("NEW");
    expect(mainSheet().getRange(2, 1).getValue()).toBe("NEW");
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
      "Split",
      "Message ID",
      "Currency",
      "Email Link"
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
