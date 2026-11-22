// Analytics reads. A transaction split into a group counts only the
// tenant's own share (0 if someone else holds all of it); one that settled a
// group debt counts 0.

export async function listEffectiveTransactions(db, tenantId, { from, to, statuses = ["confirmed"] } = {}) {
  const where = ["t.tenant_id = ?", "t.status IN (" + statuses.map(() => "?").join(", ") + ")"];
  const params = [String(tenantId), ...statuses];
  if (from) {
    where.push("t.occurred_on >= ?");
    params.push(from);
  }
  if (to) {
    where.push("t.occurred_on <= ?");
    params.push(to);
  }
  const rows = await db
    .prepare(
      "SELECT t.*, CASE " +
        "WHEN st.id IS NOT NULL THEN 0 " +
        "WHEN s.id IS NOT NULL THEN COALESCE(sh.amount_minor, 0) " +
        "ELSE t.amount_minor END AS effective_minor, " +
        "CASE " +
        "WHEN st.id IS NOT NULL THEN 0 " +
        "WHEN t.currency = 'INR' THEN " +
        "CASE WHEN s.id IS NOT NULL THEN COALESCE(sh.amount_minor, 0) ELSE t.amount_minor END " +
        "WHEN t.inr_minor IS NULL THEN NULL " +
        "WHEN s.id IS NOT NULL THEN " +
        "CASE WHEN t.amount_minor > 0 THEN CAST(ROUND(1.0 * t.inr_minor * COALESCE(sh.amount_minor, 0) / t.amount_minor) AS INTEGER) ELSE 0 END " +
        "ELSE t.inr_minor END AS effective_inr_minor, " +
        "s.id AS split_id, st.id AS settlement_id " +
        "FROM transactions t " +
        "LEFT JOIN splits s ON s.transaction_id = t.id " +
        "LEFT JOIN split_shares sh ON sh.split_id = s.id AND sh.holder_id = t.tenant_id " +
        "LEFT JOIN settlements st ON st.transaction_id = t.id " +
        "WHERE " +
        where.join(" AND ") +
        " ORDER BY t.occurred_on, t.created_at"
    )
    .bind(...params)
    .all();
  return rows.results;
}
