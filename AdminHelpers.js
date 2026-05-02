// Admin helpers — run these manually from the Apps Script editor.
// Not wired into the runtime. Safe to re-run (idempotent where noted).

/**
 * Create a blank template spreadsheet by copying the current prod sheet's
 * structure (tabs + headers) and deleting the data. The new file is owned
 * by the bot's Google account (whoever is running this).
 *
 * Returns the new sheet ID. Save it as TEMPLATE_SHEET_ID in AConfig.js / CI secret.
 *
 * Idempotent-ish: creates a new copy each run; delete old ones via Drive UI.
 */
function adminCreateTemplateSheet() {
  var TEMPLATE_NAME = "Dus Aane — Template";

  var srcFile = DriveApp.getFileById(ADMIN_SHEET_ID);
  var copy = srcFile.makeCopy(TEMPLATE_NAME);
  var ss = SpreadsheetApp.openById(copy.getId());

  // Clear data rows from every tab, keeping the header (row 1) intact.
  // Delete tabs that are admin-only or shared (not per-tenant).
  var SHARED_TABS = [TENANTS_TAB, RESOLUTION_TAB, OVERRIDES_TAB];
  ss.getSheets().forEach(function (sheet) {
    if (SHARED_TABS.indexOf(sheet.getName()) !== -1) {
      ss.deleteSheet(sheet);
      return;
    }
    var last = sheet.getLastRow();
    if (last > 1) {
      sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
    }
  });

  console.log("Template created. ID: " + copy.getId());
  console.log("Name: " + copy.getName());
  console.log("URL:  " + copy.getUrl());
  console.log("");
  console.log("Next steps:");
  console.log("1. Save this ID as TEMPLATE_SHEET_ID in AConfig.js and GitHub secret");
  console.log("2. Review the copy in Drive to ensure it's clean");
  return copy.getId();
}

/**
 * Provision a new tenant's sheet by copying the template.
 * Returns the new sheet's ID. Caller is responsible for registering it.
 *
 * Used by Phase 4's onboarding flow; exposed as admin helper for dry runs.
 *
 * Ownership: by default the caller (admin) stays as owner and the tenant
 * is added as an editor. Pass `transferOwnership=true` to also kick off a
 * Drive ownership transfer to the tenant — that requires the tenant to
 * accept a Drive notification, so we don't do it as part of the default
 * onboarding path. Tenants can opt in later via `/ownsheet`.
 */
function adminProvisionTenantSheet(displayName, shareWithEmail, transferOwnership) {
  if (typeof TEMPLATE_SHEET_ID !== "string" || !TEMPLATE_SHEET_ID) {
    throw new Error("TEMPLATE_SHEET_ID not set. Run adminCreateTemplateSheet() first.");
  }
  var name = "Dus Aane — " + (displayName || "Tenant");
  var copy = DriveApp.getFileById(TEMPLATE_SHEET_ID).makeCopy(name);
  if (shareWithEmail) {
    try {
      copy.addEditor(shareWithEmail);
    } catch (e) {
      console.error("[adminProvisionTenantSheet] addEditor failed for " + shareWithEmail + ": " + e.message);
    }
    if (transferOwnership) {
      try {
        copy.setOwner(shareWithEmail);
        console.log("Initiated ownership transfer of " + copy.getId() + " to " + shareWithEmail);
      } catch (e) {
        // Cross-account transfers can fail (e.g. recipient not yet on Drive,
        // Workspace policy). Sheet still works as admin-owned + user-editor.
        console.error("[adminProvisionTenantSheet] setOwner failed for " + shareWithEmail + ": " + e.message);
      }
    }
  }
  console.log("Provisioned sheet: " + copy.getId() + " (" + name + ")");
  return copy.getId();
}

/**
 * Initiate a Drive ownership transfer of `sheetId` to `email`. The user
 * must accept a Drive notification before the transfer completes. Until
 * then admin remains the owner; the user stays an editor.
 *
 * Returns true on a successful initiate (Drive accepted the request),
 * false on any error (logged to the Executions panel).
 */
function adminTransferSheetOwnership(sheetId, email) {
  try {
    var file = DriveApp.getFileById(sheetId);
    file.setOwner(email);
    console.log("[adminTransferSheetOwnership] initiated transfer of " + sheetId + " to " + email);
    return true;
  } catch (e) {
    console.error("[adminTransferSheetOwnership] failed for " + email + ": " + e.message);
    return false;
  }
}

/**
 * Migrate every existing sheet to the v2 (Groups-feature) schema. Idempotent.
 *
 *   Tenants tab on the admin sheet:
 *     adds 3 columns: chat_type, group_members, primary_currency
 *     backfills chat_type=personal and primary_currency=INR for existing rows
 *
 *   Each tenant's transactions sheet:
 *     adds 2 columns: Group Ref, Group Message ID (headers only; rows stay empty)
 *
 *   Template sheet (TEMPLATE_SHEET_ID):
 *     adds the same 2 columns so future tenants get the new schema
 *
 * Run once after deploy from the script editor. Safe to re-run; sheets that
 * are already at v2 are skipped.
 */
function adminMigrateSchemaV2() {
  var summary = { tenantsTab: false, perTenant: 0, perTenantSkipped: 0, template: false, errors: [] };

  // A. Tenants tab on the admin sheet
  try {
    var adminSs = SpreadsheetApp.openById(ADMIN_SHEET_ID);
    var tab = adminSs.getSheetByName(TENANTS_TAB);
    if (tab && tab.getLastColumn() < TENANT_COL_COUNT) {
      tab.getRange(1, 11, 1, 3).setValues([["chat_type", "group_members", "primary_currency"]]);
      var lastRow = tab.getLastRow();
      if (lastRow >= 2) {
        var dataRows = lastRow - 1;
        // Read existing values so we don't clobber any manual entries.
        var existing = tab.getRange(2, 11, dataRows, 3).getValues();
        var backfilled = existing.map(function (r) {
          return [r[0] || TENANT_CHAT_TYPE.PERSONAL, r[1] || "", r[2] || DEFAULT_PRIMARY_CURRENCY];
        });
        tab.getRange(2, 11, dataRows, 3).setValues(backfilled);
      }
      invalidateTenantCache();
      summary.tenantsTab = true;
      console.log(
        "[migrate] Tenants tab: extended to " +
          TENANT_COL_COUNT +
          " cols, backfilled " +
          Math.max(0, tab.getLastRow() - 1) +
          " rows"
      );
    } else {
      console.log("[migrate] Tenants tab: already at v2");
    }
  } catch (e) {
    summary.errors.push("Tenants tab: " + e.message);
    console.error("[migrate] Tenants tab failed: " + e.message);
  }

  // B. Each tenant's transactions sheet
  loadTenants().forEach(function (t) {
    if (!t.sheet_id) return;
    try {
      var ss = SpreadsheetApp.openById(t.sheet_id);
      var sheet = ss.getSheets()[0];
      if (sheet.getLastColumn() < GROUP_MESSAGE_ID_COLUMN) {
        sheet.getRange(1, GROUP_REF_COLUMN, 1, 2).setValues([["Group Ref", "Group Message ID"]]);
        summary.perTenant++;
        console.log(
          "[migrate] Tenant " +
            (t.name || t.chat_id) +
            " (" +
            t.sheet_id +
            "): added Group Ref + Group Message ID headers"
        );
      } else {
        summary.perTenantSkipped++;
      }
    } catch (e) {
      summary.errors.push("Tenant " + t.chat_id + ": " + e.message);
      console.error("[migrate] Tenant " + t.chat_id + " (" + t.sheet_id + ") failed: " + e.message);
    }
  });

  // C. Template sheet
  try {
    if (typeof TEMPLATE_SHEET_ID === "string" && TEMPLATE_SHEET_ID) {
      var tplSs = SpreadsheetApp.openById(TEMPLATE_SHEET_ID);
      var tplSheet = tplSs.getSheets()[0];
      if (tplSheet.getLastColumn() < GROUP_MESSAGE_ID_COLUMN) {
        tplSheet.getRange(1, GROUP_REF_COLUMN, 1, 2).setValues([["Group Ref", "Group Message ID"]]);
        summary.template = true;
        console.log("[migrate] Template sheet (" + TEMPLATE_SHEET_ID + "): added Group Ref + Group Message ID headers");
      } else {
        console.log("[migrate] Template sheet: already at v2");
      }
    } else {
      console.log("[migrate] TEMPLATE_SHEET_ID not set; skipping template");
    }
  } catch (e) {
    summary.errors.push("Template: " + e.message);
    console.error("[migrate] Template sheet failed: " + e.message);
  }

  console.log(
    "[migrate] Done. Tenants tab " +
      (summary.tenantsTab ? "migrated" : "skipped") +
      ", " +
      summary.perTenant +
      " tenant sheets migrated (" +
      summary.perTenantSkipped +
      " already at v2), template " +
      (summary.template ? "migrated" : "skipped") +
      ", " +
      summary.errors.length +
      " errors."
  );
  return summary;
}

/**
 * Create a blank group-sheet template. Run once from the script editor.
 * Save the returned ID as GROUP_TEMPLATE_SHEET_ID in AConfig.js + GitHub
 * secret. Future group provisioning copies this template.
 *
 * Owned by the bot's Google account. Not shared with anyone yet — group
 * sheets get shared with members at provisioning time.
 *
 * Re-running creates a new copy each time; clean up extras via Drive UI.
 */
function adminCreateGroupTemplateSheet() {
  var TEMPLATE_NAME = "Dus Aane — Group Template";
  var ss = SpreadsheetApp.create(TEMPLATE_NAME);
  // Default tab is "Sheet1"; rename for clarity. The runtime always reads
  // getSheets()[0] so the name is cosmetic.
  ss.getSheets()[0].setName("Splits");
  ensureGroupSheetHeaders(ss.getId());
  console.log("Group template created. ID: " + ss.getId());
  console.log("URL: " + ss.getUrl());
  console.log("");
  console.log("Next steps:");
  console.log("1. Save this ID as GROUP_TEMPLATE_SHEET_ID in AConfig.js and GitHub secret");
  console.log("2. Redeploy so AConfig.js picks up the new constant");
  return ss.getId();
}

/**
 * Provision a new group's sheet by copying GROUP_TEMPLATE_SHEET_ID.
 * Returns the new sheet's ID. Caller (group /start handler in 2b) is
 * responsible for registering the group tenant.
 *
 * Optional shareWithEmails: list of member emails to add as editors.
 * Ownership stays with the bot account (no per-group /ownsheet in v1 —
 * see groups-feature design doc).
 */
function adminProvisionGroupSheet(displayName, shareWithEmails) {
  if (typeof GROUP_TEMPLATE_SHEET_ID !== "string" || !GROUP_TEMPLATE_SHEET_ID) {
    throw new Error("GROUP_TEMPLATE_SHEET_ID not set. Run adminCreateGroupTemplateSheet() first.");
  }
  var name = "Dus Aane — " + (displayName || "Group");
  var copy = DriveApp.getFileById(GROUP_TEMPLATE_SHEET_ID).makeCopy(name);
  (shareWithEmails || []).forEach(function (email) {
    if (!email) return;
    try {
      copy.addEditor(email);
    } catch (e) {
      console.error("[adminProvisionGroupSheet] addEditor failed for " + email + ": " + e.message);
    }
  });
  // Belt-and-suspenders: the template was created with headers, but if anyone
  // accidentally cleared row 1 in the template, repopulate them on the copy.
  ensureGroupSheetHeaders(copy.getId());
  console.log("Provisioned group sheet: " + copy.getId() + " (" + name + ")");
  return copy.getId();
}
