// Utility to update a Google Sheet cell
function updateGoogleSheetCell(sheet_id, row_number, column_number, value) {
  var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];

  if (isNaN(row_number) || row_number <= 0) {
    console.log("Error: Invalid row number:", row_number);
    return;
  }

  if (isNaN(column_number) || column_number <= 0) {
    console.log("Error: Invalid column number:", column_number);
    return;
  }

  try {
    sheet.getRange(row_number, column_number).setValue(value);
  } catch (error) {
    console.log("Error updating sheet:", error.message);
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