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

// Delete a row from the first sheet by row number
function deleteSheetRow(sheet_id, row_number) {
  var sheet = SpreadsheetApp.openById(sheet_id).getSheets()[0];
  sheet.deleteRow(row_number);
}

// --- MerchantResolution tab helpers ---
// Maps raw merchant patterns to clean names with optional default category:
// Raw Pattern | Resolved Name | Default Category

var RESOLUTION_TAB = "MerchantResolution";

function getOrCreateResolutionSheet(sheet_id) {
  var ss = SpreadsheetApp.openById(sheet_id);
  var tab = ss.getSheetByName(RESOLUTION_TAB);
  if (!tab) {
    tab = ss.insertSheet(RESOLUTION_TAB);
    tab.appendRow(["Raw Pattern", "Resolved Name", "Default Category"]);
  }
  return tab;
}

// Load all merchant resolution mappings:
// [ { pattern: "flipkart", resolved: "Flipkart", category: "Shopping" }, ... ]
function getMerchantResolutions(sheet_id) {
  var tab = getOrCreateResolutionSheet(sheet_id);
  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return [];
  var data = tab.getRange(2, 1, lastRow - 1, 3).getValues();
  return data
    .filter(function (row) {
      return row[0];
    })
    .map(function (row) {
      return {
        pattern: row[0].toString().toLowerCase(),
        resolved: row[1] ? row[1].toString() : "",
        category: row[2] ? row[2].toString() : ""
      };
    });
}

// Resolve a raw merchant name using the resolution table (case-insensitive substring match).
// Returns { merchant: resolvedName, category: defaultCategory } or { merchant: rawName, category: "" }
function resolveMerchant(rawName, resolutions) {
  if (!rawName || !resolutions || resolutions.length === 0) return { merchant: rawName, category: "" };
  var lower = rawName.toLowerCase();
  for (var i = 0; i < resolutions.length; i++) {
    if (lower.indexOf(resolutions[i].pattern) !== -1) {
      return {
        merchant: resolutions[i].resolved || rawName,
        category: resolutions[i].category || ""
      };
    }
  }
  return { merchant: rawName, category: "" };
}

// Lookup merchant category from resolutions by resolved name (exact, case-insensitive).
// Used by the get_merchant_category tool.
function lookupMerchantCategory(merchantName, resolutions) {
  if (!merchantName || !resolutions || resolutions.length === 0) return null;
  var lower = merchantName.toLowerCase();
  for (var i = 0; i < resolutions.length; i++) {
    if (
      resolutions[i].pattern === lower ||
      (resolutions[i].resolved && resolutions[i].resolved.toLowerCase() === lower)
    ) {
      if (resolutions[i].category) {
        return { merchant: resolutions[i].resolved || merchantName, category: resolutions[i].category };
      }
    }
  }
  return null;
}

// Check if a merchant is already in the MerchantResolution tab (column A, case-insensitive).
// If not, add it with a blank Resolved Name. Returns true if a new row was added.
function addNewMerchantIfNeeded(sheet_id, rawMerchant) {
  if (!rawMerchant) return false;
  var tab = getOrCreateResolutionSheet(sheet_id);
  var lastRow = tab.getLastRow();
  if (lastRow > 1) {
    var data = tab.getRange(2, 1, lastRow - 1, 1).getValues();
    var lower = rawMerchant.toLowerCase();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase() === lower) return false;
    }
  }
  tab.appendRow([rawMerchant, "", ""]);
  return true;
}

// One-time script: seed MerchantResolution with all unique merchants from the main sheet.
function populateResolutionSheet() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var merchants = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  var added = 0;
  var seen = {};
  merchants.forEach(function (row) {
    var m = row[0] ? row[0].toString().trim() : "";
    if (!m || seen[m.toLowerCase()]) return;
    seen[m.toLowerCase()] = true;
    if (addNewMerchantIfNeeded(SHEET_ID, m)) added++;
  });
  Logger.log("Populated MerchantResolution: " + added + " new merchants added");
}
