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

    return { success: true, message: "Updated successfully", oldValue: currentValue, newValue: value };
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
      "Currency",
      "Email Link"
    ]);
  }
}

// --- CategoryOverrides tab helpers ---
// Stores merchant-category frequency: Merchant | Category | Count

var OVERRIDES_TAB = "CategoryOverrides";

function getOrCreateOverridesSheet(sheet_id) {
  var ss = SpreadsheetApp.openById(sheet_id);
  var tab = ss.getSheetByName(OVERRIDES_TAB);
  if (!tab) {
    tab = ss.insertSheet(OVERRIDES_TAB);
    tab.appendRow(["Merchant", "Category", "Count"]);
  }
  return tab;
}

// Get merchant→category frequency map: { merchant: { category: count, ... }, ... }
function getCategoryOverrides(sheet_id) {
  var tab = getOrCreateOverridesSheet(sheet_id);
  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return {};
  var data = tab.getRange(2, 1, lastRow - 1, 3).getValues();
  var overrides = {};
  data.forEach(function (row) {
    if (!row[0]) return;
    var merchant = row[0].toString().toLowerCase();
    if (!overrides[merchant]) overrides[merchant] = {};
    overrides[merchant][row[1]] = parseInt(row[2]) || 1;
  });
  return overrides;
}

// Increment the count for a merchant-category pair (upsert)
function saveCategoryOverride(sheet_id, merchant, category) {
  var tab = getOrCreateOverridesSheet(sheet_id);
  var lastRow = tab.getLastRow();
  if (lastRow > 1) {
    var data = tab.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase() === merchant.toLowerCase() && data[i][1] === category) {
        var newCount = (parseInt(data[i][2]) || 1) + 1;
        tab.getRange(i + 2, 3).setValue(newCount);
        return;
      }
    }
  }
  tab.appendRow([merchant, category, 1]);
}

// Delete a row from the first sheet by row number
function deleteSheetRow(sheet_id, row_number) {
  var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];
  sheet.deleteRow(row_number);
}

// --- MerchantResolution tab helpers ---
// Maps raw merchant patterns to clean names: Raw Pattern | Resolved Name

var RESOLUTION_TAB = "MerchantResolution";

function getOrCreateResolutionSheet(sheet_id) {
  var ss = SpreadsheetApp.openById(sheet_id);
  var tab = ss.getSheetByName(RESOLUTION_TAB);
  if (!tab) {
    tab = ss.insertSheet(RESOLUTION_TAB);
    tab.appendRow(["Raw Pattern", "Resolved Name"]);
  }
  return tab;
}

// Load all merchant resolution mappings: [ { pattern: "flipkart", resolved: "Flipkart" }, ... ]
function getMerchantResolutions(sheet_id) {
  var tab = getOrCreateResolutionSheet(sheet_id);
  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return [];
  var data = tab.getRange(2, 1, lastRow - 1, 2).getValues();
  return data
    .filter(function (row) {
      return row[0] && row[1];
    })
    .map(function (row) {
      return { pattern: row[0].toString().toLowerCase(), resolved: row[1].toString() };
    });
}

// Resolve a raw merchant name using the resolution table (case-insensitive substring match).
// Returns the resolved name if matched, otherwise the original name.
function resolveMerchant(rawName, resolutions) {
  if (!rawName || !resolutions || resolutions.length === 0) return rawName;
  var lower = rawName.toLowerCase();
  for (var i = 0; i < resolutions.length; i++) {
    if (lower.indexOf(resolutions[i].pattern) !== -1) {
      return resolutions[i].resolved;
    }
  }
  return rawName;
}
