import { describe, it, expect } from "vitest";
import { testContext, seedTenant, NOW } from "./helpers/app.js";
import worker from "../src/index.js";
import { ingest } from "../src/app/ingest.js";
import { getTenant } from "../src/db/tenants.js";
import { putEphemeral } from "../src/db/ephemeral.js";
import { logParserEvent, disableTemplate } from "../src/db/settings.js";
import { TelegramError } from "../src/telegram/client.js";
import {
  shouldNudge,
  formatParserDigest,
  runScheduled,
  nudgeDormantTenants,
  sendDailyRecaps
} from "../src/app/cron.js";
import { handleUpdate } from "../src/app/webhook.js";
import { listUntaggedTransactions } from "../src/db/transactions.js";
import { ensurePersonalPin } from "../src/app/personalPin.js";

const DAY = 86400000;
// NOW is a Wednesday; these are the next matching weekdays at 08:00 IST.
const at = (daysAhead) => NOW + daysAhead * DAY - 5.5 * 3600 * 1000;
const FRI = at(2);
const MON = at(5);
const TUE = at(6);

// Expected values frozen from the Apps Script originals (Nudge.js).
describe("shouldNudge", () => {
  const base = { kind: "personal", status: "active", nag_count: 0, created_at: NOW - 30 * DAY };
  it.each([
    ["fresh pending", { status: "pending", created_at: NOW - DAY }, null],
    ["pending 2d", { status: "pending", created_at: NOW - 2 * DAY }, { kind: "pending", daysSilent: 2 }],
    ["active never forwarded", {}, { kind: "pending", daysSilent: 30 }],
    ["inactive 4d", { last_activity_at: NOW - 4 * DAY }, null],
    ["inactive 9d", { last_activity_at: NOW - 9 * DAY }, { kind: "inactive", daysSilent: 9 }],
    ["cooldown", { last_activity_at: NOW - 9 * DAY, last_nag_at: NOW - 3 * DAY }, null],
    [
      "after cooldown",
      { last_activity_at: NOW - 20 * DAY, last_nag_at: NOW - 8 * DAY, nag_count: 2 },
      { kind: "inactive", daysSilent: 20 }
    ],
    ["capped", { last_activity_at: NOW - 20 * DAY, nag_count: 3 }, null],
    ["dormant", { status: "dormant", last_activity_at: NOW - 20 * DAY }, null],
    ["group", { kind: "group" }, null]
  ])("%s", (_name, o, want) => {
    expect(shouldNudge({ ...base, ...o }, NOW)).toEqual(want);
  });
});

it("parser digest", () => {
  const summary = {
    hdfc_upi: { saved: 3, reparse_requested: 1, reparse_accepted: 1 },
    icici_card: { shadow_match: 1, shadow_mismatch: 1, report: 1 }
  };
  expect(formatParserDigest(summary, "on", ["axis_x"])).toBe(
    "🧪 *Parser — last 7 days* (mode: `on`)\n" +
      "• `hdfc_upi` — saved 3, re-read 1, wrong 1 (33%)\n" +
      "• `icici_card` — saved 0, shadow agree 50% of 2, reports 1\n\n" +
      "Disabled: `axis_x`"
  );
  expect(formatParserDigest({}, "shadow", [])).toBe(
    "🧪 *Parser — last 7 days* (mode: `shadow`)\n_No parser activity._"
  );
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

  it("the scheduled handler runs the jobs in the background", async () => {
    const waited = [];
    await worker.scheduled({ scheduledTime: NOW }, { DB: testContext().db }, { waitUntil: (p) => waited.push(p) });
    expect(waited).toHaveLength(1);
    expect(await waited[0]).toEqual(["purge"]);
  });

  it("21:00 IST daily recap skips quiet users, summarizes today's spends + untagged count, and drives the 1-tap tagq_ stepper", async () => {
    // 15:30 UTC on 2026-10-07 = 21:00 IST
    const EVENING = Date.UTC(2026, 9, 7, 15, 30);
    const ctx = testContext({ now: EVENING });
    const alice = await seedTenant(ctx, "111");
    await seedTenant(ctx, "222"); // quiet user — must receive nothing

    // 1 categorized + 2 untagged (two payments to RAHUL + one to KIRANA)
    await ingest(ctx, {
      tenant: alice,
      source: "sms",
      sourceRef: "s-swiggy",
      text: "Sent Rs.900.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678"
    });
    await ingest(ctx, {
      tenant: alice,
      source: "sms",
      sourceRef: "s-rahul-1",
      text: "Sent Rs.400.00 From HDFC Bank A/C *1234 To RAHUL 111 On 07/10/26 Ref 628011111111"
    });
    await ingest(ctx, {
      tenant: alice,
      source: "sms",
      sourceRef: "s-rahul-2",
      text: "Sent Rs.150.00 From HDFC Bank A/C *1234 To RAHUL 222 On 06/10/26 Ref 628022222222"
    });
    await ingest(ctx, {
      tenant: alice,
      source: "sms",
      sourceRef: "s-kirana",
      text: "Sent Rs.250.00 From HDFC Bank A/C *1234 To KIRANA STORE On 07/10/26 Ref 628033333333"
    });
    ctx.tg.calls.length = 0;

    expect(await runScheduled(ctx, EVENING)).toEqual(["daily_recap"]);
    const sent = ctx.tg.of("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0].args[0]).toBe("111");
    expect(sent[0].args[1]).toContain("*Today's Recap*");
    expect(sent[0].args[1]).toContain("*3 expenses need a category*");
    expect(sent[0].args[2].reply_markup.inline_keyboard[0][0]).toEqual({
      text: "🏷 Categorize 3 untagged",
      callback_data: "tagq_next"
    });
    const recapMsgId = sent[0].result.message_id;

    // Open stepper -> shows Kirana Store (most recent untagged, 1 of 3 left).
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb1",
        data: "tagq_next",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: recapMsgId }
      }
    });
    let edit = ctx.tg.of("editMessageText").at(-1).args;
    expect(edit[2]).toContain("1 of 3 left");
    expect(edit[2]).toContain("Kirana Store");

    // Swipe-reply "Zepto, Groceries" directly onto the stepper message -> renames & categorizes Kirana, advancing to Rahul 111!
    await handleUpdate(ctx, {
      message: {
        message_id: 501,
        chat: { id: 111, type: "private" },
        from: { id: 111, first_name: "Alice" },
        text: "Zepto, Groceries",
        reply_to_message: { message_id: recapMsgId }
      }
    });
    expect(ctx.tg.of("setMessageReaction").at(-1).args).toEqual(["111", 501, "👍"]);
    edit = ctx.tg.of("editMessageText").at(-1).args;
    expect(edit[2]).toContain("1 of 2 left");
    expect(edit[2]).toContain("Rahul 111");
    const rahulFoodCall = edit[3].reply_markup.inline_keyboard[0][0].callback_data; // Food (index 0)

    // Categorize Rahul 111 -> Food; shortened rule "rahul" auto-fills Rahul 222 too -> All caught up!
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb3",
        data: rahulFoodCall,
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: recapMsgId }
      }
    });
    expect(await listUntaggedTransactions(ctx.db, "111")).toHaveLength(0);
    expect(ctx.tg.of("editMessageText").at(-1).args[2]).toContain("*All caught up!*");

    // Quiet user check via direct stats
    ctx.tg.calls.length = 0;
    const stats = await sendDailyRecaps(ctx);
    // Alice still had todayRows > 0 so sent: 1, Bob had 0 today & 0 untagged so skipped: 1
    expect(stats).toMatchObject({ sent: 1, skipped: 1 });
  });

  it("personal live pin updates automatically on ingest and category fixes, and stats_back restores it", async () => {
    const ctx = testContext({ now: NOW });
    const alice = await seedTenant(ctx, "111");
    const pin = await ensurePersonalPin(ctx, "111");
    expect(pin.created).toBe(true);
    expect(ctx.tg.of("pinChatMessage")).toHaveLength(1);

    await ingest(ctx, {
      tenant: alice,
      source: "sms",
      sourceRef: "s-1",
      text: "Sent Rs.500.00 From HDFC Bank A/C *1234 To RAHUL On 07/10/26 Ref 628099998888"
    });
    const pinEdit = ctx.tg.of("editMessageText").find((c) => c.args[1] === pin.messageId);
    expect(pinEdit.args[2]).toContain("₹500 spent");
    expect(pinEdit.args[2]).toContain("🏷 1 untagged");

    // Navigate to Recent inside the pinned message, then Back restores the live pin text!
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-r",
        data: "stats_recent",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: pin.messageId }
      }
    });
    expect(ctx.tg.of("editMessageText").at(-1).args[2]).toContain("*Recent Transactions*");
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-b",
        data: "stats_back",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: pin.messageId }
      }
    });
    expect(ctx.tg.of("editMessageText").at(-1).args[2]).toContain("📌 *Oct 2026* · ₹500 spent · 🏷 1 untagged");

    // Tapping Categorize on the pinned message opens a fresh bottom stepper (preserving the pin), and Done deletes it.
    const sendCountBefore = ctx.tg.of("sendMessage").length;
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-step",
        data: "tagq_next",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: pin.messageId }
      }
    });
    const stepperSend = ctx.tg.of("sendMessage").at(-1);
    expect(ctx.tg.of("sendMessage")).toHaveLength(sendCountBefore + 1);
    expect(stepperSend.args[1]).toContain("🏷 *Categorize* _(1 of 1 left)_");
    expect(stepperSend.args[2].reply_markup.inline_keyboard.at(-1).map((b) => b.callback_data)).toEqual([
      expect.stringMatching(/^tagq_skip_/),
      "tagq_done"
    ]);

    const stepperMsgId = stepperSend.result.message_id;
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-done",
        data: "tagq_done",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: stepperMsgId }
      }
    });
    expect(ctx.tg.of("deleteMessage").some((c) => c.args[0] === "111" && c.args[1] === stepperMsgId)).toBe(true);
  });
});
