// Utility to update a Google Sheet cell
function updateGoogleSheetCell(sheet_id, row_number, column_number, value) {
  try {
    var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];

    if (isNaN(row_number) || row_number <= 0) {
      return false;
    }

    if (isNaN(column_number) || column_number <= 0) {
      return false;
    }

    // Check if row exists (row should be <= last row with data)
    var lastRow = sheet.getLastRow();
    
    if (row_number > lastRow) {
      return false;
    }

    // Check if row is header row (row 1) - we shouldn't update headers
    if (row_number === 1) {
      return false;
    }

    // Update the cell
    sheet.getRange(row_number, column_number).setValue(value);
    
    // Verify the update
    var newValue = sheet.getRange(row_number, column_number).getValue();
    
    return newValue === value;
  } catch (error) {
    return false;
  }
}

// Enhanced version that returns detailed feedback
function updateGoogleSheetCellWithFeedback(sheet_id, row_number, column_number, value, currentValue) {
  try {
    var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];

    if (isNaN(row_number) || row_number <= 0) {
      return {success: false, message: "Invalid row number: " + row_number};
    }

    if (isNaN(column_number) || column_number <= 0) {
      return {success: false, message: "Invalid column number: " + column_number};
    }

    // Check if row exists (row should be <= last row with data)
    var lastRow = sheet.getLastRow();
    
    if (row_number > lastRow) {
      return {success: false, message: "Row " + row_number + " exceeds last row " + lastRow};
    }

    // Check if row is header row (row 1) - we shouldn't update headers
    if (row_number === 1) {
      return {success: false, message: "Cannot update header row"};
    }

    // Update the cell
    sheet.getRange(row_number, column_number).setValue(value);
    
    // Small delay to ensure write completes
    Utilities.sleep(100);
    
    // Verify the update
    var newValue = sheet.getRange(row_number, column_number).getValue();
    
    if (newValue === value || newValue.toString() === value.toString()) {
      return {success: true, message: "Updated successfully", oldValue: currentValue, newValue: newValue};
    } else {
      return {success: false, message: "Value mismatch. Expected: " + value + ", Got: " + newValue};
    }
  } catch (error) {
    return {success: false, message: "Error: " + error.message};
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