import { describe, it, expect } from "vitest";
import { loadAppsScript } from "../../tests/_loader.js";
import { testContext, seedTenant, NOW } from "./helpers/app.js";
import worker from "../src/index.js";
import { ingest } from "../src/app/ingest.js";
import { getTenant } from "../src/db/tenants.js";
import { putEphemeral } from "../src/db/ephemeral.js";
import { logParserEvent, disableTemplate } from "../src/db/settings.js";
import { TelegramError } from "../src/telegram/client.js";
import { shouldNudge, formatParserDigest, runScheduled, nudgeDormantTenants, NUDGE_CONFIG } from "../src/app/cron.js";

const DAY = 86400000;
const legacy = loadAppsScript(
  ["Nudge.js", "ParserTelemetry.js"],
  ["shouldNudge", "formatParserDigest", "PARSER_EVENT"],
  {
    TENANT_CHAT_TYPE: { PERSONAL: "personal", GROUP: "group" }
  }
);
// NOW is a Wednesday; these are the next matching weekdays at 08:00 IST.
const at = (daysAhead) => NOW + daysAhead * DAY - 5.5 * 3600 * 1000;
const FRI = at(2);
const MON = at(5);
const TUE = at(6);

describe("shouldNudge matches Nudge.js", () => {
  const base = { kind: "personal", status: "active", nag_count: 0, created_at: NOW - 30 * DAY };
  it.each([
    ["fresh pending", { status: "pending", created_at: NOW - DAY }],
    ["pending 2d", { status: "pending", created_at: NOW - 2 * DAY }],
    ["active never forwarded", {}],
    ["inactive 4d", { last_activity_at: NOW - 4 * DAY }],
    ["inactive 9d", { last_activity_at: NOW - 9 * DAY }],
    ["cooldown", { last_activity_at: NOW - 9 * DAY, last_nag_at: NOW - 3 * DAY }],
    ["after cooldown", { last_activity_at: NOW - 20 * DAY, last_nag_at: NOW - 8 * DAY, nag_count: 2 }],
    ["capped", { last_activity_at: NOW - 20 * DAY, nag_count: 3 }],
    ["dormant", { status: "dormant", last_activity_at: NOW - 20 * DAY }],
    ["group", { kind: "group" }]
  ])("%s", (_name, o) => {
    const t = { ...base, ...o };
    const iso = (ms) => (ms ? new Date(ms).toISOString() : "");
    const legacyTenant = {
      chat_type: t.kind,
      status: t.status,
      nag_count: t.nag_count,
      created_at: iso(t.created_at),
      last_forward_at: iso(t.last_activity_at),
      last_nag_at: iso(t.last_nag_at)
    };
    expect(shouldNudge(t, NOW)).toEqual(legacy.shouldNudge(legacyTenant, new Date(NOW), NUDGE_CONFIG));
  });
});

it("parser digest matches ParserTelemetry.js", () => {
  const events = [
    ["hdfc_upi", "saved"],
    ["hdfc_upi", "saved"],
    ["hdfc_upi", "saved"],
    ["hdfc_upi", "reparse_requested"],
    ["hdfc_upi", "reparse_accepted"],
    ["icici_card", "shadow_match"],
    ["icici_card", "shadow_mismatch"],
    ["icici_card", "report"]
  ].map(([templateId, event]) => ({ templateId, event }));
  const summary = {};
  for (const e of events) {
    summary[e.templateId] = summary[e.templateId] || {};
    summary[e.templateId][e.event] = (summary[e.templateId][e.event] || 0) + 1;
  }
  expect(formatParserDigest(summary, "on", ["axis_x"])).toBe(legacy.formatParserDigest(events, "on", ["axis_x"]));
  expect(formatParserDigest({}, "shadow", [])).toBe(legacy.formatParserDigest([], "shadow", []));
});

describe("runScheduled", () => {
  it("Friday sends the weekly digest to active tenants with activity", async () => {
    const ctx = testContext({ now: FRI });
    const a = await seedTenant(ctx, "111");
    await seedTenant(ctx, "222");
    await ingest(ctx, {
      tenant: a,
      source: "sms",
      sourceRef: "s1",
      text: "Sent Rs.900.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678"
    });
    ctx.tg.calls.length = 0;
    expect(await runScheduled(ctx, FRI)).toEqual(["purge", "digest"]);
    const sent = ctx.tg.of("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0].args[0]).toBe("111");
    expect(sent[0].args[1]).toContain("*Last Week*");
    expect(sent[0].args[1]).toContain("₹900");
  });

  it("purges expired ephemeral rows every day", async () => {
    const ctx = testContext({ now: NOW });
    await putEphemeral(ctx.db, "old", 1, 60, NOW - 3600 * 1000);
    await putEphemeral(ctx.db, "live", 1, 600, NOW);
    expect(await runScheduled(ctx, NOW)).toEqual(["purge"]);
    const keys = (await ctx.db.prepare("SELECT key FROM ephemeral").all()).results.map((r) => r.key);
    expect(keys).toEqual(["live"]);
  });

  it("Tuesday nudges; the third nudge marks the tenant dormant", async () => {
    const ctx = testContext({ now: TUE });
    await seedTenant(ctx, "111", { status: "pending" });
    await seedTenant(ctx, "222");
    await ctx.db
      .prepare("UPDATE tenants SET last_activity_at = ? WHERE id = '222'")
      .bind(TUE - DAY)
      .run();
    expect(await runScheduled(ctx, TUE)).toEqual(["purge", "nudge"]);
    const [nudge] = ctx.tg.of("sendMessage");
    expect(nudge.args[0]).toBe("111");
    expect(nudge.args[2].reply_markup.inline_keyboard[0][0].callback_data).toBe("resend_setup");

    for (let i = 0; i < 2; i++) {
      ctx.advance(7 * DAY);
      await nudgeDormantTenants(ctx);
    }
    expect(await getTenant(ctx.db, "111")).toMatchObject({ status: "dormant", nag_count: 3 });
  });

  it("a tenant who blocked the bot goes dormant instead of failing every week", async () => {
    const ctx = testContext({ now: TUE });
    await seedTenant(ctx, "111", { status: "pending" });
    ctx.tg.sendMessage = async () => {
      throw new TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user");
    };
    expect(await nudgeDormantTenants(ctx)).toMatchObject({ nudged: 0, dormant: 1, failed: 0 });
    expect((await getTenant(ctx.db, "111")).status).toBe("dormant");
  });

  it("Monday sends the parser digest to the admin", async () => {
    const ctx = testContext({ now: MON });
    await logParserEvent(ctx.db, { templateId: "hdfc_upi", event: "saved" }, MON - DAY);
    await logParserEvent(ctx.db, { templateId: "old", event: "saved" }, MON - 8 * DAY);
    await disableTemplate(ctx.db, "axis_x");
    expect(await runScheduled(ctx, MON)).toEqual(["purge", "parser"]);
    const [msg] = ctx.tg.of("sendMessage");
    expect(msg.args[0]).toBe("999");
    expect(msg.args[1]).toContain("• `hdfc_upi` — saved 1");
    expect(msg.args[1]).not.toContain("`old`");
    expect(msg.args[1]).toContain("Disabled: `axis_x`");
  });

  it("the scheduled handler is a no-op until MODE=native", async () => {
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    await worker.scheduled({ scheduledTime: FRI }, {}, ctx);
    expect(waited).toHaveLength(0);
  });
});
