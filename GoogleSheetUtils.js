// Find the row number where a column has a specific value. Returns -1 if not found.
function findRowByColumnValue(sheet_id, column_number, value) {
  var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var data = sheet.getRange(2, column_number, lastRow - 1, 1).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (data[i][0].toString() === value.toString()) {
      return i + 2; // +2: 0-indexed array + skip header row
    }
  }
  return -1;
}

// Enhanced version that returns detailed feedback
function updateGoogleSheetCellWithFeedback(sheet_id, row_number, column_number, value, currentValue) {
  try {
    var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];

    if (isNaN(row_number) || row_number <= 0) {
      return { success: false, message: "Invalid row number: " + row_number };
    }

    if (isNaN(column_number) || column_number <= 0) {
      return { success: false, message: "Invalid column number: " + column_number };
    }

    // Check if row exists (row should be <= last row with data)
    var lastRow = sheet.getLastRow();

    if (row_number > lastRow) {
      return { success: false, message: "Row " + row_number + " exceeds last row " + lastRow };
    }

    // Check if row is header row (row 1) - we shouldn't update headers
    if (row_number === 1) {
      return { success: false, message: "Cannot update header row" };
    }

    // Update the cell
    sheet.getRange(row_number, column_number).setValue(value);

    // Small delay to ensure write completes
    Utilities.sleep(100);

    // Verify the update
    var newValue = sheet.getRange(row_number, column_number).getValue();

    if (newValue === value || newValue.toString() === value.toString()) {
      return { success: true, message: "Updated successfully", oldValue: currentValue, newValue: newValue };
    } else {
      return { success: false, message: "Value mismatch. Expected: " + value + ", Got: " + newValue };
    }
  } catch (error) {
    return { success: false, message: "Error: " + error.message };
  }
}

// Utility to append a row to a Google Sheet
function appendRowToGoogleSheet(sheet_id, row_data) {
  try {
    var ss = SpreadsheetApp.openById(sheet_id);
    var sheet = ss.getSheets()[0];

    sheet.appendRow(row_data);
  } catch (error) {
    console.error(`[GoogleSheets] Error appending row: ${error.message}`);
    console.error(`[GoogleSheets] Stack Trace: ${error.stack}`);
  }
}

// Utility to ensure headers are present in the Google Sheet
function ensureSheetHeaders(sheet_id) {
  var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];
  if (sheet.getLastRow() === 0) {
    appendRowToGoogleSheet(sheet_id, [
      "Email Date",
      "Transaction Date",
      "Merchant",
      "Amount",
      "Category",
      "Transaction Type",
      "User",
      "Split",
      "Message ID",
      "Currency"
    ]);
  }
}

// --- CategoryOverrides tab helpers ---

var OVERRIDES_TAB = "CategoryOverrides";

function getOrCreateOverridesSheet(sheet_id) {
  var ss = SpreadsheetApp.openById(sheet_id);
  var tab = ss.getSheetByName(OVERRIDES_TAB);
  if (!tab) {
    tab = ss.insertSheet(OVERRIDES_TAB);
    tab.appendRow(["Merchant", "Category"]);
  }
  return tab;
}

// Get all merchant→category overrides as an object
function getCategoryOverrides(sheet_id) {
  var tab = getOrCreateOverridesSheet(sheet_id);
  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return {};
  var data = tab.getRange(2, 1, lastRow - 1, 2).getValues();
  var overrides = {};
  data.forEach(function (row) {
    if (row[0]) overrides[row[0].toString().toLowerCase()] = row[1];
  });
  return overrides;
}

// Upsert a merchant→category override
function saveCategoryOverride(sheet_id, merchant, category) {
  var tab = getOrCreateOverridesSheet(sheet_id);
  var lastRow = tab.getLastRow();
  if (lastRow > 1) {
    var merchants = tab.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < merchants.length; i++) {
      if (merchants[i][0].toString().toLowerCase() === merchant.toLowerCase()) {
        tab.getRange(i + 2, 2).setValue(category);
        return;
      }
    }
  }
  tab.appendRow([merchant, category]);
}

// Delete a row from the first sheet by row number
function deleteSheetRow(sheet_id, row_number) {
  var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];
  sheet.deleteRow(row_number);
}
