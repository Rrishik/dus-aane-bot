import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let parseBackfillDuration;

beforeAll(() => {
  // BotHandlers.js references many globals (sendTelegramMessage, CATEGORIES,
  // MESSAGE_ID_COLUMN, ...) at *call* time but not at *load* time, so we can
  // load it standalone for parser tests. Stub anything the top-level might
  // touch as a no-op.
  const noop = () => undefined;
  ({ parseBackfillDuration } = loadAppsScript(["BotHandlers.js"], ["parseBackfillDuration"], {
    sendTelegramMessage: noop,
    PropertiesService: { getScriptProperties: () => ({ getProperty: noop, setProperty: noop, deleteProperty: noop }) }
  }));
});

const NOW = new Date("2026-04-15T12:00:00Z"); // fixed reference for relative cases

function diffMinutes(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

describe("parseBackfillDuration — compact form", () => {
  it("parses '/backfill 10m' as 10 minutes back", () => {
    const r = parseBackfillDuration("/backfill 10m", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(10);
    expect(r.endDate.getTime()).toBe(NOW.getTime());
  });

  it("parses '/backfill 2h' as 120 minutes back", () => {
    const r = parseBackfillDuration("/backfill 2h", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(120);
  });

  it("parses '/backfill 3d' as 3 days back", () => {
    const r = parseBackfillDuration("/backfill 3d", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(3 * 24 * 60);
  });

  it("parses '/backfill 1w' as 7 days back", () => {
    const r = parseBackfillDuration("/backfill 1w", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(7 * 24 * 60);
  });

  it("is case-insensitive on the unit", () => {
    const r = parseBackfillDuration("/backfill 5M", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(5);
  });
});

describe("parseBackfillDuration — spaced form", () => {
  it("parses '/backfill 3 days'", () => {
    const r = parseBackfillDuration("/backfill 3 days", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(3 * 24 * 60);
  });

  it("parses '/backfill 2 weeks'", () => {
    const r = parseBackfillDuration("/backfill 2 weeks", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(14 * 24 * 60);
  });

  it("parses '/backfill 10 mins'", () => {
    const r = parseBackfillDuration("/backfill 10 mins", NOW);
    expect(r.ok).toBe(true);
    expect(diffMinutes(r.startDate, r.endDate)).toBe(10);
  });

  it("parses '/backfill 1 month' (calendar-aware)", () => {
    const r = parseBackfillDuration("/backfill 1 month", NOW);
    expect(r.ok).toBe(true);
    // March 15 → April 15
    expect(r.startDate.getUTCMonth()).toBe(2);
    expect(r.endDate.getUTCMonth()).toBe(3);
  });
});

describe("parseBackfillDuration — absolute date range", () => {
  it("parses '/backfill YYYY-MM-DD YYYY-MM-DD'", () => {
    const r = parseBackfillDuration("/backfill 2026-03-01 2026-03-31", NOW);
    expect(r.ok).toBe(true);
    expect(r.startDate.getTime()).toBe(new Date("2026-03-01").getTime());
    expect(r.endDate.getTime()).toBe(new Date("2026-03-31").getTime());
  });
});

describe("parseBackfillDuration — error cases", () => {
  it("returns usage error on '/backfill' alone", () => {
    expect(parseBackfillDuration("/backfill", NOW)).toEqual({ ok: false, error: "usage" });
  });

  it("returns usage error on garbage like '/backfill foo'", () => {
    // 'foo' has no compact match and no spaced unit follows → falls through to usage.
    expect(parseBackfillDuration("/backfill foo", NOW)).toEqual({ ok: false, error: "usage" });
  });

  it("returns invalid_dates on '/backfill notadate alsobad'", () => {
    expect(parseBackfillDuration("/backfill notadate alsobad", NOW)).toEqual({ ok: false, error: "invalid_dates" });
  });

  it("returns invalid_range when start > end", () => {
    const r = parseBackfillDuration("/backfill 2026-04-01 2026-03-01", NOW);
    expect(r).toEqual({ ok: false, error: "invalid_range" });
  });

  it("returns unknown_unit on '/backfill 5 fortnights'", () => {
    // Spaced form picks up 'fortnights' as unit; not in BACKFILL_UNIT_MAP.
    expect(parseBackfillDuration("/backfill 5 fortnights", NOW)).toEqual({ ok: false, error: "unknown_unit" });
  });
});
