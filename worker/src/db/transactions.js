// Transactions and their sources. Every function is scoped by tenantId.
import { ulid } from "../util/ids.js";
import { shiftIsoDate } from "../util/dates.js";

// camelCase field → column, for the fields callers may patch.
const UPDATABLE = {
  occurredOn: "occurred_on",
  amountMinor: "amount_minor",
  currency: "currency",
  direction: "direction",
  kind: "kind",
  merchant: "merchant",
  category: "category",
  accountLast4: "account_last4",
  reference: "reference",
  status: "status",
  reviewNote: "review_note",
  cardMessageId: "card_message_id"
};

const SOURCE_UPDATABLE = { parsedBy: "parsed_by", confidence: "confidence", reread: "reread" };

function nullable(v) {
  return v === undefined || v === "" ? null : v;
}

function sourceInsert(db, tenantId, transactionId, s, now) {
  return db
    .prepare(
      "INSERT INTO transaction_sources (tenant_id, source, source_ref, transaction_id, parsed_by, confidence, raw_text, received_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      tenantId,
      s.source,
      String(s.sourceRef),
      transactionId,
      nullable(s.parsedBy),
      s.confidence == null ? null : s.confidence,
      nullable(s.rawText),
      s.receivedAt || now
    );
}

// Insert a transaction with its first source atomically. Returns the id.
export async function insertTransaction(db, tenantId, txn, source, now = Date.now()) {
  const tid = String(tenantId);
  const id = txn.id || ulid(now);
  await db.batch([
    db
      .prepare(
        "INSERT INTO transactions (id, tenant_id, occurred_on, amount_minor, currency, direction, kind, merchant_raw, merchant, " +
          "category, account_last4, reference, forwarder, status, review_note, card_message_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        tid,
        txn.occurredOn,
        txn.amountMinor,
        txn.currency,
        txn.direction,
        txn.kind,
        nullable(txn.merchantRaw),
        nullable(txn.merchant),
        nullable(txn.category),
        nullable(txn.accountLast4),
        nullable(txn.reference),
        nullable(txn.forwarder),
        txn.status || "confirmed",
        nullable(txn.reviewNote),
        txn.cardMessageId == null ? null : txn.cardMessageId,
        now,
        now
      ),
    sourceInsert(db, tid, id, source, now)
  ]);
  return id;
}

// Link another source (e.g. the SMS for an emailed payment) to an existing
// transaction. Returns false if the transaction isn't this tenant's.
export async function attachSource(db, tenantId, transactionId, source, now = Date.now()) {
  const owned = await getTransaction(db, tenantId, transactionId);
  if (!owned) return false;
  await sourceInsert(db, String(tenantId), transactionId, source, now).run();
  return true;
}

export async function getTransaction(db, tenantId, id) {
  return db.prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ?").bind(id, String(tenantId)).first();
}

export async function findTransactionBySource(db, tenantId, source, sourceRef) {
  return db
    .prepare(
      "SELECT t.* FROM transaction_sources s JOIN transactions t ON t.id = s.transaction_id " +
        "WHERE s.tenant_id = ? AND s.source = ? AND s.source_ref = ?"
    )
    .bind(String(tenantId), source, String(sourceRef))
    .first();
}

export async function getSources(db, tenantId, transactionId) {
  const rows = await db
    .prepare("SELECT * FROM transaction_sources WHERE tenant_id = ? AND transaction_id = ? ORDER BY received_at")
    .bind(String(tenantId), transactionId)
    .all();
  return rows.results;
}

function assignments(patch, allowed) {
  const cols = [];
  const params = [];
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key)) throw new Error("Field not updatable: " + key);
    cols.push(allowed[key] + " = ?");
    params.push(patch[key] === undefined ? null : patch[key]);
  }
  return { cols, params };
}

export async function updateTransaction(db, tenantId, id, patch, now = Date.now()) {
  const { cols, params } = assignments(patch, UPDATABLE);
  if (cols.length === 0) return false;
  const res = await db
    .prepare("UPDATE transactions SET " + cols.join(", ") + ", updated_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(...params, now, id, String(tenantId))
    .run();
  return res.meta.changes > 0;
}

export async function updateSource(db, tenantId, source, sourceRef, patch) {
  const { cols, params } = assignments(patch, SOURCE_UPDATABLE);
  if (cols.length === 0) return false;
  const res = await db
    .prepare(
      "UPDATE transaction_sources SET " + cols.join(", ") + " WHERE tenant_id = ? AND source = ? AND source_ref = ?"
    )
    .bind(...params, String(tenantId), source, String(sourceRef))
    .run();
  return res.meta.changes > 0;
}

export async function softDeleteTransaction(db, tenantId, id, now = Date.now()) {
  return updateTransaction(db, tenantId, id, { status: "deleted" }, now);
}

// Filters: from/to (ISO dates, inclusive), statuses (default confirmed only),
// direction, kind, category, merchant (case-insensitive substring), limit.
export async function listTransactions(db, tenantId, opts = {}) {
  const where = ["tenant_id = ?"];
  const params = [String(tenantId)];
  const statuses = opts.statuses || ["confirmed"];
  where.push("status IN (" + statuses.map(() => "?").join(", ") + ")");
  params.push(...statuses);
  if (opts.from) {
    where.push("occurred_on >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    where.push("occurred_on <= ?");
    params.push(opts.to);
  }
  for (const [key, col] of [
    ["direction", "direction"],
    ["kind", "kind"],
    ["category", "category"]
  ]) {
    if (opts[key]) {
      where.push(col + " = ?");
      params.push(opts[key]);
    }
  }
  if (opts.merchant) {
    where.push("LOWER(COALESCE(merchant, merchant_raw, '')) LIKE ?");
    params.push("%" + String(opts.merchant).toLowerCase() + "%");
  }
  let sql = "SELECT * FROM transactions WHERE " + where.join(" AND ") + " ORDER BY occurred_on DESC, created_at DESC";
  if (opts.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
}

// Is this incoming read the same payment as an existing transaction?
//   strength "reference" — same UPI ref / RRN / UTR: certain.
//   strength "account"   — same account/card, amount, currency, direction,
//                          date within ±1 day: very likely.
//   strength "amount"    — same amount/currency/direction/date but no account
//                          on one side: possible (caller should ask).
// A differing reference or account on both sides rules a candidate out.
export async function findLinkCandidate(db, tenantId, t) {
  const tid = String(tenantId);
  if (t.reference) {
    const byRef = await db
      .prepare(
        "SELECT * FROM transactions WHERE tenant_id = ? AND reference = ? AND status <> 'deleted' ORDER BY created_at LIMIT 1"
      )
      .bind(tid, t.reference)
      .first();
    if (byRef) return { transaction: byRef, strength: "reference" };
  }
  const rows = await db
    .prepare(
      "SELECT * FROM transactions WHERE tenant_id = ? AND amount_minor = ? AND currency = ? AND direction = ? " +
        "AND occurred_on BETWEEN ? AND ? AND status <> 'deleted' ORDER BY created_at DESC LIMIT 20"
    )
    .bind(tid, t.amountMinor, t.currency, t.direction, shiftIsoDate(t.occurredOn, -1), shiftIsoDate(t.occurredOn, 1))
    .all();
  const candidates = rows.results.filter(
    (c) =>
      !(t.reference && c.reference && t.reference !== c.reference) &&
      !(t.accountLast4 && c.account_last4 && t.accountLast4 !== c.account_last4)
  );
  if (candidates.length === 0) return null;
  const sameAccount = candidates.find((c) => t.accountLast4 && c.account_last4 === t.accountLast4);
  if (sameAccount) return { transaction: sameAccount, strength: "account" };
  return { transaction: candidates[0], strength: "amount" };
}
