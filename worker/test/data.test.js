import { describe, it, expect } from "vitest";
import { testContext, seedTenant, seedGroup } from "./helpers/app.js";
import { handleUpdate } from "../src/app/webhook.js";
import { ingest } from "../src/app/ingest.js";
import { getTenant, getGroupMembers } from "../src/db/tenants.js";
import { createSplit, groupBalances } from "../src/db/splits.js";
import { upsertMerchantRule, getMerchantRules } from "../src/db/merchantRules.js";
import { getSetting } from "../src/db/settings.js";
import { parseExportRange, toCsv, EXPORT_HEADER } from "../src/app/data.js";

const SMS = (amount, date, ref) =>
  "Sent Rs." + amount + " From HDFC Bank A/C *1234 To SWIGGY On " + date + " Ref " + ref + " Not You? Call 18002586161";
const msg = (text, chat = 111) => ({
  message: { chat: { id: chat, type: "private" }, from: { id: chat, first_name: "A" }, text }
});
const tap = (data, messageId = 500, chat = 111) => ({
  callback_query: { id: "cb", data, from: { id: chat }, message: { chat: { id: chat }, message_id: messageId } }
});

async function withTxns(opts) {
  const ctx = testContext(opts);
  const tenant = await seedTenant(ctx, "111", { email: "a@x.com" });
  const a = await ingest(ctx, {
    tenant,
    source: "sms",
    sourceRef: "s1",
    text: SMS("900.00", "07/10/26", "628012345678")
  });
  const b = await ingest(ctx, {
    tenant,
    source: "sms",
    sourceRef: "s2",
    text: SMS("100.00", "03/09/26", "628012345679")
  });
  ctx.tg.calls.length = 0;
  return { ctx, ids: [a.transactionId, b.transactionId] };
}

describe("/export", () => {
  it("parses ranges", () => {
    expect(parseExportRange("/export")).toEqual({ from: null, to: null });
    expect(parseExportRange("/export 2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(parseExportRange("/export 2026-01-01 2026-03-31")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(parseExportRange("/export 2026-03-31 2026-01-01")).toBeNull();
    expect(parseExportRange("/export 2026-13")).toBeNull();
    expect(parseExportRange("/export last month")).toBeNull();
  });

  it("CSV escapes quotes/commas and neutralises formulas", () => {
    expect(toCsv([["a,b", 'say "hi"', "=HYPERLINK(1)", -5, "-x", "ok"]])).toBe(
      '"a,b","say ""hi""",\'=HYPERLINK(1),-5,\'-x,ok\r\n'
    );
  });

  it("sends a CSV with your share for split rows, and a Sheets button", async () => {
    const { ctx, ids } = await withTxns();
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"]);
    await createSplit(ctx.db, {
      transactionId: ids[0],
      groupId: "-100",
      payerId: "111",
      mode: "50",
      shares: [
        { holderId: "111", amountMinor: 45000 },
        { holderId: "222", amountMinor: 45000 }
      ]
    });
    await handleUpdate(ctx, msg("/export"));
    const [doc] = ctx.tg.of("sendDocument");
    const { filename, content, caption, replyMarkup } = doc.args[1];
    expect(filename).toBe("dus-aane-bot-all.csv");
    expect(caption).toBe("2 transactions · all time");
    const lines = content.trim().split("\r\n");
    expect(lines[0]).toBe(EXPORT_HEADER.join(","));
    expect(lines[1]).toMatch(/^2026-09-03,.*,100,INR,Debit,/);
    expect(lines[2]).toMatch(/^2026-10-07,.*,900,INR,Debit,.*,450,1234,628012345678,/);
    expect(replyMarkup.inline_keyboard[0][0].callback_data).toBe("export_sheet_all");

    await handleUpdate(ctx, msg("/export 2026-09"));
    expect(ctx.tg.of("sendDocument")[1].args[1].caption).toBe("1 transactions · 2026-09-01 → 2026-09-30");
    await handleUpdate(ctx, msg("/export 2025-01"));
    expect(ctx.tg.of("sendMessage").at(-1).args[1]).toContain("No transactions");
  });

  it("Export to Sheet reuses the tenant's sheet", async () => {
    const calls = [];
    const { ctx } = await withTxns({
      appsScript: (action, p) => {
        calls.push(p);
        return { ok: true, sheetId: p.sheetId || "sheet-1", url: "https://docs/sheet-1" };
      }
    });
    await handleUpdate(ctx, tap("export_sheet_2026-10-01_2026-10-31"));
    expect(ctx.asCalls[0].action).toBe("export_to_sheet");
    expect(calls[0]).toMatchObject({ sheetId: "", emails: ["a@x.com"], header: EXPORT_HEADER });
    expect(calls[0].rows).toHaveLength(1);
    expect(await getSetting(ctx.db, "export_sheet:111")).toBe("sheet-1");
    const sent = ctx.tg.of("sendMessage").at(-1).args;
    expect(sent[1]).toContain("Exported 1 transactions");
    expect(sent[2].reply_markup.inline_keyboard[0][0].url).toBe("https://docs/sheet-1");

    await handleUpdate(ctx, tap("export_sheet_all"));
    expect(calls[1]).toMatchObject({ sheetId: "sheet-1" });
    expect(calls[1].rows).toHaveLength(2);
  });

  it("reports Apps Script failures", async () => {
    const { ctx } = await withTxns({ appsScript: () => ({ ok: false, error: "drive quota" }) });
    await handleUpdate(ctx, tap("export_sheet_all"));
    expect(ctx.tg.of("sendMessage").at(-1).args[1]).toContain("Couldn't create the Google Sheet");
  });
});

describe("/deletemydata", () => {
  it("asks first; Keep leaves everything", async () => {
    const { ctx } = await withTxns();
    await handleUpdate(ctx, msg("/deletemydata"));
    const kb = ctx.tg.of("sendMessage").at(-1).args[2].reply_markup.inline_keyboard[0];
    expect(kb.map((b) => b.callback_data)).toEqual(["wipe_yes", "wipe_no"]);
    await handleUpdate(ctx, tap("wipe_no"));
    expect(ctx.tg.of("editMessageText").at(-1).args[2]).toContain("Nothing was deleted");
    expect(await getTenant(ctx.db, "111")).not.toBeNull();
  });

  it("deletes the tenant's data, keeps others' group balances whole, and refreshes pins", async () => {
    const { ctx, ids } = await withTxns();
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"]);
    await upsertMerchantRule(ctx.db, "111", "SWIGGY", { category: "Groceries" });
    const other = await ingest(ctx, {
      tenant: await getTenant(ctx.db, "222"),
      source: "sms",
      sourceRef: "o1",
      text: SMS("400.00", "07/10/26", "628012345670")
    });
    await createSplit(ctx.db, {
      transactionId: ids[0],
      groupId: "-100",
      payerId: "111",
      mode: "p100",
      shares: [{ holderId: "222", amountMinor: 90000 }]
    });
    await createSplit(ctx.db, {
      transactionId: other.transactionId,
      groupId: "-100",
      payerId: "222",
      mode: "p100",
      shares: [{ holderId: "111", amountMinor: 40000 }]
    });

    await handleUpdate(ctx, tap("wipe_yes"));
    expect(await getTenant(ctx.db, "111")).toBeNull();
    const count = (sql) => ctx.db.prepare(sql).first("n");
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE tenant_id = '111'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM transaction_sources WHERE tenant_id = '111'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tenant_emails WHERE tenant_id = '111'")).toBe(0);
    expect(await getMerchantRules(ctx.db, "111")).toEqual(
      (await getMerchantRules(ctx.db, "999")).filter((r) => r.tenant_id === "")
    );
    expect(await getGroupMembers(ctx.db, "-100")).toEqual(["222"]);
    expect(await groupBalances(ctx.db, "-100")).toEqual({
      INR: [{ debtor: "111", creditor: "222", amountMinor: 40000 }]
    });
    expect(ctx.tg.of("sendMessage").some((c) => c.args[0] === "-100" && c.args[1].includes("live balances"))).toBe(
      true
    );
    expect(ctx.tg.of("editMessageText").at(-1).args[2]).toContain("all your data is deleted");

    await handleUpdate(ctx, msg("/start"));
    expect(ctx.tg.of("sendMessage").at(-1).args[1]).toContain("/register");
  });

  it("works for pending tenants", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111", { status: "pending" });
    await handleUpdate(ctx, msg("/deletemydata"));
    await handleUpdate(ctx, tap("wipe_yes"));
    expect(await getTenant(ctx.db, "111")).toBeNull();
  });
});
