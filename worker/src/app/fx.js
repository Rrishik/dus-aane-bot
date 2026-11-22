// Async foreign-currency -> INR conversion service:
//   - Primary provider: Frankfurter (`api.frankfurter.dev`, free/no-key ECB daily + historical rates)
//   - Fixed central-bank pegs derived from USD/INR (`AED`, `SAR`, `QAR`, `OMR`, `BHD`, `NPR`, `BTN`)
//   - Fallback provider: `open.er-api.com` (160+ currencies including `VND`, `LKR`, `BDT`, `MVR`)
import { getCachedFxRate, upsertFxRates, listPendingFxTransactions } from "../db/fxRates.js";
import { getTransaction, updateTransaction } from "../db/transactions.js";
import { refreshCardMessage } from "./cardState.js";
import { refreshPersonalPin } from "./personalPin.js";
import { istDate, shiftIsoDate } from "../util/dates.js";

const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";
const OPEN_ER_LATEST_INR = "https://open.er-api.com/v6/latest/INR";

// Fixed central-bank pegs (`1 USD = X <CCY>`) for GCC currencies not published by ECB.
const USD_PEGS = {
  AED: 3.6725,
  SAR: 3.75,
  QAR: 3.64,
  OMR: 0.3845,
  BHD: 0.376
};

// Fixed INR pegs (`1 <CCY> = X INR`).
const INR_PEGS = {
  INR: 1.0,
  BTN: 1.0,
  NPR: 0.625
};

export function convertMinorToInr(amountMinor, inrRate) {
  if (!Number.isFinite(amountMinor) || !(inrRate > 0)) return null;
  return Math.round(Number(amountMinor) * Number(inrRate));
}

// Convert a provider's `1 INR = rates[CCY]` map into `1 CCY = inrRate INR`,
// enriching fixed INR and USD-pegged currencies automatically.
export function invertBaseInrRates(rawRates) {
  const out = { ...INR_PEGS };
  if (!rawRates || typeof rawRates !== "object") return out;

  for (const [ccy, perInr] of Object.entries(rawRates)) {
    const code = String(ccy || "")
      .trim()
      .toUpperCase();
    const num = Number(perInr);
    if (code.length === 3 && Number.isFinite(num) && num > 0) {
      out[code] = Number((1 / num).toFixed(6));
    }
  }

  if (out.USD > 0) {
    for (const [ccy, perUsd] of Object.entries(USD_PEGS)) {
      if (!out[ccy]) {
        out[ccy] = Number((out.USD / perUsd).toFixed(6));
      }
    }
  }
  return out;
}

async function fetchJsonSafe(fetchFn, url) {
  try {
    const res = await fetchFn(url, { headers: { Accept: "application/json" } });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function fetchRatesSnapshot(ctx, dateOrLatest) {
  const fetchFn = ctx.fetch || fetch;
  const slug = dateOrLatest && dateOrLatest !== "latest" ? encodeURIComponent(dateOrLatest) : "latest";
  const primary = await fetchJsonSafe(fetchFn, FRANKFURTER_BASE + "/" + slug + "?base=INR");
  if (primary && primary.rates) {
    return {
      sourceDate: primary.date || (slug === "latest" ? null : dateOrLatest),
      rates: invertBaseInrRates(primary.rates),
      fromPrimary: true
    };
  }
  const fallback = await fetchJsonSafe(fetchFn, OPEN_ER_LATEST_INR);
  if (fallback && fallback.rates) {
    return {
      sourceDate: slug === "latest" ? null : dateOrLatest,
      rates: invertBaseInrRates(fallback.rates),
      fromPrimary: false
    };
  }
  return null;
}

// Daily 08:00 IST pre-warmer: 1 HTTP GET populates `fx_rates` for `todayIso`.
export async function warmLatestFxRates(ctx, todayIso) {
  const snap = await fetchRatesSnapshot(ctx, "latest");
  if (!snap) return { ok: false, count: 0 };
  const dates = [todayIso, snap.sourceDate].filter(Boolean);
  const count = await upsertFxRates(ctx.db, dates, snap.rates, ctx.now());
  return { ok: true, count };
}

// Resolve `1 <currency> = X INR` for `occurredOn`, fetching & caching on miss.
export async function resolveOrFetchFxRate(ctx, currency, occurredOn) {
  const ccy = String(currency || "")
    .trim()
    .toUpperCase();
  if (!ccy) return null;
  if (INR_PEGS[ccy]) return INR_PEGS[ccy];

  const cached = await getCachedFxRate(ctx.db, ccy, occurredOn);
  if (cached) return cached.inrRate;

  const snap = await fetchRatesSnapshot(ctx, occurredOn);
  if (snap && snap.rates) {
    await upsertFxRates(ctx.db, [occurredOn, snap.sourceDate].filter(Boolean), snap.rates, ctx.now());
    if (snap.rates[ccy] > 0) return snap.rates[ccy];
  }

  // Currency outside ECB's 31-currency basket (e.g. VND, LKR, BDT): try 160-currency fallback.
  if (snap && snap.fromPrimary) {
    const wide = await fetchJsonSafe(ctx.fetch || fetch, OPEN_ER_LATEST_INR);
    if (wide && wide.rates) {
      const wideMap = invertBaseInrRates(wide.rates);
      if (wideMap[ccy] > 0) {
        await upsertFxRates(ctx.db, [occurredOn], { [ccy]: wideMap[ccy] }, ctx.now());
        return wideMap[ccy];
      }
    }
  }
  return null;
}

export async function enqueueFxEnrich(ctx, { tenantId, txnId }) {
  if (!ctx || !ctx.env || !ctx.env.UPDATES || !tenantId || !txnId) return false;
  try {
    await ctx.env.UPDATES.send({
      kind: "fx_enrich",
      tenantId: String(tenantId),
      txnId: String(txnId)
    });
    return true;
  } catch (e) {
    console.error("[fx] queue send failed:", e && e.message);
    return false;
  }
}

export async function enrichTransactionFx(ctx, tenantId, txnId, { refreshUi = true } = {}) {
  const tid = String(tenantId);
  const txn = txnId && (await getTransaction(ctx.db, tid, txnId));
  if (!txn || txn.status === "deleted") return { ok: false, reason: "not_found" };

  if (txn.currency === "INR") {
    if (txn.inr_minor !== txn.amount_minor || txn.fx_rate !== 1) {
      await updateTransaction(ctx.db, tid, txn.id, { inrMinor: txn.amount_minor, fxRate: 1.0 }, ctx.now());
    }
    return { ok: true, inrMinor: txn.amount_minor, fxRate: 1.0 };
  }

  const rate = await resolveOrFetchFxRate(ctx, txn.currency, txn.occurred_on);
  if (!(rate > 0)) return { ok: false, reason: "rate_unavailable" };

  const inrMinor = convertMinorToInr(txn.amount_minor, rate);
  await updateTransaction(ctx.db, tid, txn.id, { inrMinor, fxRate: rate }, ctx.now());

  if (refreshUi) {
    await refreshCardMessage(ctx, tid, txn.id).catch(() => {});
    await refreshPersonalPin(ctx, tid).catch(() => {});
  }
  return { ok: true, inrMinor, fxRate: rate };
}

export async function enqueueFxSweep(ctx, { tenantId = null } = {}) {
  if (!ctx || !ctx.env || !ctx.env.UPDATES) return false;
  try {
    await ctx.env.UPDATES.send({
      kind: "fx_sweep",
      tenantId: tenantId ? String(tenantId) : null
    });
    return true;
  } catch (e) {
    console.error("[fx] sweep queue send failed:", e && e.message);
    return false;
  }
}

// Low-subrequest batch sweep for foreign rows missing `inr_minor`:
//   1. Resolves each distinct `(currency, occurred_on)` pair once
//   2. Commits all `inr_minor` updates in a single `db.batch(...)`
//   3. Only edits very recent DM cards (last 2 days) and refreshes affected pins once
//   4. Chains via `fx_sweep` queue message if more than `limit` rows remain
export async function sweepPendingFxConversions(ctx, { tenantId = null, limit = 25 } = {}) {
  const pending = await listPendingFxTransactions(ctx.db, { tenantId, limit });
  if (!pending.length) return { converted: 0, failed: 0 };

  const rateByPair = new Map();
  for (const row of pending) {
    const key = row.currency + "|" + row.occurred_on;
    if (rateByPair.has(key)) continue;
    const rate = await resolveOrFetchFxRate(ctx, row.currency, row.occurred_on);
    rateByPair.set(key, rate > 0 ? rate : null);
  }

  const now = ctx.now();
  const recentCutoff = shiftIsoDate(istDate(now), -2);
  const stmts = [];
  const recentCardsToRefresh = [];
  const touchedTenants = new Set();
  let converted = 0;
  let failed = 0;

  for (const row of pending) {
    const rate = rateByPair.get(row.currency + "|" + row.occurred_on);
    if (!(rate > 0)) {
      failed++;
      continue;
    }
    const inrMinor = convertMinorToInr(row.amount_minor, rate);
    stmts.push(
      ctx.db
        .prepare("UPDATE transactions SET inr_minor = ?, fx_rate = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
        .bind(inrMinor, rate, now, row.id, String(row.tenant_id))
    );
    converted++;
    touchedTenants.add(String(row.tenant_id));
    if (row.card_message_id && row.occurred_on >= recentCutoff) {
      recentCardsToRefresh.push(row);
    }
  }

  for (let i = 0; i < stmts.length; i += 40) {
    await ctx.db.batch(stmts.slice(i, i + 40));
  }

  for (const row of recentCardsToRefresh.slice(0, 5)) {
    await refreshCardMessage(ctx, row.tenant_id, row.id).catch(() => {});
  }
  for (const tid of touchedTenants) {
    await refreshPersonalPin(ctx, tid).catch(() => {});
  }
  if (pending.length >= limit && converted > 0) {
    await enqueueFxSweep(ctx, { tenantId });
  }
  return { converted, failed };
}
