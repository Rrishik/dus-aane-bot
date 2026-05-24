// Group-sheet helpers (β schema: one row per share).
//
// Group sheets are provisioned per Telegram group when the bot is /start'd
// in that group chat. The schema is intentionally different from personal
// sheets — see G_*_COLUMN constants in Constants.js. Per-share rows make
// settlement math (groupBy paid_by, share_holder) trivial. Tx ID links
// the N rows of one transaction.
//
// Provisioning lives in AdminHelpers.js (adminCreateGroupTemplateSheet,
// adminProvisionGroupSheet). This file owns the per-sheet schema concerns.

var GROUP_SHEET_HEADERS = [
  "Email Date",
  "Transaction Date",
  "Merchant",
  "Amount",
  "Currency",
  "Paid By",
  "Share Holder",
  "Share Amount",
  "Tx ID",
  "Category",
  "Transaction Type",
  "Message ID"
];

// Open a group sheet by ID. Independent of the per-execution tenant context
// (which targets the active personal sheet). Callers writing to a group
// sheet must pass the group tenant's sheet_id explicitly.
function openGroupSheet(sheetId) {
  return SpreadsheetApp.openById(sheetId).getSheets()[0];
}

// Ensure a freshly-created group spreadsheet has the β-schema header row.
// Idempotent: re-running on a sheet that already has headers is a no-op.
function ensureGroupSheetHeaders(sheetId) {
  var sheet = openGroupSheet(sheetId);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(GROUP_SHEET_HEADERS);
    // Message ID is the Gmail dedupe key — useless to the user. Tx ID stays
    // visible because it's how a user spots that N rows belong to one split.
    try {
      sheet.hideColumns(G_MESSAGE_ID_COLUMN);
    } catch (_) {}
    return true;
  }
  return false;
}
