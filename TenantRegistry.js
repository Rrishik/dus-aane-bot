// --- Tenant Registry ---
// Tenants live in a `Tenants` tab on the admin spreadsheet (ADMIN_SHEET_ID —
// i.e., tenant 0's sheet). One row per tenant.
//
// Schema (stable column order):
//   1: chat_id        (primary key; Telegram chat/group id as string)
//   2: name           (display label, optional)
//   3: emails         (comma-separated forwarder gmails)
//   4: sheet_id       (where this tenant's transactions are written)
//   5: status         ("pending" | "active" | "disabled")
//   6: created_at     (ISO timestamp)
//   7: notes          (free-form)
//
// A row with status=pending has no sheet_id yet; it's created on first forward.
//
// Why the admin sheet hosts the registry: keeps everything in one admin place,
// and we already have access there. The Tenants tab is separate from data.

var TENANTS_TAB = "Tenants";
var TENANT_COLS = {
  CHAT_ID: 1,
  NAME: 2,
  EMAILS: 3,
  SHEET_ID: 4,
  STATUS: 5,
  CREATED_AT: 6,
  NOTES: 7
};
var TENANT_STATUS = { PENDING: "pending", ACTIVE: "active", DISABLED: "disabled" };

// One-execution cache (rehydrated each script run).
var _tenantCache = null;

function _adminSpreadsheet() {
  // Registry lives on the admin sheet. Use a direct openById (not getSpreadsheet())
  // to avoid tangling with the tenant-context accessor.
  return SpreadsheetApp.openById(ADMIN_SHEET_ID);
}

function _getOrCreateTenantsTab() {
  var ss = _adminSpreadsheet();
  var tab = ss.getSheetByName(TENANTS_TAB);
  if (!tab) {
    tab = ss.insertSheet(TENANTS_TAB);
    tab.appendRow(["chat_id", "name", "emails", "sheet_id", "status", "created_at", "notes"]);
  }
  return tab;
}

function _rowToTenant(row) {
  return {
    chat_id: String(row[TENANT_COLS.CHAT_ID - 1] || ""),
    name: String(row[TENANT_COLS.NAME - 1] || ""),
    emails: String(row[TENANT_COLS.EMAILS - 1] || "")
      .split(",")
      .map(function (s) {
        return s.trim().toLowerCase();
      })
      .filter(function (s) {
        return s.length > 0;
      }),
    sheet_id: String(row[TENANT_COLS.SHEET_ID - 1] || ""),
    status: String(row[TENANT_COLS.STATUS - 1] || ""),
    created_at: row[TENANT_COLS.CREATED_AT - 1] || "",
    notes: String(row[TENANT_COLS.NOTES - 1] || "")
  };
}

function loadTenants() {
  if (_tenantCache) return _tenantCache;
  var tab = _getOrCreateTenantsTab();
  var last = tab.getLastRow();
  if (last < 2) {
    _tenantCache = [];
    return _tenantCache;
  }
  var data = tab.getRange(2, 1, last - 1, 7).getValues();
  _tenantCache = data.map(_rowToTenant);
  return _tenantCache;
}

function invalidateTenantCache() {
  _tenantCache = null;
}

function findTenantByChatId(chatId) {
  var key = String(chatId);
  var list = loadTenants();
  for (var i = 0; i < list.length; i++) {
    if (list[i].chat_id === key) return list[i];
  }
  return null;
}

function findTenantByEmail(email) {
  if (!email) return null;
  var lc = String(email).toLowerCase();
  var list = loadTenants();
  for (var i = 0; i < list.length; i++) {
    if (list[i].status === TENANT_STATUS.ACTIVE && list[i].emails.indexOf(lc) !== -1) {
      return list[i];
    }
  }
  return null;
}

function findPendingTenantByEmail(email) {
  if (!email) return null;
  var lc = String(email).toLowerCase();
  var list = loadTenants();
  for (var i = 0; i < list.length; i++) {
    if (list[i].status === TENANT_STATUS.PENDING && list[i].emails.indexOf(lc) !== -1) {
      return list[i];
    }
  }
  return null;
}

// --- Writes (used in Phase 4+; safe to define now) ---

function _findRowIndexByChatId(chatId) {
  var tab = _getOrCreateTenantsTab();
  var last = tab.getLastRow();
  if (last < 2) return -1;
  var keys = tab.getRange(2, TENANT_COLS.CHAT_ID, last - 1, 1).getValues();
  var target = String(chatId);
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === target) return i + 2; // sheet row
  }
  return -1;
}

function upsertPendingTenant(chatId, email, name) {
  var tab = _getOrCreateTenantsTab();
  var rowNum = _findRowIndexByChatId(chatId);
  var now = new Date().toISOString();
  if (rowNum === -1) {
    tab.appendRow([String(chatId), name || "", email || "", "", TENANT_STATUS.PENDING, now, ""]);
  } else {
    // Merge email into existing emails list (dedup)
    var existing = tab.getRange(rowNum, TENANT_COLS.EMAILS).getValue() || "";
    var set = String(existing)
      .split(",")
      .map(function (s) {
        return s.trim().toLowerCase();
      })
      .filter(function (s) {
        return s.length > 0;
      });
    if (email && set.indexOf(email.toLowerCase()) === -1) set.push(email.toLowerCase());
    tab.getRange(rowNum, TENANT_COLS.EMAILS).setValue(set.join(","));
    if (name) tab.getRange(rowNum, TENANT_COLS.NAME).setValue(name);
  }
  invalidateTenantCache();
}

function activateTenant(chatId, sheetId) {
  var rowNum = _findRowIndexByChatId(chatId);
  if (rowNum === -1) return false;
  var tab = _getOrCreateTenantsTab();
  tab.getRange(rowNum, TENANT_COLS.SHEET_ID).setValue(sheetId);
  tab.getRange(rowNum, TENANT_COLS.STATUS).setValue(TENANT_STATUS.ACTIVE);
  invalidateTenantCache();
  return true;
}

// --- Admin bootstrap helpers (run manually from script editor) ---

/**
 * Seed tenant 0 (the current group: you + partner) into the Tenants tab.
 * Idempotent — safe to run multiple times.
 *
 * Reads ADMIN_CHAT_ID and ADMIN_SHEET_ID from AConfig.js and creates a
 * Tenants row so the current pipeline can flip to tenant-aware routing without
 * any behavior change.
 */
function adminSeedTenantZero() {
  var tab = _getOrCreateTenantsTab();
  var existing = _findRowIndexByChatId(ADMIN_CHAT_ID);
  if (existing !== -1) {
    console.log("Tenant 0 already seeded at row " + existing);
    return;
  }
  var now = new Date().toISOString();
  // Emails list: populated by admin, or discovered dynamically from sheet's User column.
  // For now, seed empty — admin adds forwarders via adminAddEmailToTenantZero().
  tab.appendRow([
    String(ADMIN_CHAT_ID),
    "Tenant 0 (founder group)",
    "",
    ADMIN_SHEET_ID,
    TENANT_STATUS.ACTIVE,
    now,
    "Pre-seeded"
  ]);
  invalidateTenantCache();
  console.log("Tenant 0 seeded.");
}

/**
 * Append a forwarder email to tenant 0's emails list. Call this once per
 * known forwarder (e.g., adminAddEmailToTenantZero("ramenarishik@gmail.com")).
 */
function adminAddEmailToTenantZero(email) {
  upsertPendingTenant(ADMIN_CHAT_ID, email);
  // upsertPendingTenant sets status=pending on insert; if tenant 0 already
  // exists it just merges emails. If we just inserted, flip back to active.
  var rowNum = _findRowIndexByChatId(ADMIN_CHAT_ID);
  if (rowNum !== -1) {
    var tab = _getOrCreateTenantsTab();
    tab.getRange(rowNum, TENANT_COLS.STATUS).setValue(TENANT_STATUS.ACTIVE);
    if (!tab.getRange(rowNum, TENANT_COLS.SHEET_ID).getValue()) {
      tab.getRange(rowNum, TENANT_COLS.SHEET_ID).setValue(ADMIN_SHEET_ID);
    }
    invalidateTenantCache();
  }
}

/**
 * Derive emails for tenant 0 by scanning the main sheet's User column and
 * inferring gmail addresses. Users stored in the sheet are gmail local-parts
 * (e.g., "ramenarishik"), so we append "@gmail.com" as a best-effort guess.
 * Review/edit the Tenants tab manually after running to correct any mis-guesses.
 */
function adminBackfillTenantZeroEmails() {
  var ss = SpreadsheetApp.openById(ADMIN_SHEET_ID);
  var sheet = ss.getSheets()[0];
  var last = sheet.getLastRow();
  if (last < 2) return;
  var userCol = 7; // main sheet "User" column
  var users = sheet.getRange(2, userCol, last - 1, 1).getValues();
  var seen = {};
  users.forEach(function (row) {
    var u = String(row[0] || "").trim();
    if (u && u.indexOf("@") === -1) u = u + "@gmail.com";
    if (u) seen[u.toLowerCase()] = true;
  });
  Object.keys(seen).forEach(function (email) {
    adminAddEmailToTenantZero(email);
  });
  console.log("Tenant 0 emails now: " + Object.keys(seen).join(", "));
}
