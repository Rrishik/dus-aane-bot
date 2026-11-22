// Optional user-friendly labels for card / bank account last-4 digits
// (e.g. "5678" -> "Infinia"), plus historical transaction discovery & upgrade.
import { smartTitleCase } from "../app/merchants.js";

export async function getAccountLabels(db, tenantId) {
  const rows = await db
    .prepare("SELECT last4, label, kind FROM account_labels WHERE tenant_id = ? ORDER BY kind, last4")
    .bind(String(tenantId))
    .all();
  return rows.results;
}

export async function getCardLabelsMap(db, tenantId) {
  const rows = await getAccountLabels(db, tenantId);
  const map = {};
  for (const r of rows) {
    if (r.kind === "card") map[r.last4] = r.label;
  }
  return map;
}

export async function getAllAccountLabelsMap(db, tenantId) {
  const rows = await getAccountLabels(db, tenantId);
  const map = {};
  for (const r of rows) {
    map[r.last4] = r.label;
  }
  return map;
}

export async function deleteAccountLabel(db, tenantId, last4, now = Date.now()) {
  const tid = String(tenantId);
  const digits = String(last4 || "").replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 4) {
    return { ok: false, error: "last4 must be 3 or 4 digits (e.g. '5678')." };
  }
  const existing = await db
    .prepare("SELECT label, kind FROM account_labels WHERE tenant_id = ? AND last4 = ?")
    .bind(tid, digits)
    .first();
  if (!existing) {
    return { ok: false, error: "No saved label found for *" + digits + "." };
  }
  await db.prepare("DELETE FROM account_labels WHERE tenant_id = ? AND last4 = ?").bind(tid, digits).run();

  if (existing.kind === "card" && existing.label) {
    const oldMerchant = ("CC Bill · " + stripCardSuffix(existing.label)).slice(0, 28);
    await db
      .prepare(
        "UPDATE transactions SET merchant = ?, updated_at = ? " +
          "WHERE tenant_id = ? AND status = 'confirmed' AND (merchant = ? OR merchant = ?) AND account_last4 = ?"
      )
      .bind("CC Bill *" + digits, now, tid, oldMerchant, ("CC Bill · " + existing.label).slice(0, 28), digits)
      .run();
  }
  return { ok: true, last4: digits, removed_label: existing.label, kind: existing.kind };
}

const MAX_ACCOUNT_LABEL_LEN = 30;

function normalizeAccountLabel(raw) {
  const words = String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w) => smartTitleCase(w.toLowerCase()))
    .join(" ")
    .slice(0, MAX_ACCOUNT_LABEL_LEN)
    .trim();
}

function stripCardSuffix(label) {
  return (
    String(label || "")
      .replace(/\s+(?:credit\s+card|card|cc)$/i, "")
      .trim() || String(label || "").trim()
  );
}

export async function upsertAccountLabel(db, tenantId, last4, rawLabel, kind = "card", now = Date.now()) {
  const tid = String(tenantId);
  const digits = String(last4 || "").replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 4) {
    return { ok: false, error: "last4 must be 3 or 4 digits (e.g. '5678')." };
  }
  const cleanLabel = normalizeAccountLabel(rawLabel);
  if (!cleanLabel) return { ok: false, error: "Card label cannot be empty." };
  const normKind =
    kind === "account" || /\b(?:savings?|salary|current|account|a\/c)\b/i.test(cleanLabel) ? "account" : "card";

  await db
    .prepare(
      "INSERT INTO account_labels (tenant_id, last4, label, kind, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (tenant_id, last4) DO UPDATE SET label = excluded.label, kind = excluded.kind, updated_at = excluded.updated_at"
    )
    .bind(tid, digits, cleanLabel, normKind, now)
    .run();

  // Retroactively upgrade any past "CC Bill *5678" rows for this user to "CC Bill · <Label>"!
  let upgraded = 0;
  if (normKind === "card") {
    const newMerchant = ("CC Bill · " + stripCardSuffix(cleanLabel)).slice(0, 28);
    const res = await db
      .prepare(
        "UPDATE transactions SET merchant = ?, updated_at = ? " +
          "WHERE tenant_id = ? AND status = 'confirmed' AND (merchant = ? OR (merchant LIKE 'CC Bill%' AND account_last4 = ?))"
      )
      .bind(newMerchant, now, tid, "CC Bill *" + digits, digits)
      .run();
    upgraded = res.meta.changes || 0;
  }

  return { ok: true, last4: digits, label: cleanLabel, kind: normKind, upgraded_transactions: upgraded };
}

export async function listSeenAccounts(db, tenantId) {
  const tid = String(tenantId);
  const [saved, seenRes] = await Promise.all([
    getAccountLabels(db, tid),
    db
      .prepare(
        "SELECT account_last4 AS last4, COUNT(*) AS txn_count, MAX(occurred_on) AS last_seen " +
          "FROM transactions WHERE tenant_id = ? AND status = 'confirmed' AND account_last4 IS NOT NULL AND TRIM(account_last4) <> '' " +
          "GROUP BY account_last4 ORDER BY txn_count DESC LIMIT 20"
      )
      .bind(tid)
      .all()
  ]);
  const byLast4 = new Map(saved.map((s) => [s.last4, s]));
  const merged = [];
  for (const r of seenRes.results) {
    const existing = byLast4.get(r.last4);
    byLast4.delete(r.last4);
    merged.push({
      last4: r.last4,
      label: existing ? existing.label : null,
      kind: existing ? existing.kind : null,
      txn_count: r.txn_count,
      last_seen: r.last_seen
    });
  }
  for (const s of byLast4.values()) {
    merged.push({ last4: s.last4, label: s.label, kind: s.kind, txn_count: 0, last_seen: null });
  }
  return merged;
}
