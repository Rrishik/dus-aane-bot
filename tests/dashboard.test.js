import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let buildLookerDashboardUrl;

beforeAll(() => {
  ({ buildLookerDashboardUrl } = loadAppsScript(["Dashboard.js"], ["buildLookerDashboardUrl"], {}));
});

describe("buildLookerDashboardUrl", () => {
  it("includes all required Linking API params with correct values", () => {
    var url = buildLookerDashboardUrl("REPORT123", "SHEET456", "Alice");
    expect(url).toContain("c.reportId=REPORT123");
    expect(url).toContain("c.mode=view");
    expect(url).toContain("ds.ds0.connector=googleSheets");
    expect(url).toContain("ds.ds0.spreadsheetId=SHEET456");
    expect(url).toContain("ds.ds0.worksheetId=0");
    expect(url).toContain("ds.ds0.refreshFields=false");
  });

  it("targets the Linking API endpoint", () => {
    var url = buildLookerDashboardUrl("R", "S", "");
    expect(url.startsWith("https://lookerstudio.google.com/reporting/create?")).toBe(true);
  });

  it("URL-encodes the report name with the tenant's name", () => {
    var url = buildLookerDashboardUrl("R", "S", "Alice");
    expect(url).toContain("r.reportName=Alice's%20Dus%20Aane%20Bot%20Dashboard");
  });

  it("falls back to a generic name when tenant name is empty", () => {
    var url = buildLookerDashboardUrl("R", "S", "");
    expect(url).toContain("r.reportName=Dus%20Aane%20Bot%20Dashboard");
    expect(url).not.toContain("'s");
  });

  it("URL-encodes non-ASCII tenant names", () => {
    var url = buildLookerDashboardUrl("R", "S", "Niño");
    expect(url).toContain("Ni%C3%B1o");
  });

  it("URL-encodes sheet IDs containing reserved chars (defensive)", () => {
    var url = buildLookerDashboardUrl("R", "a/b+c", "");
    expect(url).toContain("ds.ds0.spreadsheetId=a%2Fb%2Bc");
  });
});

describe("handleDashboardCommand", () => {
  function load(extraStubs) {
    var sent = [];
    var stubs = Object.assign(
      {
        sendTelegramMessage: function (chatId, msg, opts) {
          sent.push({ chatId: String(chatId), msg: msg, opts: opts || {} });
        },
        BOT_INBOX_EMAIL: "bot@example.com",
        TENANT_STATUS: { ACTIVE: "active", PENDING: "pending", DORMANT: "dormant", DISABLED: "disabled" },
        findTenantByChatId: function () {
          return null;
        },
        getSpreadsheet: function () {
          return { getSheets: () => [{ getLastRow: () => 5 }] };
        }
      },
      extraStubs || {}
    );
    var mod = loadAppsScript(["Dashboard.js"], ["handleDashboardCommand"], stubs);
    return { handleDashboardCommand: mod.handleDashboardCommand, sent: sent };
  }

  it("ACTIVE tenant with rows: sends dashboard URL with inline button", () => {
    var env = load({
      LOOKER_DASHBOARD_REPORT_ID: "REPORT123",
      findTenantByChatId: () => ({ status: "active", sheet_id: "S1", name: "Alice", chat_id: "111" })
    });
    env.handleDashboardCommand("111");
    expect(env.sent.length).toBe(1);
    var btn = env.sent[0].opts.reply_markup.inline_keyboard[0][0];
    expect(btn.text).toBe("📊 Open dashboard");
    expect(btn.url).toContain("c.reportId=REPORT123");
    expect(btn.url).toContain("ds.ds0.spreadsheetId=S1");
  });

  it("ACTIVE tenant with empty sheet: short-circuits with a 'no transactions' message", () => {
    var env = load({
      LOOKER_DASHBOARD_REPORT_ID: "REPORT123",
      findTenantByChatId: () => ({ status: "active", sheet_id: "S1", name: "Alice", chat_id: "111" }),
      getSpreadsheet: () => ({ getSheets: () => [{ getLastRow: () => 1 }] })
    });
    env.handleDashboardCommand("111");
    expect(env.sent.length).toBe(1);
    expect(env.sent[0].msg).toContain("No transactions logged yet");
    expect(env.sent[0].opts.reply_markup).toBeUndefined();
  });

  it("Missing LOOKER_DASHBOARD_REPORT_ID: explains the operator hasn't configured it", () => {
    var env = load({
      LOOKER_DASHBOARD_REPORT_ID: "",
      findTenantByChatId: () => ({ status: "active", sheet_id: "S1", name: "Alice", chat_id: "111" })
    });
    env.handleDashboardCommand("111");
    expect(env.sent.length).toBe(1);
    expect(env.sent[0].msg).toContain("LOOKER_DASHBOARD_REPORT_ID");
  });

  it("PENDING tenant: falls through with 'sheet isn't ready' message", () => {
    var env = load({
      LOOKER_DASHBOARD_REPORT_ID: "REPORT123",
      findTenantByChatId: () => ({ status: "pending", sheet_id: "", name: "Bob", chat_id: "222" })
    });
    env.handleDashboardCommand("222");
    expect(env.sent.length).toBe(1);
    expect(env.sent[0].msg).toMatch(/sheet isn't ready|Forward a bank email/i);
  });
});
