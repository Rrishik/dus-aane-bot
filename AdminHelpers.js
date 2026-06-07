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
 * Ownership: the bot's Google account stays as owner and the tenant is
 * added as an editor.
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
    } catch (e) {
      console.error("[adminProvisionTenantSheet] addEditor failed for " + shareWithEmail + ": " + e.message);
    }
  }
  console.log("Provisioned sheet: " + copy.getId() + " (" + name + ")");
  return copy.getId();
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
 * Ownership stays with the bot account.
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

// ─── Legacy group-sheet migration ───────────────────────────────────────────
//
// One-shot helper for the admin's original sheet — created before the
// personal/group schema split. The sheet has two interleaved row shapes:
//
//   Pre-β personal rows  (early multi-user flat sheet):
//     [Email Date, Tx Date, Merchant, Amount, Category, Tx Type,
//      User (username), Split ("Personal"/"Split"), Message ID,
//      Currency, Link]
//
//   β-shaped rows (written after the schema split, mis-headered):
//     [Email Date, Tx Date, Merchant, Amount, Currency, Paid By (chat_id),
//      Share Holder (chat_id), Share Amount, Tx ID, Category, Tx Type]
//
// The current code already reads β rows correctly (by column position) and
// skips pre-β rows (col 8 → NaN → bailout). This helper makes the sheet
// canonical: rewrite header → β labels, convert pre-β rows into β-self-share
// rows (payer === holder, full amount), preserve everything else as-is.
// A self-share row is invisible to debt math but keeps the historical entry.
//
// Usage from Apps Script editor:
//   adminMigrateLegacyGroupSheet("<sheetId>");                  // dry-run report
//   adminMigrateLegacyGroupSheet("<sheetId>", { commit: true }); // backup + rewrite
//
// Options:
//   commit         — false (default) = log-only; true = mutate the sheet.
//   userToChatId   — optional { "<legacy User cell>": "<chat_id>", ... } map.
//                    Unresolved users fall back to the raw User string, which
//                    is harmless for personal rows (payer===holder → no debt)
//                    but means split rows expand using the raw string as the
//                    payer's chat_id (won't match a real tenant for debt math).
//   splitPartners  — optional ["<chat_idA>", "<chat_idB>"]. When set, pre-β
//                    "Split" rows expand to two β rows (50/50) instead of a
//                    single self-share row. This restores the historical
//                    pairwise debt that was implicit in the old flat format.
//                    Required when you want the migrated balances to reflect
//                    pre-β splits. Without it, split rows survive as history
//                    only (no debt contribution).
//
// Always creates a `Pre-β Backup <ISO date>` tab in the same spreadsheet on
// commit, copying the original tab byte-for-byte before any rewrite.
function adminMigrateLegacyGroupSheet(sheetId, opts) {
  opts = opts || {};
  var commit = !!opts.commit;
  var userMap = opts.userToChatId || {};
  var splitPartners = Array.isArray(opts.splitPartners) ? opts.splitPartners.slice(0, 2) : null;
  if (splitPartners && splitPartners.length !== 2) {
    throw new Error("splitPartners must contain exactly 2 chat_ids when provided");
  }

  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), G_COL_COUNT);
  if (lastRow < 2) {
    console.log("[migrate] sheet has no data rows; nothing to do.");
    return { migrated: 0, kept: 0, unknown: 0 };
  }
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  var converted = [];
  var stats = { beta: 0, preBetaPersonal: 0, preBetaSplit: 0, splitExpanded: 0, unknown: 0 };
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var shape = _classifyLegacyGroupRow(r);
    if (shape === "beta") {
      stats.beta++;
      converted.push(r.slice(0, G_COL_COUNT));
    } else if (shape === "pre-beta-personal") {
      stats.preBetaPersonal++;
      converted.push(_convertPreBetaRow(r, i + 1, userMap));
    } else if (shape === "pre-beta-split") {
      stats.preBetaSplit++;
      if (splitPartners) {
        // Expand to 2 β rows: payer keeps their half (self-share, no debt),
        // partner owes their half. Tx ID shared so both rows are one tx.
        var expanded = _convertPreBetaSplitRow(r, i + 1, userMap, splitPartners);
        for (var k = 0; k < expanded.length; k++) converted.push(expanded[k]);
        stats.splitExpanded++;
      } else {
        converted.push(_convertPreBetaRow(r, i + 1, userMap));
      }
    } else {
      stats.unknown++;
      // Preserve unknown rows untouched in their first G_COL_COUNT cells.
      converted.push(r.slice(0, G_COL_COUNT));
    }
  }

  console.log("[migrate] sheetId=" + sheetId + " commit=" + commit);
  console.log("[migrate]   β rows (preserved):        " + stats.beta);
  console.log("[migrate]   pre-β personal → β self:   " + stats.preBetaPersonal);
  if (splitPartners) {
    console.log(
      "[migrate]   pre-β split    → 50/50 pair: " + stats.splitExpanded + " (partners: " + splitPartners.join(",") + ")"
    );
  } else {
    console.log("[migrate]   pre-β split    → β self:   " + stats.preBetaSplit);
    if (stats.preBetaSplit > 0) {
      console.log(
        "[migrate]   ⚠️  Split rows became self-share (no retroactive debt). Pass\n" +
          "[migrate]      { splitPartners: ['<chat_idA>', '<chat_idB>'] } to expand them\n" +
          "[migrate]      into 50/50 β pairs instead."
      );
    }
  }
  console.log("[migrate]   unknown shape  (preserved):" + stats.unknown);

  if (!commit) {
    console.log("[migrate] DRY RUN — re-call with { commit: true } to write.");
    return stats;
  }

  // 1. Backup. Duplicate is atomic and stays inside the same spreadsheet so
  //    the admin can spot-check side-by-side. If a backup with this date
  //    already exists, append a counter — never overwrite.
  var stamp = new Date().toISOString().slice(0, 10);
  var backupName = "Pre-β Backup " + stamp;
  var n = 1;
  while (ss.getSheetByName(backupName)) {
    n++;
    backupName = "Pre-β Backup " + stamp + " (" + n + ")";
  }
  sheet.copyTo(ss).setName(backupName);
  console.log("[migrate] backup tab created: " + backupName);

  // 2. Rewrite: clear existing data + header, write β header + converted rows.
  sheet.getRange(1, 1, lastRow, lastCol).clearContent();
  sheet.getRange(1, 1, 1, GROUP_SHEET_HEADERS.length).setValues([GROUP_SHEET_HEADERS]);
  if (converted.length) {
    sheet.getRange(2, 1, converted.length, G_COL_COUNT).setValues(converted);
  }
  try {
    sheet.hideColumns(G_MESSAGE_ID_COLUMN);
  } catch (_) {}
  console.log("[migrate] wrote " + converted.length + " rows under β header.");
  return stats;
}

// Heuristic classifier — runs on a single raw row from the legacy sheet.
// Returns one of: "beta" | "pre-beta-personal" | "pre-beta-split" | "unknown".
function _classifyLegacyGroupRow(r) {
  var col5 = String(r[4] || "").trim(); // β=Currency, pre-β=Category
  var col6 = String(r[5] || "").trim(); // β=PaidBy, pre-β=TxType
  var col8 = String(r[7] || "").trim(); // β=ShareAmount, pre-β=Split
  // β: col 5 is a 2–4-char alpha currency code AND col 8 is a finite > 0 number.
  if (/^[A-Z]{2,4}$/.test(col5) && isFinite(Number(col8)) && Number(col8) > 0) {
    return "beta";
  }
  // pre-β: col 8 says "Personal" or "Split" (the legacy Split status column).
  if (/^personal$/i.test(col8)) return "pre-beta-personal";
  if (/^split$/i.test(col8)) return "pre-beta-split";
  // Unknown shape — preserve as-is, let the operator review.
  return "unknown";
}

// Convert a pre-β personal/split row to a β self-share row.
// β columns: [emailDate, txDate, merchant, amount, currency, paidBy,
//             shareHolder, shareAmt, txId, category, txType, msgId]
//
// Pre-β source columns:
//   r[0] emailDate   r[1] txDate   r[2] merchant   r[3] amount
//   r[4] category    r[5] txType   r[6] user       r[7] split
//   r[8] messageId   r[9] currency r[10] link
//
// payer === holder by design → row preserved as history, contributes 0 to debts.
function _convertPreBetaRow(r, rowNum, userMap) {
  var amount = Number(r[3]) || 0;
  var user = String(r[6] || "").trim();
  var resolved = (userMap && userMap[user]) || user || "legacy";
  var currency = String(r[9] || "INR").trim() || "INR";
  return [
    r[0] || "", // email date
    r[1] || "", // tx date
    r[2] || "", // merchant
    amount, // amount
    currency, // currency
    resolved, // paid by
    resolved, // share holder (== payer → no debt)
    amount, // share amount = full amount (self-share)
    "legacy-" + rowNum, // tx id (stable per row)
    r[4] || "", // category
    r[5] || "", // tx type
    r[8] || "" // message id (Gmail dedupe key)
  ];
}

// Expand a pre-β Split row to TWO β rows for a known 2-person group.
// Returns the rows in order: [payer-self-share, partner-share].
//
// splitPartners = [chat_idA, chat_idB]. The payer is whichever of those two
// the row's User cell resolves to (via userMap if provided). If the row's
// User can't be mapped to one of the two partners, we default to partner[0]
// as payer and partner[1] as the debtor — the operator will see this in the
// stats and can re-run with a corrected userMap.
function _convertPreBetaSplitRow(r, rowNum, userMap, splitPartners) {
  var amount = Number(r[3]) || 0;
  var user = String(r[6] || "").trim();
  var resolvedUser = (userMap && userMap[user]) || user;
  var payer = splitPartners[0];
  var partner = splitPartners[1];
  if (resolvedUser === splitPartners[1]) {
    payer = splitPartners[1];
    partner = splitPartners[0];
  }
  var currency = String(r[9] || "INR").trim() || "INR";
  var half = Math.round((amount / 2) * 100) / 100;
  var txId = "legacy-" + rowNum;
  function row(holder, share) {
    return [
      r[0] || "",
      r[1] || "",
      r[2] || "",
      amount,
      currency,
      payer,
      holder,
      share,
      txId,
      r[4] || "",
      r[5] || "",
      r[8] || ""
    ];
  }
  return [row(payer, half), row(partner, half)];
}
