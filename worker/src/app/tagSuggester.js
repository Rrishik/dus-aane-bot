// Batched historical + timing-aware LLM tag suggester for untagged transactions.
//
// Combines:
//   1. True POS time-of-day (`email_received_at` -> IST HH:MM; never SMS paste time)
//   2. Calendar cadence (weekday, day-of-month 1..31 for rent/maid/SIP/autopay)
//   3. Instrument fingerprint (`account_last4`, `parsed_by` template id, currency)
//   4. User's own historical ledger & past unnamed-alert precedents (e.g. Dividend, CC Bill)
//   5. Same-day neighboring transactions (e.g. foreign-currency trip context)
//
// Enforces a strict post-validator so merchantless bank alerts never receive
// hallucinated retail brand names.
import { listTaggingContext } from "../db/transactions.js";
import { getMerchantRules, resolveMerchant } from "../db/merchantRules.js";
import { guessCategory } from "../parser/index.js";
import { parseJsonContent } from "../llm/azure.js";
import { CANONICAL_GENERIC_LABELS, canonicalizeMerchant, normalizeUserMerchantInput } from "./merchants.js";
import { CATEGORIES, CREDIT_CATEGORIES, TAG_MAX_LEN, categoriesFor } from "./constants.js";
import { IST_OFFSET_MS } from "../util/dates.js";
import { fromMinor } from "../util/money.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const GENERIC_BANK_LABELS = new Set([
  "cc bill",
  "card bill",
  "credit card bill",
  "dividend",
  "interest",
  "salary",
  "cashback",
  "refund",
  "transfer",
  "self transfer",
  "sip",
  "investment",
  "autopay",
  "bill payment",
  "atm",
  "atm withdrawal",
  "emi",
  "rent",
  "maintenance",
  "mutual funds",
  "stocks",
  "gold",
  "househelp",
  "broadband",
  "electricity",
  "fuel",
  "cab",
  "auto",
  "kirana",
  "pharmacy",
  "doctor"
]);

function slotForHour(h) {
  if (h == null) return null;
  if (h < 6) return "late_night_batch";
  if (h < 11) return "morning";
  if (h < 15) return "lunch";
  if (h < 19) return "afternoon";
  return "evening_dinner";
}

function format12h(h, m) {
  const suffix = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return hr + ":" + String(m).padStart(2, "0") + " " + suffix;
}

// Extract IST time-of-day only from trustworthy POS timestamps (bank email Date
// header, or an explicit HH:MM embedded inside an SMS body — never SMS paste time).
export function extractIstTimeInfo(row) {
  if (row && Number.isFinite(Number(row.email_received_at)) && Number(row.email_received_at) > 0) {
    const d = new Date(Number(row.email_received_at) + IST_OFFSET_MS);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    return {
      time24: String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"),
      display12h: format12h(h, m),
      hour: h,
      slot: slotForHour(h)
    };
  }
  if (row && row.sms_raw_text) {
    const match = String(row.sms_raw_text).match(/(?:T|\s|:)(\d{2}):(\d{2})(?::\d{2})?(?:\b|$)/);
    if (match) {
      const h = Number(match[1]);
      const m = Number(match[2]);
      if (h >= 0 && h < 24 && m >= 0 && m < 60) {
        return {
          time24: String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"),
          display12h: format12h(h, m),
          hour: h,
          slot: slotForHour(h)
        };
      }
    }
  }
  return { time24: null, display12h: null, hour: null, slot: null };
}

export function calendarInfo(isoDate) {
  const [y, m, d] = String(isoDate || "2026-01-01")
    .split("-")
    .map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return { weekday: WEEKDAYS[dt.getUTCDay()], dayOfMonth: d || 1 };
}

function matchUnnamedPrecedent(row, precedents) {
  if (row.merchant || row.merchant_raw || !precedents || !precedents.length) return null;
  const valid = categoriesFor(row.direction);
  const sameInstrument = precedents.filter(
    (p) =>
      p.direction === row.direction &&
      p.currency === row.currency &&
      valid.includes(p.category) &&
      (!row.account_last4 || !p.account_last4 || row.account_last4 === p.account_last4)
  );
  if (!sameInstrument.length) return null;

  // 1. Exact/near-exact amount precedent (±2%).
  const exact = sameInstrument.find(
    (p) => Math.abs(p.amount_minor - row.amount_minor) <= Math.max(100, row.amount_minor * 0.02)
  );
  if (exact) {
    return { merchant: exact.merchant || null, category: exact.category, confident: true };
  }

  // 2. Repeated precedent with identical (merchant, category) in a similar amount band.
  const counts = new Map();
  for (const p of sameInstrument) {
    const ratio = row.amount_minor > 0 && p.amount_minor > 0 ? row.amount_minor / p.amount_minor : 0;
    if (ratio < 0.2 || ratio > 5) continue;
    const key = (p.merchant || "") + "\0" + p.category;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts.entries()) {
    if (count >= 2) {
      const [merchant, category] = key.split("\0");
      return { merchant: merchant || null, category, confident: true };
    }
  }
  return null;
}

function alnumTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

// Guard against hallucinated retail brand names on merchantless bank alerts
// and prevent overwriting an existing merchant with an unrelated name.
export function validateMerchantProposal(row, proposed, allowedHistoryLabels) {
  const clean = normalizeUserMerchantInput(proposed);
  if (!clean || clean.length > TAG_MAX_LEN) return null;
  const lower = clean.toLowerCase();
  if (lower === "unknown" || lower === "untagged" || lower === "null") return null;

  const existing = String(row.merchant || row.merchant_raw || "").trim();
  if (existing) {
    if (existing.toLowerCase() === lower) return null;
    if (row.merchant && String(row.merchant).trim().toLowerCase() !== "unknown") {
      // Keep user/rule merchant unless cleaning corporate suffixes of the same name.
      const origTokens = alnumTokens(existing);
      const nextTokens = alnumTokens(clean);
      const overlaps =
        nextTokens.length > 0 && nextTokens.every((t) => origTokens.some((o) => o.includes(t) || t.includes(o)));
      return overlaps ? clean : null;
    }
    const origTokens = alnumTokens(existing);
    const nextTokens = alnumTokens(clean);
    const overlaps = nextTokens.some((t) => origTokens.some((o) => o.includes(t) || t.includes(o)));
    if (overlaps || allowedHistoryLabels.has(lower)) return clean;
    return null;
  }

  // Merchantless bank alert: only allow generic banking labels or labels from user's own history.
  if (GENERIC_BANK_LABELS.has(lower) || allowedHistoryLabels.has(lower)) return clean;
  return null;
}

export function suggestionSystemPrompt() {
  return (
    "You suggest categories (and optional merchant labels) for untagged personal finance transactions using:\n" +
    "1. World knowledge of merchants/brands/restaurants/hospitals/airlines.\n" +
    "2. POS timing (`ist_time` / `slot` / `weekday` / `day_of_month`):\n" +
    "   - 00:00–06:00 (`late_night_batch`): automated ACH dividends, interest, SIPs, autopay bills, CC bill payments.\n" +
    "   - 07:00–10:30 / 12:00–14:30 / 19:00–22:30: meals/snacks (`Food`) or commute (`Travel`) when merchant/amount fits.\n" +
    "   - Days 1–10 of month with recurring round amounts: rent, maid, maintenance (`Bills`) or SIP (`Invest`).\n" +
    "3. User's `unnamed_precedents` and `recent_history` (match account_last4, direction, amount band, parsed_by template, recurring payees).\n" +
    "4. `same_day_neighbors` (e.g. foreign currency or travel cluster on the same day).\n\n" +
    "Valid Debit categories: " +
    CATEGORIES.join(", ") +
    "\nValid Credit categories: " +
    CREDIT_CATEGORIES.join(", ") +
    "\n\n" +
    "STRICT ANTI-HALLUCINATION RULES:\n" +
    "- If `merchant` and `merchant_raw` are BOTH null/empty: NEVER invent a specific retail store/brand name (never guess 'Swiggy', 'Uber', 'Amazon'). Only propose a `merchant` label if it matches `unnamed_precedents` (e.g. 'Dividend', 'CC Bill', 'SIP') or is a generic banking label ('CC Bill', 'Dividend', 'Interest', 'Salary', 'Cashback', 'Transfer', 'Bill Payment') supported by timing/template/history; otherwise set `merchant` to null.\n" +
    "- If a transaction already has `merchant`, keep `merchant` null unless cleaning noisy legal suffixes (e.g. 'TWO VILLAS HOLIDAY CO ,LT' -> 'Two Villas Holiday').\n" +
    "- Set `confidence` to 'high' or 'medium' ONLY when merchant name, user history, or strong structural/timing evidence supports the category. If an unnamed alert or person's name has no history and ambiguous amount/timing, set `confidence` to 'low'.\n\n" +
    'Return ONLY JSON: {"suggestions":[{"index":1,"merchant":null,"category":"Food","confidence":"high"}]}'
  );
}

function summarizeHistoryRow(r) {
  const t = extractIstTimeInfo(r);
  const cal = calendarInfo(r.occurred_on);
  return {
    date: r.occurred_on,
    day: cal.dayOfMonth,
    wkd: cal.weekday,
    time: t.time24,
    dir: r.direction,
    amt: fromMinor(r.amount_minor),
    cur: r.currency,
    acct: r.account_last4 || undefined,
    tpl: r.parsed_by || undefined,
    raw: r.merchant_raw || undefined,
    merchant: r.merchant || null,
    cat: r.category
  };
}

// Returns [{ id, merchant, category, confident, displayTime, weekday }] aligned with `rows`.
export async function suggestTagsForBatch(ctx, tenantId, rows) {
  if (!rows || rows.length === 0) return [];
  const tid = String(tenantId);
  const targetDates = rows.map((r) => r.occurred_on);
  const [rules, history] = await Promise.all([
    getMerchantRules(ctx.db, tid),
    listTaggingContext(ctx.db, tid, { targetDates, historyLimit: 50 })
  ]);

  const allowedHistoryLabels = new Set();
  for (const r of [...history.unnamedPrecedents, ...history.recentTagged]) {
    if (r.merchant) allowedHistoryLabels.add(String(r.merchant).trim().toLowerCase());
  }

  // Deterministic pre-pass (merchant rules + keyword guesser + exact unnamed precedents).
  const out = rows.map((r) => {
    const t = extractIstTimeInfo(r);
    const cal = calendarInfo(r.occurred_on);
    const valid = categoriesFor(r.direction);
    const rawName = r.merchant || r.merchant_raw;
    if (rawName) {
      const resolved = resolveMerchant(rawName, rules);
      const canon = canonicalizeMerchant(resolved.merchant || rawName, rules);
      const guessed =
        (resolved.category && valid.includes(resolved.category) && resolved.category) ||
        (canon.category && valid.includes(canon.category) && canon.category) ||
        guessCategory(canon.merchant || resolved.merchant || rawName, r.direction === "credit" ? "Credit" : "Debit");
      if (guessed && valid.includes(guessed)) {
        const bestName = canon.merchant || resolved.merchant;
        const cleanedName = bestName && bestName !== r.merchant ? bestName : null;
        return {
          id: r.id,
          merchant: cleanedName,
          category: guessed,
          confident: true,
          displayTime: t.display12h,
          weekday: cal.weekday
        };
      }
    } else {
      const prec = matchUnnamedPrecedent(r, history.unnamedPrecedents);
      if (prec) {
        return {
          id: r.id,
          merchant: prec.merchant,
          category: prec.category,
          confident: prec.confident,
          displayTime: t.display12h,
          weekday: cal.weekday
        };
      }
    }
    return {
      id: r.id,
      merchant: null,
      category: null,
      confident: false,
      displayTime: t.display12h,
      weekday: cal.weekday
    };
  });

  const needsLlm = out.some((s) => !s.confident);
  if (!needsLlm || !ctx.llm || typeof ctx.llm.chat !== "function") return out;

  // Deduplicate recent_history so 30 Swiggy orders don't crowd out rarer recurring bills.
  const seenKeys = new Set();
  const compactRecent = [];
  for (const r of history.recentTagged) {
    const key = (r.merchant || r.merchant_raw || "") + "|" + r.category + "|" + r.direction;
    const countKey = "c:" + key;
    const seenCount = seenKeys.has(countKey) ? 2 : seenKeys.has(key) ? 1 : 0;
    if (seenCount >= 2) continue;
    seenKeys.add(seenCount === 1 ? countKey : key);
    compactRecent.push(summarizeHistoryRow(r));
    if (compactRecent.length >= 35) break;
  }

  const payload = {
    untagged: rows.map((r, i) => {
      const t = extractIstTimeInfo(r);
      const cal = calendarInfo(r.occurred_on);
      return {
        index: i + 1,
        date: r.occurred_on,
        day_of_month: cal.dayOfMonth,
        weekday: cal.weekday,
        ist_time: t.time24,
        slot: t.slot,
        direction: r.direction,
        amount: fromMinor(r.amount_minor),
        currency: r.currency,
        account_last4: r.account_last4 || null,
        parsed_by: r.parsed_by || null,
        merchant_raw: r.merchant_raw || null,
        merchant: r.merchant || null
      };
    }),
    unnamed_precedents: history.unnamedPrecedents.slice(0, 15).map(summarizeHistoryRow),
    recent_history: compactRecent,
    same_day_neighbors: history.sameDayNeighbors.slice(0, 15).map(summarizeHistoryRow)
  };

  try {
    const choice = await ctx.llm.chat({
      messages: [
        { role: "system", content: suggestionSystemPrompt() },
        { role: "user", content: JSON.stringify(payload) }
      ],
      maxTokens: 900
    });
    const parsed = parseJsonContent(choice && choice.message && choice.message.content);
    const list = parsed && Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    for (const item of list) {
      const idx = Number(item && item.index) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) continue;
      if (out[idx].confident) continue; // Deterministic personal rule wins.
      const row = rows[idx];
      const valid = categoriesFor(row.direction);
      const cat = item && typeof item.category === "string" ? item.category.trim() : "";
      if (!valid.includes(cat)) continue;
      const conf = String((item && item.confidence) || "").toLowerCase();
      const confident = conf === "high" || conf === "medium";
      const merchant = validateMerchantProposal(row, item.merchant, allowedHistoryLabels);
      out[idx] = {
        ...out[idx],
        merchant,
        category: cat,
        confident
      };
    }
  } catch (_) {
    // Graceful degradation when LLM is offline or unscripted in unit tests.
  }

  return out;
}
