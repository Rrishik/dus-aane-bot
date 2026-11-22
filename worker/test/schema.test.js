import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestD1, migrationFiles } from "./helpers/d1.js";

const NOW = 1791460000000;
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

async function tenant(db, id, kind) {
  await db
    .prepare("INSERT INTO tenants (id, kind, status, created_at) VALUES (?, ?, 'active', ?)")
    .bind(id, kind || "personal", NOW)
    .run();
}

function txnInsert(db, over) {
  var t = Object.assign(
    {
      id: "t1",
      tenant_id: "111",
      occurred_on: "2026-10-07",
      amount_minor: 45000,
      currency: "INR",
      direction: "debit",
      kind: "spend"
    },
    over
  );
  return db
    .prepare(
      "INSERT INTO transactions (id, tenant_id, occurred_on, amount_minor, currency, direction, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(t.id, t.tenant_id, t.occurred_on, t.amount_minor, t.currency, t.direction, t.kind, NOW, NOW);
}

describe("migrations", () => {
  it("are numbered and apply cleanly to an empty database", async () => {
    expect(migrationFiles()).toEqual([
      "0001_init.sql",
      "0002_card_message_idx.sql",
      "0003_simplify_categories.sql",
      "0004_canonical_merchants_and_cards.sql"
    ]);
    var db = createTestD1();
    var indexes = (
      await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all()
    ).results.map((r) => r.name);
    expect(indexes).toContain("tx_by_card_msg");
    var tables = (
      await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    ).results.map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "tenants",
        "tenant_emails",
        "group_members",
        "group_invites",
        "transactions",
        "transaction_sources",
        "splits",
        "split_shares",
        "settlements",
        "merchant_rules",
        "account_labels",
        "ask_usage",
        "backfill_jobs",
        "parser_events",
        "settings",
        "ephemeral"
      ])
    );
  });

  it("0003_simplify_categories rewrites legacy categories and card_payment kind cleanly", async () => {
    var db = createTestD1();
    await tenant(db, "111");
    var legacy = [
      ["t-food", "debit", "spend", "Food & Dining", "Food", "spend"],
      ["t-fuel", "debit", "spend", "Fuel", "Travel", "spend"],
      ["t-subs", "debit", "spend", "Subscriptions", "Bills", "spend"],
      ["t-bills", "debit", "spend", "Bills & Utilities", "Bills", "spend"],
      ["t-cc", "debit", "card_payment", "CC Bill Payment", "Transfer", "transfer"],
      ["t-health", "debit", "spend", "Healthcare", "Health", "spend"],
      ["t-ent", "debit", "spend", "Entertainment", "Fun", "spend"],
      ["t-edu", "debit", "spend", "Education", "Shopping", "spend"],
      ["t-inv", "debit", "investment", "Investment", "Invest", "investment"],
      ["t-tout", "debit", "transfer", "Transfer Out", "Transfer", "transfer"],
      ["t-sal", "credit", "income", "Salary", "Income", "income"],
      ["t-int", "credit", "income", "Interest/Dividend", "Income", "income"],
      ["t-cb", "credit", "refund", "Cashback", "Refund", "refund"],
      ["t-reimb", "credit", "refund", "Reimbursement", "Refund", "refund"],
      ["t-tin", "credit", "transfer", "Transfer In", "Transfer", "transfer"]
    ];
    for (var [id, dir, kind, oldCat] of legacy) {
      await db
        .prepare(
          "INSERT INTO transactions (id, tenant_id, occurred_on, amount_minor, currency, direction, kind, category, created_at, updated_at) VALUES (?, '111', '2026-10-07', 1000, 'INR', ?, ?, ?, ?, ?)"
        )
        .bind(id, dir, kind, oldCat, NOW, NOW)
        .run();
      await db
        .prepare("INSERT INTO merchant_rules (tenant_id, pattern, category, updated_at) VALUES ('111', ?, ?, ?)")
        .bind(id, oldCat, NOW)
        .run();
    }
    await db.exec(readFileSync(resolve(MIGRATIONS_DIR, "0003_simplify_categories.sql"), "utf8"));
    for (var [id, , , , wantCat, wantKind] of legacy) {
      expect(await db.prepare("SELECT category, kind FROM transactions WHERE id = ?").bind(id).first()).toEqual({
        category: wantCat,
        kind: wantKind
      });
      expect(await db.prepare("SELECT category FROM merchant_rules WHERE pattern = ?").bind(id).first()).toEqual({
        category: wantCat
      });
    }
  });
});

describe("constraints", () => {
  it("rejects bad enums, dates, currencies and negative amounts", async () => {
    var db = createTestD1();
    await tenant(db, "111");
    await expect(txnInsert(db, { direction: "sideways" }).run()).rejects.toThrow(/CHECK/);
    await expect(txnInsert(db, { kind: "gift" }).run()).rejects.toThrow(/CHECK/);
    await expect(txnInsert(db, { occurred_on: "07/10/2026" }).run()).rejects.toThrow(/CHECK/);
    await expect(txnInsert(db, { currency: "RUPEES" }).run()).rejects.toThrow(/CHECK/);
    await expect(txnInsert(db, { amount_minor: -1 }).run()).rejects.toThrow(/CHECK/);
    await expect(txnInsert(db).run()).resolves.toBeTruthy();
  });

  it("enforces foreign keys and cascades tenant deletion", async () => {
    var db = createTestD1();
    await expect(txnInsert(db, { tenant_id: "nobody" }).run()).rejects.toThrow(/FOREIGN KEY/);

    await tenant(db, "111");
    await txnInsert(db).run();
    await db
      .prepare(
        "INSERT INTO transaction_sources (tenant_id, source, source_ref, transaction_id, received_at) VALUES ('111', 'sms', 'sms-1', 't1', ?)"
      )
      .bind(NOW)
      .run();
    await db.prepare("DELETE FROM tenants WHERE id = '111'").run();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM transactions").first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM transaction_sources").first("n")).toBe(0);
  });

  it("keys sources per tenant, so the same SMS hash can exist for two tenants", async () => {
    var db = createTestD1();
    await tenant(db, "111");
    await tenant(db, "222");
    await txnInsert(db).run();
    await txnInsert(db, { id: "t2", tenant_id: "222" }).run();
    var src = (tenantId, txnId) =>
      db
        .prepare(
          "INSERT INTO transaction_sources (tenant_id, source, source_ref, transaction_id, received_at) VALUES (?, 'sms', 'sms-same', ?, ?)"
        )
        .bind(tenantId, txnId, NOW);
    await src("111", "t1").run();
    await src("222", "t2").run();
    await expect(src("111", "t1").run()).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("allows at most one split per transaction", async () => {
    var db = createTestD1();
    await tenant(db, "111");
    await tenant(db, "-100", "group");
    await txnInsert(db).run();
    var split = (id) =>
      db
        .prepare(
          "INSERT INTO splits (id, transaction_id, group_id, payer_id, mode, created_at) VALUES (?, 't1', '-100', '111', '50', ?)"
        )
        .bind(id, NOW);
    await split("s1").run();
    await expect(split("s2").run()).rejects.toThrow(/UNIQUE/);
  });
});

describe("FakeD1 parity", () => {
  it("batch() is transactional", async () => {
    var db = createTestD1();
    await tenant(db, "111");
    await expect(db.batch([txnInsert(db), txnInsert(db)])).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM transactions").first("n")).toBe(0);
  });

  it("rejects undefined binds like D1", () => {
    var db = createTestD1();
    expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow(/undefined/);
  });
});
