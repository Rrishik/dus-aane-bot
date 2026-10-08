import { describe, it, expect } from "vitest";
import { loadAppsScript } from "../../tests/_loader.js";
import { testContext, NOW } from "./helpers/app.js";
import { buildImport, sheetGroupBalances, sqlValue, deterministicId } from "../scripts/import/sheets.mjs";
import { summarize } from "../scripts/import-sheets.mjs";
import { verifyImport, VERIFY_QUERIES, parseWranglerJson } from "../scripts/verify-import.mjs";
import { handleUpdate } from "../src/app/webhook.js";
import { getGroupMembers, getTenant, getTenantEmails } from "../src/db/tenants.js";
import { groupBalances, getSplitForTransaction } from "../src/db/splits.js";
import { getMerchantRules } from "../src/db/merchantRules.js";
import { getSetting } from "../src/db/settings.js";
import { insertTransaction } from "../src/db/transactions.js";

const d = (iso) => ({ $d: Date.parse(iso) });
const SMS = "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 05/10/26 Ref 628012345678 Not You? Call 18002586161";
const personalRow = (o) => {
  const r = [d("2026-10-07T08:00:00Z"), d("2026-10-06T18:30:00Z"), "Swiggy", 900, "Food & Dining", "Debit", "alice"];
  r.push("gm1", "INR", "", "", "llm", "", "");
  for (const [k, v] of Object.entries(o)) r[Number(k)] = v;
  return r;
};
const groupRow = (payer, holder, share, txId, category = "Food & Dining", msgId = 55) => [
  d("2026-10-07T08:00:00Z"),
  d("2026-10-07T08:00:00Z"),
  "Swiggy",
  900,
  "INR",
  payer,
  holder,
  share,
  txId,
  category,
  category === "Settlement" ? "Settlement" : "Debit",
  msgId
];

function sampleDump({ orphan = true } = {}) {
  const groupRows = [
    groupRow("111", "111", 450, "tx1"),
    groupRow("111", "222", 450, "tx1"),
    groupRow("111", "222", 300, "tx2", "Settlement", 56),
    groupRow("222", "111", 100, "tx3", "Settlement", 57)
  ];
  if (orphan) groupRows.push(groupRow("222", "111", 80, "tx4"));
  return {
    version: 1,
    tenants: [
      {
        chat_id: "111",
        name: "Alice",
        emails: ["Alice@x.com"],
        sheet_id: "s111",
        status: "active",
        created_at: d("2026-01-01T00:00:00Z"),
        last_forward_at: d("2026-10-07T08:00:00Z"),
        nag_count: 0,
        chat_type: "personal",
        group_members: [],
        primary_currency: "INR",
        ask_used_today: 2,
        ask_used_date: "2026-10-07",
        ask_lifetime_count: 40,
        ask_cap_hit_count: 1
      },
      { chat_id: "222", name: "Bob", emails: ["bob@x.com"], sheet_id: "s222", status: "active", chat_type: "personal" },
      {
        chat_id: "-100",
        name: "Flat",
        status: "active",
        notes: "admin=111",
        chat_type: "group",
        sheet_id: "g100",
        group_members: ["111", "222", "999"],
        pin_message_id: "77",
        created_at: "2026-02-01T00:00:00.000Z"
      }
    ],
    personal: {
      111: {
        rows: [
          personalRow({ 9: "-100:tx1", 10: 55 }),
          personalRow({
            1: "2026-10-05",
            2: "Unknown",
            3: 250,
            4: "",
            7: "sms-abc",
            11: "hdfc_upi|rr",
            12: SMS,
            13: "review"
          }),
          personalRow({ 5: "Unknown", 7: "gm-bad" }),
          personalRow({ 3: 1, 7: "gm1" }),
          personalRow({ 2: "Bob", 3: 300, 4: "Transfer Out", 7: "gm2", 9: "-100:tx2", 10: 56 }),
          personalRow({ 2: "O'Reilly", 3: 12.5, 7: "gm3", 8: "usd" })
        ],
        myMerchants: [["Swiggy", "Swiggy", "Food & Dining"]]
      },
      222: { rows: [personalRow({ 2: "Salary", 3: 50000, 4: "Salary", 5: "Credit", 6: "bob", 7: "gm9" })] }
    },
    groups: { "-100": { rows: groupRows } },
    shared: { resolutions: [["ZOMATO LTD", "Zomato"]], overrides: [["zomato", "Food & Dining"]] },
    settings: { "parser.mode": "shadow", "parser.disabledTemplates": "" }
  };
}

async function imported(dump = sampleDump(), times = 1) {
  const ctx = testContext();
  const { sql, report } = buildImport(dump, { now: NOW });
  for (let i = 0; i < times; i++) await ctx.db.exec(sql.join("\n"));
  return { ctx, report, sql };
}

const idFor = (tenant, source, ref, iso = "2026-10-07T08:00:00Z") =>
  deterministicId(Date.parse(iso), tenant + "|" + source + "|" + ref);

async function verifyAgainst(ctx, report, opts) {
  const rows = async (sql) => (await ctx.db.prepare(sql).all()).results;
  return verifyImport(
    report,
    {
      totals: await rows(VERIFY_QUERIES.totals),
      owed: await rows(VERIFY_QUERIES.owed),
      paid: await rows(VERIFY_QUERIES.paid)
    },
    opts
  );
}

describe("Sheets → D1 import", () => {
  it("imports tenants, emails, members (in order), quota, rules and settings", async () => {
    const { ctx, report } = await imported();
    expect(await getTenant(ctx.db, "111")).toMatchObject({ kind: "personal", name: "Alice", status: "active" });
    expect((await getTenant(ctx.db, "111")).last_activity_at).toBe(Date.parse("2026-10-07T08:00:00Z"));
    expect(await getTenant(ctx.db, "-100")).toMatchObject({ kind: "group", admin_id: "111", pin_message_id: "77" });
    expect(await getTenantEmails(ctx.db, "111")).toEqual(["alice@x.com"]);
    expect(await getGroupMembers(ctx.db, "-100")).toEqual(["111", "222"]);
    expect(report.warnings).toEqual(["group member without a tenant row dropped"]);
    expect(await ctx.db.prepare("SELECT * FROM ask_usage WHERE tenant_id = '111'").first()).toMatchObject({
      used_on: "2026-10-07",
      used_today: 2,
      lifetime: 40,
      cap_hits: 1
    });
    const rules = await getMerchantRules(ctx.db, "111");
    expect(rules.find((r) => r.personal)).toMatchObject({
      pattern: "swiggy",
      name: "Swiggy",
      category: "Food & Dining"
    });
    expect(rules.filter((r) => !r.personal).map((r) => [r.pattern, r.name, r.category])).toEqual([
      ["zomato ltd", "Zomato", null],
      ["zomato", null, "Food & Dining"]
    ]);
    expect(await getSetting(ctx.db, "parser.mode")).toBe("shadow");
  });

  it("maps rows to transactions and sources, skipping bad and duplicate rows", async () => {
    const { ctx, report } = await imported();
    expect(report.skipped.map((s) => s.reason)).toEqual([
      "bad type",
      "duplicate message id",
      "split without the payer's transaction"
    ]);
    const all = (await ctx.db.prepare("SELECT * FROM transactions WHERE tenant_id = '111' ORDER BY amount_minor").all())
      .results;
    expect(all.map((t) => [t.amount_minor, t.currency, t.kind, t.merchant, t.occurred_on, t.status])).toEqual([
      [1250, "USD", "spend", "O'Reilly", "2026-10-07", "confirmed"],
      [25000, "INR", "spend", null, "2026-10-05", "review"],
      [30000, "INR", "transfer", "Bob", "2026-10-07", "confirmed"],
      [90000, "INR", "spend", "Swiggy", "2026-10-07", "confirmed"]
    ]);
    const sms = all[1];
    expect(sms).toMatchObject({ account_last4: "1234", reference: "628012345678" });
    expect(
      await ctx.db.prepare("SELECT * FROM transaction_sources WHERE source_ref = 'sms-abc'").first()
    ).toMatchObject({
      source: "sms",
      parsed_by: "hdfc_upi",
      reread: 1,
      raw_text: SMS
    });
    expect(sms.id).toBe(idFor("111", "sms", "sms-abc"));
  });

  it("rebuilds splits and settlements; balances match Groups.js", async () => {
    const dump = sampleDump({ orphan: false });
    const { ctx, report } = await imported(dump);
    const split = await getSplitForTransaction(ctx.db, idFor("111", "email", "gm1"));
    expect(split).toMatchObject({ group_id: "-100", payer_id: "111", mode: "import", group_message_id: 55 });
    expect(split.shares).toEqual([
      { holder_id: "111", amount_minor: 45000 },
      { holder_id: "222", amount_minor: 45000 }
    ]);
    const settles = (await ctx.db.prepare("SELECT * FROM settlements ORDER BY amount_minor").all()).results;
    expect(settles.map((s) => [s.from_id, s.to_id, s.amount_minor, s.transaction_id])).toEqual([
      ["222", "111", 10000, null],
      ["111", "222", 30000, idFor("111", "email", "gm2")]
    ]);

    const { aggregatePairwiseDebts } = loadAppsScript(["Groups.js"], ["aggregatePairwiseDebts"], {
      G_CURRENCY_COLUMN: 5,
      G_PAID_BY_COLUMN: 6,
      G_SHARE_HOLDER_COLUMN: 7,
      G_SHARE_AMOUNT_COLUMN: 8,
      G_CATEGORY_COLUMN: 10
    });
    const legacy = aggregatePairwiseDebts(dump.groups["-100"].rows);
    const asMajor = (o) =>
      Object.fromEntries(
        Object.entries(o).map(([c, l]) => [
          c,
          l.map((e) => ({ debtor: e.debtor, creditor: e.creditor, amount: e.amountMinor / 100 }))
        ])
      );
    expect(asMajor(sheetGroupBalances(dump.groups["-100"].rows))).toEqual(legacy);
    expect(await groupBalances(ctx.db, "-100")).toEqual(report.expected.groups["-100"]);
    expect(await verifyAgainst(ctx, report)).toEqual([]);
  });

  it("verification flags what didn't make it", async () => {
    const { ctx, report } = await imported();
    expect(await verifyAgainst(ctx, report)).toEqual(["group …100: balances differ"]);
    await ctx.db.exec("DELETE FROM transactions WHERE tenant_id = '222'");
    expect(await verifyAgainst(ctx, report)).toEqual([
      "tenant …222: 0 rows, expected 1",
      "tenant …222: INR:credit total differs",
      "group …100: balances differ"
    ]);
  });

  it("is idempotent and never resurrects or duplicates", async () => {
    const { ctx, sql, report } = await imported(sampleDump(), 2);
    const count = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions").first("n");
    expect(await count()).toBe(report.transactions);
    expect(await ctx.db.prepare("SELECT COUNT(*) AS n FROM split_shares").first("n")).toBe(2);

    await ctx.db.exec("UPDATE transactions SET status = 'deleted' WHERE merchant = 'O''Reilly'");
    await ctx.db.exec(sql.join("\n"));
    expect(await ctx.db.prepare("SELECT status FROM transactions WHERE merchant = 'O''Reilly'").first("status")).toBe(
      "deleted"
    );
    expect(await verifyAgainst(ctx, report, { strict: false })).toEqual([]);
  });

  it("skips rows the Worker already saved after cutover (and their split)", async () => {
    const ctx = testContext();
    const { sql } = buildImport(sampleDump(), { now: NOW });
    await ctx.db.exec(sql.slice(0, 5).join("\n"));
    const live = await insertTransaction(
      ctx.db,
      "111",
      { occurredOn: "2026-10-07", amountMinor: 90000, currency: "INR", direction: "debit", kind: "spend" },
      { source: "email", sourceRef: "gm1" },
      NOW
    );
    await ctx.db.exec(sql.join("\n"));
    const rows = (await ctx.db.prepare("SELECT id FROM transactions WHERE amount_minor = 90000").all()).results;
    expect(rows.map((r) => r.id)).toEqual([live]);
    expect(await ctx.db.prepare("SELECT COUNT(*) AS n FROM splits").first("n")).toBe(0);
  });

  it("old cards keep working through their Gmail/SMS ids", async () => {
    const { ctx } = await imported();
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb",
        data: "help_sms-abc",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: 9 }
      }
    });
    const kb = ctx.tg.of("editMessageReplyMarkup").at(-1).args[2].inline_keyboard;
    expect(kb.at(-1)[0].callback_data).toBe("back_" + idFor("111", "sms", "sms-abc"));
  });

  it("escapes SQL and keeps public logs free of ids and amounts", () => {
    expect(sqlValue("O'Reilly")).toBe("'O''Reilly'");
    expect([sqlValue(null), sqlValue(NaN), sqlValue(true), sqlValue(12.5)]).toEqual(["NULL", "NULL", "1", "12.5"]);
    const { report } = buildImport(sampleDump(), { now: NOW });
    const text = summarize(report);
    expect(text).toContain("transactions: 5");
    expect(text).not.toMatch(/111|222|-100|Alice|Swiggy|900/);
    expect(parseWranglerJson('wrangler 4\n[{"results":[{"n":1}]}]')).toEqual([{ n: 1 }]);
  });
});
