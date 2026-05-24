import { describe, it, expect } from "vitest";
import { loadAppsScript } from "./_loader.js";
import { makeSpreadsheetApp } from "./_sheetMock.js";

function setup() {
  var SpreadsheetApp = makeSpreadsheetApp();
  return {
    SpreadsheetApp: SpreadsheetApp,
    mod: loadAppsScript(["GroupSheet.js"], ["ensureGroupSheetHeaders", "GROUP_SHEET_HEADERS", "openGroupSheet"], {
      SpreadsheetApp: SpreadsheetApp,
      G_MESSAGE_ID_COLUMN: 12
    })
  };
}

describe("ensureGroupSheetHeaders", () => {
  it("writes the β-schema header row to a fresh sheet", () => {
    var s = setup();
    s.SpreadsheetApp.openById("g1").insertSheet("Splits");
    expect(s.mod.ensureGroupSheetHeaders("g1")).toBe(true);
    var sheet = s.SpreadsheetApp.openById("g1").getSheets()[0];
    var headers = sheet.getRange(1, 1, 1, 12).getValues()[0];
    expect(headers).toEqual(s.mod.GROUP_SHEET_HEADERS);
  });

  it("declares 12 columns in the right β-schema order", () => {
    var s = setup();
    expect(s.mod.GROUP_SHEET_HEADERS.length).toBe(12);
    // Spot-check the discriminating positions vs the personal sheet
    expect(s.mod.GROUP_SHEET_HEADERS[5]).toBe("Paid By"); // col 6
    expect(s.mod.GROUP_SHEET_HEADERS[6]).toBe("Share Holder"); // col 7
    expect(s.mod.GROUP_SHEET_HEADERS[7]).toBe("Share Amount"); // col 8
    expect(s.mod.GROUP_SHEET_HEADERS[8]).toBe("Tx ID"); // col 9
  });

  it("is idempotent — re-running on a populated sheet is a no-op", () => {
    var s = setup();
    s.SpreadsheetApp.openById("g1").insertSheet("Splits");
    s.mod.ensureGroupSheetHeaders("g1");
    expect(s.mod.ensureGroupSheetHeaders("g1")).toBe(false);
    var sheet = s.SpreadsheetApp.openById("g1").getSheets()[0];
    expect(sheet.getLastRow()).toBe(1); // still just the header
  });
});
