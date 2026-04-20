// Per-execution tenant context: when set, getSpreadsheet() opens the tenant's
// sheet instead of the admin sheet. Entry points (doPost, triggers,
// extractTransactions per-message) call setCurrentTenant() before touching the
// sheet or Telegram.
//
// Fallback behavior: when no tenant is set, getTenantSheetId() / getTenantChatId()
// return the admin values (ADMIN_SHEET_ID / ADMIN_CHAT_ID). This is a safety net
// for legacy code paths (tenant 0 / admin commands run manually from the script
// editor). Any runtime code path that fires from a user-supplied chat_id MUST
// set tenant context first — silent fallback would cross-tenant-leak data.
var _currentTenant = null;

function setCurrentTenant(tenant) {
  // Invalidate the cached spreadsheet if the tenant's sheet changes.
  if (tenant && _currentTenant && tenant.sheet_id !== _currentTenant.sheet_id) {
    _cachedSpreadsheet = null;
  } else if (!tenant && _currentTenant) {
    _cachedSpreadsheet = null;
  }
  _currentTenant = tenant;
}

function getCurrentTenant() {
  return _currentTenant;
}

function getTenantSheetId() {
  return (_currentTenant && _currentTenant.sheet_id) || ADMIN_SHEET_ID;
}

function getTenantChatId() {
  return (_currentTenant && _currentTenant.chat_id) || ADMIN_CHAT_ID;
}

// Lazy-cached spreadsheet accessor — avoids redundant openById calls within a single execution
var _cachedSpreadsheet = null;
function getSpreadsheet() {
  if (!_cachedSpreadsheet) {
    _cachedSpreadsheet = SpreadsheetApp.openById(getTenantSheetId());
  }
  return _cachedSpreadsheet;
}

// Find the row number where a column has a specific value. Returns -1 if not found.
function findRowByColumnValue(column_number, value) {
  var sheet = getSpreadsheet().getSheets()[0];
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
function updateGoogleSheetCellWithFeedback(row_number, column_number, value, currentValue) {
  try {
    var sheet = getSpreadsheet().getSheets()[0];

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
function appendRowToGoogleSheet(row_data) {
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheets()[0];

    sheet.appendRow(row_data);
  } catch (error) {
    console.error(`[GoogleSheets] Error appending row: ${error.message}`);
    console.error(`[GoogleSheets] Stack Trace: ${error.stack}`);
  }
}

// Utility to ensure headers are present in the Google Sheet
function ensureSheetHeaders() {
  var sheet = getSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) {
    appendRowToGoogleSheet([
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
function deleteSheetRow(row_number) {
  var sheet = getSpreadsheet().getSheets()[0];
  sheet.deleteRow(row_number);
}

// --- MerchantResolution tab helpers ---
// Maps raw merchant patterns to clean names.
// Categories are stored in a separate CategoryOverrides tab (resolved merchant → category).
//
// Both tabs live on the ADMIN sheet, not per-tenant. Merchant patterns are
// universal — every bank sends the same raw strings to every tenant — so
// sharing the mapping means new tenants inherit a pre-trained bot on day 1.
// Per-transaction overrides (the ✏️ Category button) still write to the
// tenant's main sheet row, not to CategoryOverrides, so a tenant customising
// their own categorisation doesn't affect anyone else.

var RESOLUTION_TAB = "MerchantResolution";
var OVERRIDES_TAB = "CategoryOverrides";

// Open the admin spreadsheet directly, independent of the per-execution tenant
// context. Used for the shared MerchantResolution / CategoryOverrides tabs.
var _cachedAdminSpreadsheet = null;
function _getAdminSpreadsheet() {
  if (!_cachedAdminSpreadsheet) {
    _cachedAdminSpreadsheet = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  }
  return _cachedAdminSpreadsheet;
}

function getOrCreateResolutionSheet() {
  var ss = _getAdminSpreadsheet();
  var tab = ss.getSheetByName(RESOLUTION_TAB);
  if (!tab) {
    tab = ss.insertSheet(RESOLUTION_TAB);
    tab.appendRow(["Raw Pattern", "Resolved Name"]);
  }
  return tab;
}

function getOrCreateOverridesSheet() {
  var ss = _getAdminSpreadsheet();
  var tab = ss.getSheetByName(OVERRIDES_TAB);
  if (!tab) {
    tab = ss.insertSheet(OVERRIDES_TAB);
    tab.appendRow(["Merchant", "Category"]);
  }
  return tab;
}

// Build a { merchantLowerCase: category } index from CategoryOverrides.
function getCategoryOverrides() {
  var tab = getOrCreateOverridesSheet();
  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return {};
  var data = tab.getRange(2, 1, lastRow - 1, 2).getValues();
  var map = {};
  data.forEach(function (row) {
    var m = (row[0] || "").toString().trim();
    var c = (row[1] || "").toString().trim();
    if (m && c) map[m.toLowerCase()] = c;
  });
  return map;
}

// Load all merchant resolution mappings, joined with CategoryOverrides:
// [ { pattern: "flipkart_mws_merch", resolved: "Flipkart", category: "Shopping" }, ... ]
function getMerchantResolutions() {
  var tab = getOrCreateResolutionSheet();
  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return [];
  var data = tab.getRange(2, 1, lastRow - 1, 2).getValues();
  var overrides = getCategoryOverrides();
  return data
    .filter(function (row) {
      return row[0];
    })
    .map(function (row) {
      var resolved = row[1] ? row[1].toString() : "";
      var key = (resolved || row[0]).toString().toLowerCase();
      return {
        pattern: row[0].toString().toLowerCase(),
        resolved: resolved,
        category: overrides[key] || ""
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
function addNewMerchantIfNeeded(rawMerchant) {
  if (!rawMerchant) return false;
  var tab = getOrCreateResolutionSheet();
  var lastRow = tab.getLastRow();
  if (lastRow > 1) {
    var data = tab.getRange(2, 1, lastRow - 1, 1).getValues();
    var lower = rawMerchant.toLowerCase();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0].toString().toLowerCase() === lower) return false;
    }
  }
  tab.appendRow([rawMerchant, ""]);
  return true;
}

// Update Resolved Name for a Pattern row in MerchantResolution.
// Returns { success, message }. Used by the "Save Mapping" inline button.
function setMerchantResolution(rawMerchant, resolvedName) {
  if (!rawMerchant) return { success: false, message: "Empty merchant" };
  var tab = getOrCreateResolutionSheet();
  var lastRow = tab.getLastRow();
  if (lastRow <= 1) return { success: false, message: "No merchants in sheet" };
  var data = tab.getRange(2, 1, lastRow - 1, 1).getValues();
  var lower = rawMerchant.toString().toLowerCase();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().toLowerCase() === lower) {
      var rowNum = i + 2; // header is row 1, data starts at row 2
      tab.getRange(rowNum, 2).setValue(resolvedName || "");
      return { success: true, message: "Mapping saved" };
    }
  }
  return { success: false, message: "Pattern not found in MerchantResolution" };
}

// Upsert a (merchant → category) row in CategoryOverrides.
// Case-insensitive match on the merchant column; overwrites category if row exists.
function setCategoryOverride(merchant, category) {
  if (!merchant || !category) return { success: false, message: "Empty merchant or category" };
  var tab = getOrCreateOverridesSheet();
  var lastRow = tab.getLastRow();
  var lower = merchant.toString().toLowerCase();
  if (lastRow > 1) {
    var data = tab.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().toLowerCase() === lower) {
        tab.getRange(i + 2, 2).setValue(category);
        return { success: true, message: "Override updated" };
      }
    }
  }
  tab.appendRow([merchant, category]);
  return { success: true, message: "Override added" };
}

// One-time script: seed MerchantResolution with all unique merchants from the main sheet.
function populateResolutionSheet() {
  var sheet = getSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var merchants = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  var added = 0;
  var seen = {};
  merchants.forEach(function (row) {
    var m = row[0] ? row[0].toString().trim() : "";
    if (!m || seen[m.toLowerCase()]) return;
    seen[m.toLowerCase()] = true;
    if (addNewMerchantIfNeeded(m)) added++;
  });
  Logger.log("Populated MerchantResolution: " + added + " new merchants added");
}

// ─── Bulk maintenance scripts ────────────────────────────────────────
// Run from the Apps Script editor. Not wired to Telegram.

// Re-apply current MerchantResolution mappings to ALL existing main-sheet transactions.
// Updates merchant name (col C) to the resolved name when a mapping exists.
// Does NOT touch categories — use CategoryOverrides flow for that.
function reapplyMerchantResolutions() {
  var sheet = getSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log("No transactions to update");
    return;
  }
  var resolutions = getMerchantResolutions();
  if (resolutions.length === 0) {
    Logger.log("MerchantResolution is empty");
    return;
  }

  var range = sheet.getRange(2, 3, lastRow - 1, 1); // col C only
  var values = range.getValues();
  var changed = 0;

  for (var i = 0; i < values.length; i++) {
    var rawMerchant = (values[i][0] || "").toString();
    if (!rawMerchant) continue;
    var resolved = resolveMerchant(rawMerchant, resolutions);
    if (resolved && resolved.merchant && resolved.merchant !== rawMerchant) {
      values[i][0] = resolved.merchant;
      changed++;
    }
  }

  range.setValues(values);
  Logger.log("reapplyMerchantResolutions: merchants updated=" + changed);
}

// Populate CategoryOverrides for review:
// For each merchant seen in the main sheet that is NOT already in CategoryOverrides,
// pick the most-frequent category and append a row. Safe to re-run — never overwrites
// existing rows, so manual corrections are preserved.
function populateCategoryOverridesForReview() {
  var sheet = getSpreadsheet().getSheets()[0];
  var mainLast = sheet.getLastRow();
  if (mainLast <= 1) {
    Logger.log("No transactions to infer from");
    return;
  }

  // Build merchant -> {category: count}
  var mainData = sheet.getRange(2, 3, mainLast - 1, 3).getValues(); // C..E (merchant, amount, category)
  var index = {};
  var original = {}; // preserve display-cased merchant name
  mainData.forEach(function (row) {
    var m = (row[0] || "").toString().trim();
    var c = (row[2] || "").toString().trim();
    if (!m || !c || c.toLowerCase() === "uncategorized") return;
    var key = m.toLowerCase();
    if (!index[key]) {
      index[key] = {};
      original[key] = m;
    }
    index[key][c] = (index[key][c] || 0) + 1;
  });

  // Existing entries (case-insensitive) to skip
  var tab = getOrCreateOverridesSheet();
  var existing = {};
  var lastRow = tab.getLastRow();
  if (lastRow > 1) {
    tab
      .getRange(2, 1, lastRow - 1, 1)
      .getValues()
      .forEach(function (row) {
        var m = (row[0] || "").toString().trim().toLowerCase();
        if (m) existing[m] = true;
      });
  }

  // Build new rows and batch-append
  var rowsToAppend = [];
  Object.keys(index).forEach(function (key) {
    if (existing[key]) return;
    var counts = index[key];
    var best = null;
    var bestCount = 0;
    Object.keys(counts).forEach(function (cat) {
      if (counts[cat] > bestCount) {
        best = cat;
        bestCount = counts[cat];
      }
    });
    if (best) rowsToAppend.push([original[key], best]);
  });

  if (rowsToAppend.length > 0) {
    tab.getRange(tab.getLastRow() + 1, 1, rowsToAppend.length, 2).setValues(rowsToAppend);
  }
  Logger.log("populateCategoryOverridesForReview: appended=" + rowsToAppend.length);
}

// Apply CategoryOverrides to ALL existing main-sheet transactions.
// For every main-sheet row whose merchant (case-insensitive exact) matches an entry in
// CategoryOverrides, overwrite col E with the mapped category. Overrides always win.
function applyCategoryOverridesToMainSheet() {
  var overrides = getCategoryOverrides();
  if (Object.keys(overrides).length === 0) {
    Logger.log("CategoryOverrides is empty — nothing to apply");
    return;
  }
  var sheet = getSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log("No transactions to update");
    return;
  }

  var range = sheet.getRange(2, 3, lastRow - 1, 3); // C..E
  var values = range.getValues();
  var changed = 0;

  for (var i = 0; i < values.length; i++) {
    var merchant = (values[i][0] || "").toString().trim();
    if (!merchant) continue;
    var mapped = overrides[merchant.toLowerCase()];
    if (mapped && values[i][2] !== mapped) {
      values[i][2] = mapped;
      changed++;
    }
  }

  range.setValues(values);
  Logger.log("applyCategoryOverridesToMainSheet: categories updated=" + changed);
}
