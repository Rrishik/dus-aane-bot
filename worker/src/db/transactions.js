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

export async function findTransactionByCardMessage(db, tenantId, cardMessageId) {
  if (!cardMessageId) return null;
  return db
    .prepare("SELECT * FROM transactions WHERE tenant_id = ? AND card_message_id = ? AND status <> 'deleted' LIMIT 1")
    .bind(String(tenantId), Number(cardMessageId))
    .first();
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

export function isUntaggedTransaction(r) {
  if (!r) return false;
  const c = String(r.category || "")
    .trim()
    .toLowerCase();
  return !c || c === "uncategorized";
}

const UNTAGGED_WHERE_CLAUSE = "(category IS NULL OR TRIM(category) = '' OR LOWER(TRIM(category)) = 'uncategorized')";
const SOURCE_SIGNALS_SELECT =
  ", (SELECT MIN(s.received_at) FROM transaction_sources s WHERE s.tenant_id = transactions.tenant_id AND s.transaction_id = transactions.id AND s.source = 'email') AS email_received_at" +
  ", (SELECT s.parsed_by FROM transaction_sources s WHERE s.tenant_id = transactions.tenant_id AND s.transaction_id = transactions.id ORDER BY CASE WHEN s.source = 'email' THEN 0 ELSE 1 END, s.received_at ASC LIMIT 1) AS parsed_by" +
  ", (SELECT s.raw_text FROM transaction_sources s WHERE s.tenant_id = transactions.tenant_id AND s.transaction_id = transactions.id AND s.source = 'sms' LIMIT 1) AS sms_raw_text";

// Confirmed transactions missing a category.
export async function listUntaggedTransactions(db, tenantId, { from, to, limit = 25 } = {}) {
  const where = ["tenant_id = ?", "status = 'confirmed'", UNTAGGED_WHERE_CLAUSE];
  const params = [String(tenantId)];
  if (from) {
    where.push("occurred_on >= ?");
    params.push(from);
  }
  if (to) {
    where.push("occurred_on <= ?");
    params.push(to);
  }
  params.push(limit);
  return (
    await db
      .prepare(
        "SELECT * FROM transactions WHERE " +
          where.join(" AND ") +
          " ORDER BY occurred_on DESC, created_at DESC LIMIT ?"
      )
      .bind(...params)
      .all()
  ).results;
}

export async function countUntaggedTransactions(db, tenantId, { from, to } = {}) {
  const where = ["tenant_id = ?", "status = 'confirmed'", UNTAGGED_WHERE_CLAUSE];
  const params = [String(tenantId)];
  if (from) {
    where.push("occurred_on >= ?");
    params.push(from);
  }
  if (to) {
    where.push("occurred_on <= ?");
    params.push(to);
  }
  const n = await db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE " + where.join(" AND "))
    .bind(...params)
    .first("n");
  return Number(n) || 0;
}

export async function listUntaggedWithSignals(db, tenantId, { from, to, excludeIds = [], limit = 8 } = {}) {
  const where = ["tenant_id = ?", "status = 'confirmed'", UNTAGGED_WHERE_CLAUSE];
  const params = [String(tenantId)];
  if (from) {
    where.push("occurred_on >= ?");
    params.push(from);
  }
  if (to) {
    where.push("occurred_on <= ?");
    params.push(to);
  }
  if (excludeIds && excludeIds.length > 0) {
    const capped = excludeIds.slice(0, 60).map(String);
    where.push("id NOT IN (" + capped.map(() => "?").join(", ") + ")");
    params.push(...capped);
  }
  params.push(limit);
  return (
    await db
      .prepare(
        "SELECT *" +
          SOURCE_SIGNALS_SELECT +
          " FROM transactions WHERE " +
          where.join(" AND ") +
          " ORDER BY occurred_on DESC, created_at DESC LIMIT ?"
      )
      .bind(...params)
      .all()
  ).results;
}

// Historical tagged rows + unnamed precedents + same-day neighbors for LLM tag suggestions.
export async function listTaggingContext(db, tenantId, { targetDates = [], historyLimit = 50 } = {}) {
  const tid = String(tenantId);
  const taggedWhere = "category IS NOT NULL AND TRIM(category) <> '' AND LOWER(TRIM(category)) <> 'uncategorized'";
  const [recentRes, unnamedRes] = await Promise.all([
    db
      .prepare(
        "SELECT *" +
          SOURCE_SIGNALS_SELECT +
          " FROM transactions WHERE tenant_id = ? AND status = 'confirmed' AND " +
          taggedWhere +
          " ORDER BY occurred_on DESC, created_at DESC LIMIT ?"
      )
      .bind(tid, historyLimit)
      .all(),
    db
      .prepare(
        "SELECT *" +
          SOURCE_SIGNALS_SELECT +
          " FROM transactions WHERE tenant_id = ? AND status = 'confirmed' AND " +
          "(merchant_raw IS NULL OR TRIM(merchant_raw) = '') AND merchant IS NOT NULL AND TRIM(merchant) <> '' AND " +
          taggedWhere +
          " ORDER BY occurred_on DESC, created_at DESC LIMIT 25"
      )
      .bind(tid)
      .all()
  ]);
  const dates = Array.from(new Set((targetDates || []).filter(Boolean))).slice(0, 15);
  let sameDayNeighbors = [];
  if (dates.length > 0) {
    const neighborRes = await db
      .prepare(
        "SELECT *" +
          SOURCE_SIGNALS_SELECT +
          " FROM transactions WHERE tenant_id = ? AND status = 'confirmed' AND " +
          taggedWhere +
          " AND occurred_on IN (" +
          dates.map(() => "?").join(", ") +
          ") ORDER BY occurred_on DESC, created_at DESC LIMIT 30"
      )
      .bind(tid, ...dates)
      .all();
    sameDayNeighbors = neighborRes.results;
  }
  return {
    recentTagged: recentRes.results,
    unnamedPrecedents: unnamedRes.results,
    sameDayNeighbors
  };
}

// Is this incoming read the same payment as an existing transaction?
//   strength "reference" — same UPI ref / RRN / UTR and direction: certain.
//   strength "account"   — same account/card, amount, currency, direction,
//                          date within ±1 day: very likely.
//   strength "amount"    — same amount/currency/direction/date but no account
//                          on one side: possible (caller should ask).
// A differing reference or account on both sides rules a candidate out.
// t.channel excludes transactions that already have a source from that
// channel: two emails (or two SMS) are always two payments, even when
// they look identical (same coffee twice on the same card).
export async function findLinkCandidate(db, tenantId, t) {
  const tid = String(tenantId);
  const channelFilter = t.channel
    ? " AND NOT EXISTS (SELECT 1 FROM transaction_sources s WHERE s.transaction_id = transactions.id AND s.source = ?)"
    : "";
  const channelParams = t.channel ? [t.channel] : [];
  if (t.reference) {
    const byRef = await db
      .prepare(
        "SELECT * FROM transactions WHERE tenant_id = ? AND reference = ? AND direction = ? AND status <> 'deleted'" +
          channelFilter +
          " ORDER BY created_at LIMIT 1"
      )
      .bind(tid, t.reference, t.direction, ...channelParams)
      .first();
    if (byRef) return { transaction: byRef, strength: "reference" };
  }
  const rows = await db
    .prepare(
      "SELECT * FROM transactions WHERE tenant_id = ? AND amount_minor = ? AND currency = ? AND direction = ? " +
        "AND occurred_on BETWEEN ? AND ? AND status <> 'deleted'" +
        channelFilter +
        " ORDER BY created_at DESC LIMIT 20"
    )
    .bind(
      tid,
      t.amountMinor,
      t.currency,
      t.direction,
      shiftIsoDate(t.occurredOn, -1),
      shiftIsoDate(t.occurredOn, 1),
      ...channelParams
    )
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
