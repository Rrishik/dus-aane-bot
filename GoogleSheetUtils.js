// Utility to update a Google Sheet cell
function updateGoogleSheetCell(sheet_id, row_number, column_number, value) {
  var sheet = SpreadsheetApp.openById(sheet_id).getActiveSheet();

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
  var sheet = SpreadsheetApp.openById(sheet_id).getActiveSheet();

  try {
    sheet.appendRow(row_data);
  } catch (error) {
    console.log("Error appending row to sheet:", error.message);
  }
}

// Utility to ensure headers are present in the Google Sheet
function ensureSheetHeaders(sheet_id) {
  var sheet = SpreadsheetApp.openById(sheet_id).getActiveSheet();
  if (sheet.getLastRow() === 0) {
    appendRowToGoogleSheet(sheet_id, ["Email Date", "Transaction Date", "Merchant", "Amount", "Category", "Transaction Type", "User", "Split"]);
    if (DEBUG) {
      console.log("Headers added to the sheet.");
    }
  }
}