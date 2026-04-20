// Admin helpers — run these manually from the Apps Script editor.
// Not wired into the runtime. Safe to re-run (idempotent where noted).

/**
 * Create a blank template spreadsheet by copying the current prod sheet's
 * structure (tabs + headers) and deleting the data. The new file is owned
 * by the bot's Google account (whoever is running this).
 *
 * Returns the new sheet ID. Save it as TEMPLATE_SHEET_ID in Lol.js / CI secret.
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
  console.log("1. Save this ID as TEMPLATE_SHEET_ID in Lol.js and GitHub secret");
  console.log("2. Review the copy in Drive to ensure it's clean");
  return copy.getId();
}

/**
 * Provision a new tenant's sheet by copying the template.
 * Returns the new sheet's ID. Caller is responsible for registering it.
 *
 * Used by Phase 4's onboarding flow; exposed as admin helper for dry runs.
 */
function adminProvisionTenantSheet(displayName, shareWithEmail) {
  if (typeof TEMPLATE_SHEET_ID !== "string" || !TEMPLATE_SHEET_ID) {
    throw new Error("TEMPLATE_SHEET_ID not set. Run adminCreateTemplateSheet() first.");
  }
  var name = "Dus Aane — " + (displayName || "Tenant");
  var copy = DriveApp.getFileById(TEMPLATE_SHEET_ID).makeCopy(name);
  if (shareWithEmail) {
    try {
      copy.addEditor(shareWithEmail);
      console.log("Shared sheet " + copy.getId() + " with " + shareWithEmail);
    } catch (e) {
      console.error("[adminProvisionTenantSheet] addEditor failed for " + shareWithEmail + ": " + e.message);
    }
  }
  console.log("Provisioned sheet: " + copy.getId() + " (" + name + ")");
  return copy.getId();
}
