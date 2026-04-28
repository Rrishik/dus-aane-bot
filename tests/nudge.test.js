import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let shouldNudge, formatNudgeMessage, NUDGE_CONFIG;

beforeAll(() => {
  ({ shouldNudge, formatNudgeMessage, NUDGE_CONFIG } = loadAppsScript(
    ["Nudge.js"],
    ["shouldNudge", "formatNudgeMessage", "NUDGE_CONFIG"],
    {}
  ));
});

const NOW = new Date("2026-04-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function tenant(overrides) {
  return Object.assign(
    {
      chat_id: "111",
      name: "Alice",
      status: "active",
      created_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
      last_forward_at: "",
      last_nag_at: "",
      nag_count: 0
    },
    overrides
  );
}

describe("shouldNudge — inactive branch", () => {
  it("nudges when last_forward_at is older than inactiveDays", () => {
    var t = tenant({ last_forward_at: new Date(NOW.getTime() - 6 * DAY_MS).toISOString() });
    var d = shouldNudge(t, NOW, NUDGE_CONFIG);
    expect(d).toEqual({ kind: "inactive", daysSilent: 6 });
  });

  it("does not nudge when last_forward_at is recent", () => {
    var t = tenant({ last_forward_at: new Date(NOW.getTime() - 3 * DAY_MS).toISOString() });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });

  it("nudges exactly at the inactiveDays boundary", () => {
    var t = tenant({ last_forward_at: new Date(NOW.getTime() - 5 * DAY_MS).toISOString() });
    var d = shouldNudge(t, NOW, NUDGE_CONFIG);
    expect(d).toEqual({ kind: "inactive", daysSilent: 5 });
  });
});

describe("shouldNudge — pending branch", () => {
  it("nudges when created_at is older than pendingDays and never forwarded", () => {
    var t = tenant({
      created_at: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
      last_forward_at: ""
    });
    var d = shouldNudge(t, NOW, NUDGE_CONFIG);
    expect(d).toEqual({ kind: "pending", daysSilent: 3 });
  });

  it("does not nudge when newly created and never forwarded", () => {
    var t = tenant({
      created_at: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
      last_forward_at: ""
    });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });

  it("does not nudge when both created_at and last_forward_at are missing", () => {
    var t = tenant({ created_at: "", last_forward_at: "" });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });
});

describe("shouldNudge — cooldown", () => {
  it("skips nudges within cooldown window", () => {
    var t = tenant({
      last_forward_at: new Date(NOW.getTime() - 20 * DAY_MS).toISOString(),
      last_nag_at: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
      nag_count: 1
    });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });

  it("nudges again after cooldown elapses", () => {
    var t = tenant({
      last_forward_at: new Date(NOW.getTime() - 20 * DAY_MS).toISOString(),
      last_nag_at: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
      nag_count: 1
    });
    var d = shouldNudge(t, NOW, NUDGE_CONFIG);
    expect(d.kind).toBe("inactive");
  });
});

describe("shouldNudge — caps and status gates", () => {
  it("does not nudge once nag_count reaches maxNudges", () => {
    var t = tenant({
      last_forward_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
      nag_count: 3
    });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });

  it("does not nudge tenants in pending status", () => {
    var t = tenant({
      status: "pending",
      created_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString()
    });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });

  it("does not nudge tenants in disabled status", () => {
    var t = tenant({ status: "disabled", last_forward_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString() });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });

  it("does not nudge tenants already in dormant status", () => {
    var t = tenant({ status: "dormant", last_forward_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString() });
    expect(shouldNudge(t, NOW, NUDGE_CONFIG)).toBeNull();
  });

  it("returns null for a null tenant", () => {
    expect(shouldNudge(null, NOW, NUDGE_CONFIG)).toBeNull();
  });
});

describe("formatNudgeMessage", () => {
  it("uses pending copy for pending kind", () => {
    var msg = formatNudgeMessage({ kind: "pending", daysSilent: 3 }, "Alice");
    expect(msg).toContain("Hi Alice");
    expect(msg).toMatch(/haven't forwarded|set up/i);
  });

  it("uses inactive copy with day count for inactive kind", () => {
    var msg = formatNudgeMessage({ kind: "inactive", daysSilent: 7 }, "Bob");
    expect(msg).toContain("Hi Bob");
    expect(msg).toContain("7 days");
  });

  it("falls back to a generic greeting when name is empty", () => {
    var msg = formatNudgeMessage({ kind: "pending", daysSilent: 2 }, "");
    expect(msg.startsWith("Hi! 👋")).toBe(true);
  });
});
