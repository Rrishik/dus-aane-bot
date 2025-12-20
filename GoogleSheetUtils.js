// Utility to update a Google Sheet cell
function updateGoogleSheetCell(sheet_id, row_number, column_number, value) {
  try {
    var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];

    if (isNaN(row_number) || row_number <= 0) {
      console.log("Error: Invalid row number:", row_number);
      return false;
    }

    if (isNaN(column_number) || column_number <= 0) {
      console.log("Error: Invalid column number:", column_number);
      return false;
    }

    // Check if row exists (row should be <= last row with data)
    var lastRow = sheet.getLastRow();
    if (row_number > lastRow) {
      console.log("Error: Row number " + row_number + " exceeds last row " + lastRow);
      return false;
    }

    // Check if row is header row (row 1) - we shouldn't update headers
    if (row_number === 1) {
      console.log("Error: Cannot update header row");
      return false;
    }

    sheet.getRange(row_number, column_number).setValue(value);
    console.log("Successfully updated sheet: Row " + row_number + ", Column " + column_number + " = " + value);
    return true;
  } catch (error) {
    console.log("Error updating sheet:", error.message);
    console.log("Stack trace:", error.stack);
    return false;
  }
}

// Utility to append a row to a Google Sheet
function appendRowToGoogleSheet(sheet_id, row_data) {
  try {
    var ss = SpreadsheetApp.openById(sheet_id);
    var sheet = ss.getSheets()[0];
    console.log(`[GoogleSheets] Opening Spreadsheet: ${ss.getName()} (ID: ${sheet_id})`);
    console.log(`[GoogleSheets] Target Sheet Tab: ${sheet.getName()}`);
    console.log(`[GoogleSheets] Appending Data: ${JSON.stringify(row_data)}`);

    sheet.appendRow(row_data);
    console.log("[GoogleSheets] Row appended successfully.");
  } catch (error) {
    console.error(`[GoogleSheets] Error appending row: ${error.message}`);
    console.error(`[GoogleSheets] Stack Trace: ${error.stack}`);
  }
}

// Utility to ensure headers are present in the Google Sheet
function ensureSheetHeaders(sheet_id) {
  var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];
  if (sheet.getLastRow() === 0) {
    appendRowToGoogleSheet(sheet_id, ["Email Date", "Transaction Date", "Merchant", "Amount", "Category", "Transaction Type", "User", "Split"]);
    if (DEBUG) {
      console.log("Headers added to the sheet.");
    }
  }
}