// Dashboard: /dashboard — open a Looker Studio report wired to the tenant's sheet.
//
// Uses Google's Looker Studio Linking API. The bot never owns or stores a
// per-tenant report — it builds a deterministic URL that pre-configures the
// master report's data source to point at the tenant's sheet. The user clicks
// "Edit and share" once and Looker Studio saves a copy to *their* Drive.
//
// Why Linking API and not Drive-clone-and-share: Drive-API-based report
// management has been deprecated; Linking API is now the only supported
// programmatic path. Embedded data source + Replace mode means tenants need
// no view access to our master sheet — clean per-tenant isolation.
//
// Operator must set LOOKER_DASHBOARD_REPORT_ID in AConfig.js (and the matching
// CI secret) after building the master report. See README's admin setup.

var LOOKER_LINKING_BASE = "https://lookerstudio.google.com/reporting/create";

/**
 * Build a Linking API URL that opens the master report with the tenant's
 * Google Sheet swapped in as the data source.
 *
 * Pure function — no Apps Script globals, fully unit-testable.
 *
 *   reportId   Master report ID (LOOKER_DASHBOARD_REPORT_ID).
 *   sheetId    Tenant's spreadsheet ID.
 *   tenantName Display name used as the saved-report title; may be empty.
 */
function buildLookerDashboardUrl(reportId, sheetId, tenantName) {
  var name = tenantName ? tenantName + "'s Dus Aane Bot Dashboard" : "Dus Aane Bot Dashboard";
  // refreshFields=false: keep field types/aggregations from the template so a
  // tenant's sheet (same schema) renders charts identically. Set to true only
  // when the column schema diverges.
  var params = [
    "c.reportId=" + encodeURIComponent(reportId),
    "c.mode=view",
    "r.reportName=" + encodeURIComponent(name),
    "ds.ds0.connector=googleSheets",
    "ds.ds0.spreadsheetId=" + encodeURIComponent(sheetId),
    "ds.ds0.worksheetId=0",
    "ds.ds0.refreshFields=false"
  ];
  return LOOKER_LINKING_BASE + "?" + params.join("&");
}

function handleDashboardCommand(chatId) {
  var tenant = findTenantByChatId(chatId);
  // gateTenantForCommand has already filtered out non-active tenants by the
  // time we get here (see BotHandlers.handleMessage), but keep the defensive
  // check — handlers must be safe to call directly from tests / future paths.
  if (!tenant || tenant.status !== TENANT_STATUS.ACTIVE || !tenant.sheet_id) {
    sendTelegramMessage(chatId, "⏳ Your sheet isn't ready yet. Forward a bank email to finish setup first.", {
      parse_mode: "Markdown"
    });
    return;
  }

  var reportId = typeof LOOKER_DASHBOARD_REPORT_ID !== "undefined" ? LOOKER_DASHBOARD_REPORT_ID : "";
  if (!reportId) {
    sendTelegramMessage(
      chatId,
      "⚙️ Dashboards aren't configured for this deployment yet. Ask the operator to set `LOOKER_DASHBOARD_REPORT_ID`.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Empty-sheet check: Looker Studio renders "no data" everywhere when the
  // sheet has only a header row. Better to short-circuit with a Telegram-side
  // explanation than send them into a dead dashboard.
  try {
    var sheet = getSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() <= 1) {
      sendTelegramMessage(
        chatId,
        "📊 No transactions logged yet. Forward a bank email to `" + BOT_INBOX_EMAIL + "` and try `/dashboard` again.",
        { parse_mode: "Markdown" }
      );
      return;
    }
  } catch (e) {
    console.error("[handleDashboardCommand] row-count check failed:", e.message);
    // Fall through — better to send the dashboard URL than to block on a
    // transient Sheets read error.
  }

  var url = buildLookerDashboardUrl(reportId, tenant.sheet_id, tenant.name);
  sendTelegramMessage(
    chatId,
    "📊 *Your dashboard*\n\n" +
      "Tap below to open. First time? Click *Edit and share* in Looker Studio to save a personal copy to your Drive — it'll stay wired to your sheet.",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "📊 Open dashboard", url: url }]] }
    }
  );
}
