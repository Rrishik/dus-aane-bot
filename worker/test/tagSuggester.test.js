import { describe, it, expect } from "vitest";
import { testContext, seedTenant, NOW } from "./helpers/app.js";
import { insertTransaction, getTransaction, countUntaggedTransactions } from "../src/db/transactions.js";
import { extractIstTimeInfo, validateMerchantProposal, suggestTagsForBatch } from "../src/app/tagSuggester.js";
import { parseBatchStepperReply } from "../src/app/tagStepper.js";
import { parseCardQuickReply } from "../src/app/cardActions.js";
import { ensurePersonalPin } from "../src/app/personalPin.js";
import { sendDailyRecaps } from "../src/app/cron.js";
import { handleUpdate } from "../src/app/webhook.js";

// Helper: UTC ms corresponding to 2026-10-07 at `h:m` IST.
const istAt = (iso, h, m = 0) => {
  const [y, mo, d] = iso.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) - 5.5 * 3600 * 1000;
};

describe("timing & anti-hallucination helpers", () => {
  it("extracts POS IST hour from email received_at or embedded SMS time, never SMS paste time", () => {
    expect(extractIstTimeInfo({ email_received_at: istAt("2026-10-07", 4, 12) })).toEqual({
      time24: "04:12",
      display12h: "4:12 AM",
      hour: 4,
      slot: "late_night_batch"
    });
    expect(extractIstTimeInfo({ email_received_at: istAt("2026-10-07", 10, 37) })).toEqual({
      time24: "10:37",
      display12h: "10:37 AM",
      hour: 10,
      slot: "morning"
    });
    expect(
      extractIstTimeInfo({
        email_received_at: null,
        sms_raw_text: "Spent Rs.899 On HDFC Bank Card 5678 At NETFLIX On 2026-10-07:20:15:11"
      })
    ).toEqual({
      time24: "20:15",
      display12h: "8:15 PM",
      hour: 20,
      slot: "evening_dinner"
    });
    expect(extractIstTimeInfo({ email_received_at: null, sms_raw_text: "Sent Rs.100 On 07/10/26" })).toEqual({
      time24: null,
      display12h: null,
      hour: null,
      slot: null
    });
  });

  it("strips hallucinated brand names on merchantless rows while allowing generic or user-history labels", () => {
    const history = new Set(["maid", "society maintenance"]);
    const unnamed = { merchant: null, merchant_raw: null };
    expect(validateMerchantProposal(unnamed, "Swiggy", history)).toBeNull();
    expect(validateMerchantProposal(unnamed, "Starbucks", history)).toBeNull();
    expect(validateMerchantProposal(unnamed, "Dividend", history)).toBe("Dividend");
    expect(validateMerchantProposal(unnamed, "CC Bill", history)).toBe("CC Bill");
    expect(validateMerchantProposal(unnamed, "Maid", history)).toBe("Maid");

    const noisy = { merchant: "TWO VILLAS HOLIDAY CO ,LT", merchant_raw: "TWO VILLAS HOLIDAY CO ,LT" };
    expect(validateMerchantProposal(noisy, "Two Villas Holiday", history)).toBe("Two Villas Holiday");
    expect(validateMerchantProposal(noisy, "Uber", history)).toBeNull();
  });

  it("sets both merchant + category when swipe-replying descriptive aliases ('cc bill', 'dividend') on unnamed cards", () => {
    expect(parseCardQuickReply("cc bill", "debit", [], { hasMerchant: false })).toEqual({
      merchant: "CC Bill",
      category: "Transfer"
    });
    expect(parseCardQuickReply("dividend", "credit", [], { hasMerchant: false })).toEqual({
      merchant: "Dividend",
      category: "Income"
    });
    // Preserves existing merchant when one is already present.
    expect(parseCardQuickReply("cc bill", "debit", [], { hasMerchant: true })).toEqual({
      merchant: null,
      category: "Transfer"
    });
  });
});

describe("LLM + precedent batch tag suggestions & confirmation UX", () => {
  it("combines unnamed precedents + LLM timing/history suggestions, supports batch overrides, and commits in 1 tap", async () => {
    const llmReply = JSON.stringify({
      suggestions: [
        { index: 1, merchant: null, category: "Food", confidence: "high" },
        // Hallucinated "Swiggy" on merchantless row #3 must be stripped, and low confidence stays unchecked!
        { index: 3, merchant: "Swiggy", category: "Food", confidence: "low" },
        { index: 4, merchant: "Dividend", category: "Income", confidence: "high" }
      ]
    });
    const ctx = testContext({ now: NOW, llmReplies: [llmReply] });
    await seedTenant(ctx, "111");

    // Seed a past unnamed precedent: ₹899 debit on *1234 -> "CC Bill" · Transfer
    await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-09-07",
        amountMinor: 89900,
        currency: "INR",
        direction: "debit",
        kind: "transfer",
        merchant: "CC Bill",
        category: "Transfer",
        accountLast4: "1234"
      },
      { source: "email", sourceRef: "e-prec-1", receivedAt: istAt("2026-09-07", 3, 30) },
      NOW - 30 * 86400000
    );

    // 4 untagged rows in current window:
    // 1. Kanchi ₹431 at 10:37 AM (named restaurant)
    const idKanchi = await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-07",
        amountMinor: 43100,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "Kanchi",
        category: null
      },
      { source: "email", sourceRef: "e-1", receivedAt: istAt("2026-10-07", 10, 37) },
      NOW + 4
    );
    // 2. Unnamed ₹899 debit on *1234 (matches deterministic unnamed precedent!)
    const idCcBill = await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-07",
        amountMinor: 89900,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: null,
        category: null,
        accountLast4: "1234"
      },
      { source: "email", sourceRef: "e-2", receivedAt: istAt("2026-10-07", 3, 45) },
      NOW + 3
    );
    // 3. Brand-new ambiguous unnamed ₹350 debit at 6:20 PM
    const idUnknown = await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-06",
        amountMinor: 35000,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: null,
        category: null
      },
      { source: "email", sourceRef: "e-3", receivedAt: istAt("2026-10-06", 18, 20) },
      NOW + 2
    );
    // 4. Unnamed ₹100 credit at 4:12 AM (LLM suggests Dividend · Income)
    const idDiv = await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-06",
        amountMinor: 10000,
        currency: "INR",
        direction: "credit",
        kind: "income",
        merchant: null,
        category: null
      },
      { source: "email", sourceRef: "e-4", receivedAt: istAt("2026-10-06", 4, 12) },
      NOW + 1
    );

    const pin = await ensurePersonalPin(ctx, "111");
    // Open Categorize from pinned summary -> spawns fresh bottom batch suggestion card!
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-open",
        data: "tagq_next",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: pin.messageId }
      }
    });

    const batchSend = ctx.tg.of("sendMessage").at(-1);
    const batchMsgId = batchSend.result.message_id;
    expect(batchSend.args[1]).toContain("✨ *Suggested tags* _(4 left)_");
    expect(batchSend.args[1]).toContain("1. ✓ 🔴 *Kanchi* — ₹431");
    expect(batchSend.args[1]).toContain("🍕 *Food*");
    expect(batchSend.args[1]).toContain("2. ✓ 🔴 *₹899*");
    expect(batchSend.args[1]).toContain("*CC Bill* · 💸 *Transfer*");
    expect(batchSend.args[1]).toContain("3. ❓ 🔴 *₹350*");
    expect(batchSend.args[1]).not.toContain("Swiggy"); // Hallucination stripped!
    expect(batchSend.args[1]).toContain("4. ✓ 🟢 *₹100*");
    expect(batchSend.args[1]).toContain("*Dividend* · 💼 *Income*");
    expect(batchSend.args[1]).not.toMatch(/_[^_\n]*`[^`\n]+`[^_\n]*_/);
    expect(batchSend.args[2].reply_markup.inline_keyboard[0][0].text).toBe("✅ Accept 3 suggestions");

    // Verify timing was sent in LLM prompt payload.
    const llmPromptPayload = JSON.parse(ctx.llm.calls[0][1].content);
    expect(llmPromptPayload.untagged[0]).toMatchObject({ merchant: "Kanchi", ist_time: "10:37", slot: "morning" });
    expect(llmPromptPayload.untagged[3]).toMatchObject({ amount: 100, ist_time: "04:12", slot: "late_night_batch" });

    // Swipe-reply override for item #3 ("3 Chai Food") -> updates card in-place to "Accept 4 suggestions"!
    await handleUpdate(ctx, {
      message: {
        message_id: 701,
        chat: { id: 111, type: "private" },
        from: { id: 111, first_name: "Alice" },
        text: "3 Chai Food",
        reply_to_message: { message_id: batchMsgId }
      }
    });
    const previewEdit = ctx.tg.of("editMessageText").at(-1).args;
    expect(previewEdit[2]).toContain("*Chai* · 🍕 *Food*");
    expect(previewEdit[3].reply_markup.inline_keyboard[0][0].text).toBe("✅ Accept 4 suggestions");

    // 1 tap on [✅ Accept 4 suggestions] commits all 4 and marks "All caught up!"
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-acc",
        data: "tagq_accept",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: batchMsgId }
      }
    });
    expect(await countUntaggedTransactions(ctx.db, "111")).toBe(0);
    expect(await getTransaction(ctx.db, "111", idKanchi)).toMatchObject({ merchant: "Kanchi", category: "Food" });
    expect(await getTransaction(ctx.db, "111", idCcBill)).toMatchObject({ merchant: "CC Bill", category: "Transfer" });
    expect(await getTransaction(ctx.db, "111", idUnknown)).toMatchObject({ merchant: "Chai", category: "Food" });
    expect(await getTransaction(ctx.db, "111", idDiv)).toMatchObject({ merchant: "Dividend", category: "Income" });
    expect(ctx.tg.of("editMessageText").at(-1).args[2]).toContain("✅ *All caught up!* Tagged 4 transactions.");
  });

  it("persists skippedIds in 1-by-1 mode so tagging item #3 never throws the user back to skipped items #1 and #2", async () => {
    const ctx = testContext({ now: NOW });
    await seedTenant(ctx, "111");
    for (const [i, name] of [
      [1, "Alpha"],
      [2, "Beta"],
      [3, "Gamma"],
      [4, "Delta"]
    ]) {
      await insertTransaction(
        ctx.db,
        "111",
        {
          occurredOn: "2026-10-07",
          amountMinor: i * 10000,
          currency: "INR",
          direction: "debit",
          kind: "spend",
          merchant: name,
          category: null
        },
        { source: "sms", sourceRef: "s-" + i },
        NOW + (10 - i)
      );
    }

    const pin = await ensurePersonalPin(ctx, "111");
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-1",
        data: "tagq_next",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: pin.messageId }
      }
    });
    const stepperMsg = ctx.tg.of("sendMessage").at(-1);
    const msgId = stepperMsg.result.message_id;
    expect(stepperMsg.args[1]).toContain("*Alpha*");

    // Skip Alpha and Beta -> lands on Gamma (3 of 4 left)
    const skipAlpha = stepperMsg.args[2].reply_markup.inline_keyboard
      .at(-1)
      .find((b) => b.text.includes("Skip")).callback_data;
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-s1",
        data: skipAlpha,
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: msgId }
      }
    });
    let edit = ctx.tg.of("editMessageText").at(-1).args;
    expect(edit[2]).toContain("*Beta*");

    const skipBeta = edit[3].reply_markup.inline_keyboard.at(-1).find((b) => b.text.includes("Skip")).callback_data;
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-s2",
        data: skipBeta,
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: msgId }
      }
    });
    edit = ctx.tg.of("editMessageText").at(-1).args;
    expect(edit[2]).toContain("3 of 4 left");
    expect(edit[2]).toContain("*Gamma*");

    // Tag Gamma -> must advance forward to Delta (NOT jump back to Alpha/Beta!)
    const tagGammaFood = edit[3].reply_markup.inline_keyboard[0][0].callback_data;
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-t3",
        data: tagGammaFood,
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: msgId }
      }
    });
    edit = ctx.tg.of("editMessageText").at(-1).args;
    expect(edit[2]).toContain("*Delta*");
    expect(edit[2]).not.toContain("*Alpha*");
    expect(edit[2]).not.toContain("*Beta*");
  });

  it("pre-renders LLM suggestions + [✅ Accept] button directly inside the 21:00 IST Daily Recap", async () => {
    const EVENING = Date.UTC(2026, 9, 7, 15, 30); // 21:00 IST
    const llmReply = JSON.stringify({
      suggestions: [{ index: 1, merchant: null, category: "Groceries", confidence: "high" }]
    });
    const ctx = testContext({ now: EVENING, llmReplies: [llmReply] });
    await seedTenant(ctx, "111");
    const idKirana = await insertTransaction(
      ctx.db,
      "111",
      {
        occurredOn: "2026-10-07",
        amountMinor: 32000,
        currency: "INR",
        direction: "debit",
        kind: "spend",
        merchant: "Kirana Corner",
        category: null
      },
      { source: "email", sourceRef: "e-recap-1", receivedAt: istAt("2026-10-07", 9, 15) },
      EVENING - 3600000
    );

    await sendDailyRecaps(ctx);
    const recap = ctx.tg.of("sendMessage").at(-1);
    expect(recap.args[1]).toContain("✨ *Suggested tags*");
    expect(recap.args[1]).toContain("*Kirana Corner* — ₹320");
    expect(recap.args[1]).toContain("🥦 *Groceries*");
    expect(recap.args[2].reply_markup.inline_keyboard[0][0]).toEqual({
      text: "✅ Accept 1 suggestion",
      callback_data: "tagq_accept"
    });

    // 1 tap on [✅ Accept 1 suggestion] right on the Daily Recap bubble tags it!
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb-recap-acc",
        data: "tagq_accept",
        from: { id: 111 },
        message: { chat: { id: 111 }, message_id: recap.result.message_id }
      }
    });
    expect(await getTransaction(ctx.db, "111", idKirana)).toMatchObject({ category: "Groceries" });
  });

  it("parseBatchStepperReply supports ranges, skips, and trailing ', ok' auto-accept", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const rowsById = new Map([
      ["a", { id: "a", direction: "debit", merchant: "M1" }],
      ["b", { id: "b", direction: "debit", merchant: null }],
      ["c", { id: "c", direction: "debit", merchant: "M3" }]
    ]);
    expect(parseBatchStepperReply("1-2 Food, 3 skip, ok", items, rowsById)).toEqual({
      acceptNow: true,
      edits: [
        { index: 0, merchant: null, category: "Food" },
        { index: 1, merchant: null, category: "Food" },
        { index: 2, skip: true }
      ]
    });
  });
});
