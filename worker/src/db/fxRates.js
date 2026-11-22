// D1 persistence for daily & historical currency -> INR exchange rates.

const MS_PER_DAY = 86400000;

function isoDaysBetween(laterIso, earlierIso) {
  const [y1, m1, d1] = String(laterIso || "")
    .split("-")
    .map(Number);
  const [y2, m2, d2] = String(earlierIso || "")
    .split("-")
    .map(Number);
  if (!y1 || !y2) return Infinity;
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / MS_PER_DAY);
}

// Look up a cached `1 <currency> = X INR` rate on or shortly before `occurredOn`
// (up to `maxLagDays` to cover weekends & bank holidays without hitting network).
export async function getCachedFxRate(db, currency, occurredOn, { maxLagDays = 5 } = {}) {
  const ccy = String(currency || "")
    .trim()
    .toUpperCase();
  if (!ccy) return null;
  if (ccy === "INR") return { rateDate: occurredOn, inrRate: 1.0 };

  const row = await db
    .prepare(
      "SELECT rate_date, inr_rate FROM fx_rates WHERE currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1"
    )
    .bind(ccy, String(occurredOn))
    .first();
  if (!row || !(row.inr_rate > 0)) return null;
  const lag = isoDaysBetween(occurredOn, row.rate_date);
  if (lag < 0 || lag > maxLagDays) return null;
  return { rateDate: row.rate_date, inrRate: Number(row.inr_rate) };
}

// Latest known rate for `currency` regardless of date (used for live group balance previews).
export async function getLatestCachedFxRate(db, currency) {
  const ccy = String(currency || "")
    .trim()
    .toUpperCase();
  if (!ccy) return null;
  if (ccy === "INR") return 1.0;
  const rate = await db
    .prepare("SELECT inr_rate FROM fx_rates WHERE currency = ? ORDER BY rate_date DESC LIMIT 1")
    .bind(ccy)
    .first("inr_rate");
  return rate > 0 ? Number(rate) : null;
}

// Upsert `{ USD: 92.6, THB: 2.73, ... }` (`1 <CCY> = inrRate INR`) for one or more ISO dates.
export async function upsertFxRates(db, rateDates, inrRatesByCurrency, now = Date.now()) {
  const dates = (Array.isArray(rateDates) ? rateDates : [rateDates]).filter(Boolean);
  const entries = Object.entries(inrRatesByCurrency || {}).filter(
    ([ccy, rate]) => ccy && ccy.length === 3 && Number.isFinite(rate) && rate > 0
  );
  if (!dates.length || !entries.length) return 0;

  const stmts = [];
  for (const dt of new Set(dates)) {
    for (const [ccy, rate] of entries) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO fx_rates (rate_date, currency, inr_rate, updated_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT (rate_date, currency) DO UPDATE SET inr_rate = excluded.inr_rate, updated_at = excluded.updated_at"
          )
          .bind(dt, ccy.toUpperCase(), Number(rate), now)
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40));
  }
  return stmts.length;
}

export async function listPendingFxTransactions(db, { tenantId = null, limit = 50 } = {}) {
  const where = ["currency <> 'INR'", "inr_minor IS NULL", "status <> 'deleted'"];
  const params = [];
  if (tenantId) {
    where.push("tenant_id = ?");
    params.push(String(tenantId));
  }
  params.push(limit);
  const res = await db
    .prepare(
      "SELECT id, tenant_id, occurred_on, amount_minor, currency, card_message_id " +
        "FROM transactions WHERE " +
        where.join(" AND ") +
        " ORDER BY occurred_on DESC, created_at DESC LIMIT ?"
    )
    .bind(...params)
    .all();
  return res.results;
}
