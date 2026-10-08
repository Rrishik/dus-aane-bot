// Group splits, their per-member shares, settlements and balances.
import { ulid } from "../util/ids.js";

// Record a split of the payer's transaction into a group. shares:
// [{ holderId, amountMinor }]. Throws if the transaction isn't the payer's
// or is already split (one split per transaction).
export async function createSplit(
  db,
  { transactionId, groupId, payerId, mode, shares, groupMessageId = null, now = Date.now() }
) {
  if (!shares || shares.length === 0) throw new Error("createSplit: shares required");
  const owned = await db
    .prepare("SELECT 1 AS ok FROM transactions WHERE id = ? AND tenant_id = ? AND status <> 'deleted'")
    .bind(transactionId, String(payerId))
    .first("ok");
  if (!owned) throw new Error("createSplit: transaction not found for payer");
  const id = ulid(now);
  await db.batch([
    db
      .prepare(
        "INSERT INTO splits (id, transaction_id, group_id, payer_id, mode, group_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, transactionId, String(groupId), String(payerId), mode, groupMessageId, now),
    ...shares.map((s) =>
      db
        .prepare("INSERT INTO split_shares (split_id, holder_id, amount_minor) VALUES (?, ?, ?)")
        .bind(id, String(s.holderId), s.amountMinor)
    )
  ]);
  return id;
}

export async function getSplitForTransaction(db, transactionId) {
  const split = await db.prepare("SELECT * FROM splits WHERE transaction_id = ?").bind(transactionId).first();
  if (!split) return null;
  const shares = await db
    .prepare("SELECT holder_id, amount_minor FROM split_shares WHERE split_id = ? ORDER BY rowid")
    .bind(split.id)
    .all();
  return { ...split, shares: shares.results };
}

export async function setSplitGroupMessage(db, splitId, groupMessageId) {
  await db.prepare("UPDATE splits SET group_message_id = ? WHERE id = ?").bind(groupMessageId, splitId).run();
}

export async function deleteSplit(db, groupId, splitId) {
  const res = await db.prepare("DELETE FROM splits WHERE id = ? AND group_id = ?").bind(splitId, String(groupId)).run();
  return res.meta.changes > 0;
}

export async function recordSettlement(
  db,
  { groupId, fromId, toId, amountMinor, currency, transactionId = null, groupMessageId = null, now = Date.now() }
) {
  const id = ulid(now);
  await db
    .prepare(
      "INSERT INTO settlements (id, group_id, transaction_id, from_id, to_id, amount_minor, currency, group_message_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id, String(groupId), transactionId, String(fromId), String(toId), amountMinor, currency, groupMessageId, now)
    .run();
  return id;
}

export async function setSettlementGroupMessage(db, settlementId, groupMessageId) {
  await db.prepare("UPDATE settlements SET group_message_id = ? WHERE id = ?").bind(groupMessageId, settlementId).run();
}

export async function getSettlementForTransaction(db, transactionId) {
  return db.prepare("SELECT * FROM settlements WHERE transaction_id = ?").bind(transactionId).first();
}

export async function deleteSettlement(db, groupId, settlementId) {
  const res = await db
    .prepare("DELETE FROM settlements WHERE id = ? AND group_id = ?")
    .bind(settlementId, String(groupId))
    .run();
  return res.meta.changes > 0;
}

// Net pairwise balances per currency, matching Groups.js
// aggregatePairwiseDebts: each share held by someone other than the payer
// is owed to the payer (regardless of debit/credit); settlements reduce
// what `from` owes `to`. Returns { [currency]: [{ debtor, creditor,
// amountMinor }] }, largest first, net-zero pairs dropped.
export async function groupBalances(db, groupId) {
  const gid = String(groupId);
  const owed = await db
    .prepare(
      "SELECT t.currency AS currency, sh.holder_id AS debtor, s.payer_id AS creditor, SUM(sh.amount_minor) AS amount " +
        "FROM splits s JOIN split_shares sh ON sh.split_id = s.id JOIN transactions t ON t.id = s.transaction_id " +
        "WHERE s.group_id = ? AND sh.holder_id <> s.payer_id AND t.status <> 'deleted' GROUP BY 1, 2, 3"
    )
    .bind(gid)
    .all();
  const paid = await db
    .prepare(
      "SELECT currency, from_id AS debtor, to_id AS creditor, SUM(amount_minor) AS amount " +
        "FROM settlements WHERE group_id = ? AND from_id <> to_id GROUP BY 1, 2, 3"
    )
    .bind(gid)
    .all();

  // ledger[currency]["a|b"] = what a owes b minus what b owes a (a < b).
  const ledger = {};
  function bump(currency, debtor, creditor, amount) {
    const [a, b, sign] = debtor < creditor ? [debtor, creditor, 1] : [creditor, debtor, -1];
    ledger[currency] = ledger[currency] || {};
    const key = a + "|" + b;
    ledger[currency][key] = (ledger[currency][key] || 0) + sign * amount;
  }
  owed.results.forEach((r) => bump(r.currency, r.debtor, r.creditor, r.amount));
  paid.results.forEach((r) => bump(r.currency, r.debtor, r.creditor, -r.amount));

  const out = {};
  for (const currency of Object.keys(ledger)) {
    const entries = [];
    for (const [key, net] of Object.entries(ledger[currency])) {
      if (net === 0) continue;
      const [a, b] = key.split("|");
      entries.push(
        net > 0 ? { debtor: a, creditor: b, amountMinor: net } : { debtor: b, creditor: a, amountMinor: -net }
      );
    }
    if (entries.length === 0) continue;
    entries.sort(
      (x, y) =>
        y.amountMinor - x.amountMinor ||
        (x.debtor < y.debtor ? -1 : x.debtor > y.debtor ? 1 : x.creditor < y.creditor ? -1 : 1)
    );
    out[currency] = entries;
  }
  return out;
}
