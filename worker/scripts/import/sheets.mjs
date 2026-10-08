// Google Sheets dump (Apps Script `export_dump`) → idempotent D1 SQL.
//
// Node-only (node:crypto); never bundled into the Worker. Every row gets a
// deterministic id so re-running the import upserts instead of duplicating,
// and every insert is guarded so one bad row can't fail the whole file on a
// foreign key:
//   * a transaction whose source already belongs to another transaction
//     (the Worker saved it after cutover) is skipped;
//   * deleted transactions are never resurrected;
//   * sources, splits, shares and settlements only attach to rows that exist.
import { createHash } from "node:crypto";
import { parseTransactionText } from "../../src/parser/index.js";
import { defaultKind } from "../../src/util/kind.js";
import { istDate } from "../../src/util/dates.js";
import { toMinor } from "../../src/util/money.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const STATUSES = ["pending", "active", "dormant", "disabled"];
// Personal sheet columns A–N and group sheet columns A–L (0-based).
const P = {
  EMAIL_DATE: 0,
  TX_DATE: 1,
  MERCHANT: 2,
  AMOUNT: 3,
  CATEGORY: 4,
  TYPE: 5,
  USER: 6,
  MSG_ID: 7,
  CURRENCY: 8,
  GROUP_REF: 9,
  PARSED_BY: 11,
  SOURCE_TEXT: 12,
  STATUS: 13
};
const G = { EMAIL_DATE: 0, CURRENCY: 4, PAID_BY: 5, HOLDER: 6, SHARE: 7, TX_ID: 8, CATEGORY: 9, MSG_ID: 11 };

// ULID-shaped id: creation-time prefix, entropy from a stable seed.
export function deterministicId(ms, seed) {
  let time = "";
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = createHash("sha256").update(seed).digest();
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}

export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
const vals = (...xs) => xs.map(sqlValue).join(", ");

// Dump cells: Date → { $d: ms }; ISO strings and numbers pass through.
export function toMs(v) {
  if (v && typeof v === "object" && typeof v.$d === "number") return v.$d;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function occurredOn(txDate, receivedAt) {
  if (typeof txDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(txDate.trim())) return txDate.trim();
  const ms = toMs(txDate);
  return istDate(ms != null ? ms : receivedAt);
}

const str = (v) => (v == null ? "" : String(v).trim());
const nullIfEmpty = (v) => str(v) || null;

// Mirrors Groups.js aggregatePairwiseDebts, in minor units.
export function sheetGroupBalances(rows) {
  const ledger = {};
  for (const r of rows || []) {
    const currency = str(r[G.CURRENCY]);
    const payer = str(r[G.PAID_BY]);
    const holder = str(r[G.HOLDER]);
    const amt = Number(r[G.SHARE]);
    if (!currency || !payer || !holder || !Number.isFinite(amt) || amt <= 0 || payer === holder) continue;
    const [debtor, creditor, sign] = str(r[G.CATEGORY]) === "Settlement" ? [payer, holder, -1] : [holder, payer, 1];
    const [a, b, s] = debtor < creditor ? [debtor, creditor, sign] : [creditor, debtor, -sign];
    ledger[currency] = ledger[currency] || {};
    ledger[currency][a + "|" + b] = (ledger[currency][a + "|" + b] || 0) + s * toMinor(amt);
  }
  const out = {};
  for (const ccy of Object.keys(ledger)) {
    const entries = [];
    for (const [key, net] of Object.entries(ledger[ccy])) {
      if (net === 0) continue;
      const [a, b] = key.split("|");
      entries.push(
        net > 0 ? { debtor: a, creditor: b, amountMinor: net } : { debtor: b, creditor: a, amountMinor: -net }
      );
    }
    if (entries.length) {
      entries.sort(
        (x, y) =>
          y.amountMinor - x.amountMinor ||
          (x.debtor < y.debtor ? -1 : x.debtor > y.debtor ? 1 : x.creditor < y.creditor ? -1 : 1)
      );
      out[ccy] = entries;
    }
  }
  return out;
}

function tenantSql(t, now) {
  const kind = t.chat_type === "group" ? "group" : "personal";
  const status = STATUSES.includes(t.status) ? t.status : "pending";
  const admin = (str(t.notes).match(/admin=(\S+)/) || [])[1] || null;
  const ccy = str(t.primary_currency).toUpperCase();
  return (
    "INSERT INTO tenants (id, kind, name, status, primary_currency, admin_id, pin_message_id, created_at, last_activity_at, last_nag_at, nag_count) VALUES (" +
    vals(
      str(t.chat_id),
      kind,
      str(t.name),
      status,
      /^[A-Z]{3}$/.test(ccy) ? ccy : "INR",
      kind === "group" ? admin : null,
      kind === "group" ? nullIfEmpty(t.pin_message_id) : null,
      toMs(t.created_at) || now,
      toMs(t.last_forward_at),
      toMs(t.last_nag_at),
      Number(t.nag_count) || 0
    ) +
    ") ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, status = excluded.status, " +
    "primary_currency = excluded.primary_currency, admin_id = excluded.admin_id, pin_message_id = excluded.pin_message_id, " +
    "created_at = excluded.created_at, last_activity_at = excluded.last_activity_at, last_nag_at = excluded.last_nag_at, nag_count = excluded.nag_count;"
  );
}

function transactionSql(tenantId, r, now, report, expected) {
  const ref = str(r[P.MSG_ID]);
  const amount = Number(r[P.AMOUNT]);
  const type = str(r[P.TYPE]).toLowerCase();
  if (!Number.isFinite(amount) || amount < 0) return { error: "bad amount" };
  if (type !== "debit" && type !== "credit") return { error: "bad type" };

  const source = ref.startsWith("sms-") ? "sms" : "email";
  const receivedAt = toMs(r[P.EMAIL_DATE]) || now;
  const ccyRaw = str(r[P.CURRENCY]).toUpperCase();
  const currency = /^[A-Z]{3}$/.test(ccyRaw) ? ccyRaw : "INR";
  const merchant = str(r[P.MERCHANT]);
  const category = nullIfEmpty(r[P.CATEGORY]);
  const parsedByRaw = str(r[P.PARSED_BY]);
  const rawText = source === "sms" ? nullIfEmpty(r[P.SOURCE_TEXT]) : null;
  const amountMinor = toMinor(amount);

  // Pasted SMS text still carries the account and reference.
  let account = null;
  let reference = null;
  if (rawText) {
    try {
      const p = parseTransactionText(rawText, { channel: "sms", receivedAt: new Date(receivedAt) });
      if (p && p.kind === "transaction" && Math.abs(p.amount - amount) < 0.005) {
        account = p.accountLast4 || null;
        reference = p.reference || null;
      }
    } catch (_) {}
  }

  const id = deterministicId(receivedAt, tenantId + "|" + source + "|" + ref);
  const statements = [
    "INSERT INTO transactions (id, tenant_id, occurred_on, amount_minor, currency, direction, kind, merchant_raw, merchant, " +
      "category, account_last4, reference, forwarder, status, review_note, card_message_id, created_at, updated_at) SELECT " +
      vals(
        id,
        tenantId,
        occurredOn(r[P.TX_DATE], receivedAt),
        amountMinor,
        currency,
        type,
        defaultKind(type, category),
        null,
        merchant && merchant !== "Unknown" ? merchant : null,
        category,
        account,
        reference,
        nullIfEmpty(r[P.USER]),
        str(r[P.STATUS]) === "review" ? "review" : "confirmed",
        null,
        null,
        receivedAt,
        now
      ) +
      " WHERE NOT EXISTS (SELECT 1 FROM transaction_sources WHERE tenant_id = " +
      sqlValue(tenantId) +
      " AND source = " +
      sqlValue(source) +
      " AND source_ref = " +
      sqlValue(ref) +
      " AND transaction_id <> " +
      sqlValue(id) +
      ") ON CONFLICT (id) DO UPDATE SET occurred_on = excluded.occurred_on, amount_minor = excluded.amount_minor, " +
      "currency = excluded.currency, direction = excluded.direction, kind = excluded.kind, merchant = excluded.merchant, " +
      "category = excluded.category, account_last4 = COALESCE(transactions.account_last4, excluded.account_last4), " +
      "reference = COALESCE(transactions.reference, excluded.reference), forwarder = excluded.forwarder, " +
      "status = excluded.status, updated_at = excluded.updated_at WHERE transactions.status <> 'deleted';",
    "INSERT INTO transaction_sources (tenant_id, source, source_ref, transaction_id, parsed_by, confidence, reread, raw_text, received_at) SELECT " +
      vals(
        tenantId,
        source,
        ref,
        id,
        parsedByRaw.replace(/\|rr$/, "") || null,
        null,
        parsedByRaw.endsWith("|rr") ? 1 : 0,
        rawText,
        receivedAt
      ) +
      " WHERE EXISTS (SELECT 1 FROM transactions WHERE id = " +
      sqlValue(id) +
      ") ON CONFLICT DO NOTHING;"
  ];
  report.transactions++;
  expected.count++;
  const k = currency + ":" + type;
  expected.sums[k] = (expected.sums[k] || 0) + amountMinor;
  return { id, statements };
}

function groupSql(gid, rows, groupRefs, now, report, skip) {
  const sql = [];
  const byTx = new Map();
  rows.forEach((r, i) => {
    const txId = str(r[G.TX_ID]);
    if (!txId) return skip("group " + gid + " row " + (i + 2), "no tx id");
    if (!byTx.has(txId)) byTx.set(txId, []);
    byTx.get(txId).push(r);
  });

  for (const [txId, txRows] of byTx) {
    const where = "group " + gid + " tx " + txId;
    const createdAt = toMs(txRows[0][G.EMAIL_DATE]) || now;
    const msgId = Number(txRows[0][G.MSG_ID]) || null;
    const linked = groupRefs[gid + ":" + txId];

    if (txRows.some((r) => str(r[G.CATEGORY]) === "Settlement")) {
      txRows.forEach((r, i) => {
        const amt = Number(r[G.SHARE]);
        const from = str(r[G.PAID_BY]);
        const to = str(r[G.HOLDER]);
        const ccy = str(r[G.CURRENCY]).toUpperCase();
        if (!(amt > 0) || !from || !to || !/^[A-Z]{3}$/.test(ccy)) return skip(where, "bad settlement row");
        const txnRef =
          linked && i === 0 && linked.tenantId === from
            ? "(SELECT id FROM transactions WHERE id = " + sqlValue(linked.id) + ")"
            : "NULL";
        sql.push(
          "INSERT INTO settlements (id, group_id, transaction_id, from_id, to_id, amount_minor, currency, group_message_id, created_at) VALUES (" +
            vals(deterministicId(createdAt, "settle|" + gid + "|" + txId + "|" + i), gid) +
            ", " +
            txnRef +
            ", " +
            vals(from, to, toMinor(amt), ccy, msgId, createdAt) +
            ") ON CONFLICT DO NOTHING;"
        );
        report.settlements++;
      });
      continue;
    }

    const payer = str(txRows[0][G.PAID_BY]);
    if (!linked || linked.tenantId !== payer) {
      skip(where, "split without the payer's transaction");
      continue;
    }
    const shares = new Map();
    for (const r of txRows) {
      const holder = str(r[G.HOLDER]);
      const amt = Number(r[G.SHARE]);
      if (holder && Number.isFinite(amt) && amt >= 0) shares.set(holder, (shares.get(holder) || 0) + toMinor(amt));
    }
    if (!shares.size) {
      skip(where, "split without shares");
      continue;
    }
    const splitId = deterministicId(createdAt, "split|" + gid + "|" + txId);
    sql.push(
      "INSERT INTO splits (id, transaction_id, group_id, payer_id, mode, group_message_id, created_at) SELECT " +
        vals(splitId, linked.id, gid, payer, "import", msgId, createdAt) +
        " WHERE EXISTS (SELECT 1 FROM transactions WHERE id = " +
        sqlValue(linked.id) +
        " AND tenant_id = " +
        sqlValue(payer) +
        ") ON CONFLICT DO NOTHING;"
    );
    for (const [holder, amountMinor] of shares) {
      sql.push(
        "INSERT INTO split_shares (split_id, holder_id, amount_minor) SELECT " +
          vals(splitId, holder, amountMinor) +
          " WHERE EXISTS (SELECT 1 FROM splits WHERE id = " +
          sqlValue(splitId) +
          ") ON CONFLICT DO NOTHING;"
      );
    }
    report.splits++;
  }
  return sql;
}

// → { sql: string[], report }. report.expected feeds the post-import check.
// catchUp: insert-only (every conflict is DO NOTHING), for the re-run right
// after cutover, so edits made in the bot since the first import survive.
export function buildImport(dump, { now = Date.now(), catchUp = false } = {}) {
  const out = buildStatements(dump, now);
  if (catchUp) {
    out.sql = out.sql.map((s) =>
      s.replace(/ ON CONFLICT (\([^)]*\) )?DO UPDATE SET [\s\S]*;$/, " ON CONFLICT DO NOTHING;")
    );
  }
  return out;
}

function buildStatements(dump, now) {
  const sql = [];
  const report = {
    tenants: 0,
    groups: 0,
    transactions: 0,
    splits: 0,
    settlements: 0,
    rules: 0,
    skipped: [],
    warnings: [],
    expected: { tenants: {}, groups: {} }
  };
  const skip = (where, reason) => report.skipped.push({ where, reason });

  const tenants = (dump.tenants || []).filter((t) => str(t.chat_id));
  const ids = new Set(tenants.map((t) => str(t.chat_id)));
  const personal = tenants.filter((t) => t.chat_type !== "group");
  const groups = tenants.filter((t) => t.chat_type === "group");

  for (const t of tenants) sql.push(tenantSql(t, now));
  report.tenants = personal.length;
  report.groups = groups.length;

  const emailOwner = {};
  for (const t of personal) {
    const tid = str(t.chat_id);
    for (const email of t.emails || []) {
      const e = str(email).toLowerCase();
      if (!e) continue;
      if (emailOwner[e] && emailOwner[e] !== tid) {
        report.warnings.push("email registered to two tenants; kept the first");
        continue;
      }
      emailOwner[e] = tid;
      sql.push("INSERT INTO tenant_emails (email, tenant_id) VALUES (" + vals(e, tid) + ") ON CONFLICT DO NOTHING;");
    }
    if (str(t.ask_used_date) || Number(t.ask_lifetime_count) > 0) {
      sql.push(
        "INSERT INTO ask_usage (tenant_id, used_on, used_today, lifetime, cap_hits) VALUES (" +
          vals(
            tid,
            str(t.ask_used_date) || "1970-01-01",
            Number(t.ask_used_today) || 0,
            Number(t.ask_lifetime_count) || 0,
            Number(t.ask_cap_hit_count) || 0
          ) +
          ") ON CONFLICT (tenant_id) DO UPDATE SET used_on = excluded.used_on, used_today = excluded.used_today, " +
          "lifetime = excluded.lifetime, cap_hits = excluded.cap_hits;"
      );
    }
  }

  // Join order matters (split modes index members), so keep the sheet's order.
  for (const g of groups) {
    const created = toMs(g.created_at) || now;
    (g.group_members || []).forEach((m, i) => {
      if (!ids.has(str(m))) return report.warnings.push("group member without a tenant row dropped");
      sql.push(
        "INSERT INTO group_members (group_id, member_id, joined_at) VALUES (" +
          vals(str(g.chat_id), str(m), created + i) +
          ") ON CONFLICT DO NOTHING;"
      );
    });
  }

  // groupRefs maps "<group>:<txId>" → the payer's imported transaction.
  const groupRefs = {};
  for (const t of personal) {
    const tid = str(t.chat_id);
    const sheet = (dump.personal || {})[tid];
    if (!sheet) continue;
    if (sheet.error) {
      report.warnings.push("personal sheet unreadable: " + sheet.error);
      continue;
    }
    const expected = { count: 0, sums: {} };
    const seen = new Set();
    (sheet.rows || []).forEach((r, i) => {
      const where = "tenant " + tid + " row " + (i + 2);
      const ref = str(r[P.MSG_ID]);
      if (!ref) return skip(where, "no message id");
      if (seen.has(ref)) return skip(where, "duplicate message id");
      seen.add(ref);
      const out = transactionSql(tid, r, now, report, expected);
      if (out.error) return skip(where, out.error);
      sql.push(...out.statements);
      const groupRef = str(r[P.GROUP_REF]);
      if (groupRef) groupRefs[groupRef] = { tenantId: tid, id: out.id };
    });
    report.expected.tenants[tid] = expected;
  }

  for (const g of groups) {
    const gid = str(g.chat_id);
    const sheet = (dump.groups || {})[gid];
    if (!sheet) continue;
    if (sheet.error) {
      report.warnings.push("group sheet unreadable: " + sheet.error);
      continue;
    }
    report.expected.groups[gid] = sheetGroupBalances(sheet.rows);
    sql.push(...groupSql(gid, sheet.rows || [], groupRefs, now, report, skip));
  }

  // Merchant rules: each user's MyMerchants, then the shared tables.
  const ruleSql = (tenantId, pattern, name, category) =>
    "INSERT INTO merchant_rules (tenant_id, pattern, name, category, kind, updated_at) VALUES (" +
    vals(tenantId, pattern, name, category, null, now) +
    ") ON CONFLICT (tenant_id, pattern) DO UPDATE SET name = excluded.name, category = excluded.category, updated_at = excluded.updated_at;";
  for (const t of personal) {
    const sheet = (dump.personal || {})[str(t.chat_id)];
    for (const [pattern, name, category] of (sheet && sheet.myMerchants) || []) {
      const p = str(pattern).toLowerCase();
      if (!p) continue;
      sql.push(ruleSql(str(t.chat_id), p, nullIfEmpty(name), nullIfEmpty(category)));
      report.rules++;
    }
  }
  const shared = new Map();
  for (const [pattern, resolved] of (dump.shared && dump.shared.resolutions) || []) {
    const p = str(pattern).toLowerCase();
    if (p) shared.set(p, { name: nullIfEmpty(resolved), category: null });
  }
  for (const [merchant, category] of (dump.shared && dump.shared.overrides) || []) {
    const p = str(merchant).toLowerCase();
    if (p && str(category)) shared.set(p, { name: (shared.get(p) || {}).name || null, category: str(category) });
  }
  for (const [p, r] of shared) {
    if (!r.name && !r.category) continue;
    sql.push(ruleSql("", p, r.name, r.category));
    report.rules++;
  }

  for (const [key, value] of Object.entries(dump.settings || {})) {
    if (value == null || value === "") continue;
    sql.push(
      "INSERT INTO settings (key, value, updated_at) VALUES (" +
        vals(key, String(value), now) +
        ") ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;"
    );
  }

  return { sql, report };
}
