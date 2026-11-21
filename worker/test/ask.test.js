import { describe, it, expect } from "vitest";
import { testContext, seedTenant, seedGroup, llmTxn, NOW } from "./helpers/app.js";
import { handleUpdate } from "../src/app/webhook.js";
import { ingest } from "../src/app/ingest.js";
import { getTransaction } from "../src/db/transactions.js";
import { getMerchantRules } from "../src/db/merchantRules.js";
import { getSplitForTransaction, createSplit } from "../src/db/splits.js";
import { capHitMessage, askToolExecutor, classifyFastAgent } from "../src/app/ask.js";
import { FREE_ASK_LIMIT } from "../src/app/constants.js";

const SMS = "Sent Rs.900.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161";

const msg = (text, replyTo) => ({
  message: {
    chat: { id: 111, type: "private" },
    from: { id: 111, first_name: "Alice" },
    text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {})
  }
});
const tap = (data, messageId) => ({
  callback_query: { id: "cb", data, from: { id: 111 }, message: { chat: { id: 111 }, message_id: messageId } }
});
let callSeq = 0;
const toolCall = (name, args = {}) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c" + ++callSeq, type: "function", function: { name, arguments: JSON.stringify(args) } }]
});
const toolResults = (llmCall) => llmCall.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
const lastSent = (ctx) => ctx.tg.of("sendMessage").at(-1);

async function setup({ groups = false } = {}) {
  const replies = [];
  const ctx = testContext({ llmReplies: replies });
  const tenant = await seedTenant(ctx, "111");
  if (groups) {
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"]);
  }
  const res = await ingest(ctx, { tenant, source: "sms", sourceRef: "s1", text: SMS });
  ctx.tg.calls.length = 0;
  return { ctx, replies, id: res.transactionId };
}

describe("/ask", () => {
  it("answers with tools, plain text and a Follow up button; counts only own share of splits", async () => {
    const { ctx, replies, id } = await setup({ groups: true });
    await createSplit(ctx.db, {
      transactionId: id,
      groupId: "-100",
      payerId: "111",
      mode: "50",
      shares: [
        { holderId: "111", amountMinor: 45000 },
        { holderId: "222", amountMinor: 45000 }
      ]
    });
    replies.push(
      toolCall("get_spending_summary", { start_date: "2026-10-01", end_date: "2026-10-07" }),
      "You spent ₹450."
    );
    await handleUpdate(ctx, msg("how much this week?"));

    const [first, second] = ctx.llm.calls;
    expect(first[0].content).toContain("Today's date is 2026-10-07");
    expect(first[1]).toEqual({ role: "user", content: "how much this week?" });
    expect(toolResults(second)[0]).toMatchObject({ spend_count: 1, spend_by_currency: { INR: 450 } });

    const out = lastSent(ctx);
    expect(out.args[1]).toBe("You spent ₹450.");
    expect(out.args[2].parse_mode).toBeNull();
    expect(out.args[2].reply_markup.inline_keyboard[0][0].callback_data).toBe("askfu_1");
    expect(ctx.tg.of("sendChatAction").length).toBeGreaterThan(0);
  });

  it("ask_user suspends; replying (with or without swipe-reply) resumes the same conversation, and /cancel aborts an open question", async () => {
    const { ctx, replies } = await setup();
    replies.push(toolCall("ask_user", { question: "Which month?" }));
    await handleUpdate(ctx, msg("food spend"));
    const q = lastSent(ctx);
    expect(q.args[1]).toBe("Which month?");
    expect(q.args[2].reply_markup.force_reply).toBe(true);

    // Replying WITHOUT swipe-to-reply still resumes the open ask_user prompt!
    replies.push("Food in October: ₹900.");
    await handleUpdate(ctx, msg("October"));
    const resumed = ctx.llm.calls.at(-1);
    expect(resumed.at(-1)).toMatchObject({ role: "tool", content: "October" });
    expect(lastSent(ctx).args[1]).toBe("Food in October: ₹900.");

    // Once answered, a later plain message starts a fresh turn 1 (not a tool reply).
    replies.push("Fresh turn.");
    await handleUpdate(ctx, msg("October"));
    expect(ctx.llm.calls.at(-1).filter((m) => m.role === "tool")).toHaveLength(0);

    // /cancel clears an unanswered ask_user question cleanly.
    replies.push(toolCall("ask_user", { question: "Which category?" }));
    await handleUpdate(ctx, msg("tag that spend"));
    await handleUpdate(ctx, msg("/cancel"));
    expect(lastSent(ctx).args[1]).toBe("↩️ Cancelled.");
  });

  it("Follow up re-keys the conversation to a prompt; the reply continues as turn 2", async () => {
    const { ctx, replies } = await setup();
    replies.push("Answer one.");
    await handleUpdate(ctx, msg("top merchants"));
    const answerId = lastSent(ctx).result.message_id;
    await handleUpdate(ctx, tap("askfu_1", answerId));
    expect(ctx.tg.of("editMessageReplyMarkup").at(-1).args).toEqual(["111", answerId, { inline_keyboard: [] }]);
    const promptId = lastSent(ctx).result.message_id;
    expect(lastSent(ctx).args[1]).toContain("follow-up");

    replies.push("Answer two.");
    await handleUpdate(ctx, msg("and last month?", promptId));
    expect(ctx.llm.calls.at(-1).slice(-2)).toEqual([
      { role: "assistant", content: "Answer one." },
      { role: "user", content: "and last month?" }
    ]);
    expect(lastSent(ctx).args[2].reply_markup.inline_keyboard[0][0].callback_data).toBe("askfu_2");

    await handleUpdate(ctx, tap("askfu_1", answerId));
    expect(lastSent(ctx).args[1]).toContain("expired");
  });

  it("caps analytics at FREE_ASK_LIMIT/day, refunds failures, and keeps tagging/splits/exports quota-exempt", async () => {
    const { ctx, replies, id } = await setup();
    replies.push(new Error("azure down"));
    await handleUpdate(ctx, msg("how much today?"));
    expect(lastSent(ctx).args[1]).toContain("Something went wrong");
    for (let i = 0; i < FREE_ASK_LIMIT; i++) {
      replies.push("ok " + i);
      await handleUpdate(ctx, msg("how much day " + i + "?"));
    }
    await handleUpdate(ctx, msg("how much one more?"));
    expect(lastSent(ctx).args[1]).toContain("Daily analytics limit reached");
    expect(lastSent(ctx).args[2].reply_markup.inline_keyboard[0][0].callback_data).toBe("premium_info");

    // Even when analytics quota is exhausted, LedgerTagAgent and AccountOpsAgent still work!
    replies.push(toolCall("update_transaction", { transaction_id: id, category: "Groceries" }), "Tagged Groceries.");
    await handleUpdate(ctx, msg("make swiggy groceries"));
    expect(lastSent(ctx).args[1]).toBe("Tagged Groceries.");
    expect((await getTransaction(ctx.db, "111", id)).category).toBe("Groceries");

    ctx.advance(24 * 3600 * 1000);
    replies.push("new day");
    await handleUpdate(ctx, msg("how much again?"));
    expect(lastSent(ctx).args[1]).toBe("new day");
  });

  it("bare /ask still works as a legacy prompt; /cancel drops it", async () => {
    const { ctx, replies } = await setup();
    await handleUpdate(ctx, msg("/ask"));
    expect(lastSent(ctx).args[2].reply_markup.force_reply).toBe(true);
    replies.push("Here you go.");
    await handleUpdate(ctx, msg("food last month"));
    expect(ctx.llm.calls[0][1].content).toBe("food last month");

    await handleUpdate(ctx, msg("/ask"));
    await handleUpdate(ctx, msg("/cancel"));
    expect(lastSent(ctx).args[1]).toContain("Cancelled");
  });

  it("natural-language messages with ₹ amounts route to specialists instead of colliding with SMS paste", async () => {
    const { ctx, replies, id } = await setup({ groups: true });
    replies.push(toolCall("split_transaction", { transaction_id: id, mode: "50" }), "Split ₹900 50/50.");
    await handleUpdate(ctx, msg("split the ₹900 swiggy dinner 50/50"));
    expect(lastSent(ctx).args[1]).toBe("Split ₹900 50/50.");
    expect(await getSplitForTransaction(ctx.db, id)).not.toBeNull();
  });

  it("TriageAgent routes unfamiliar bank alerts to ledger's ingest_transaction_text tool", async () => {
    const { ctx, replies } = await setup();
    replies.push(
      toolCall("route_to_ledger"),
      toolCall("ingest_transaction_text", { text: "Revolut: EUR 14.50 charged at Paul Bakery on 2026-10-07" }),
      llmTxn({ merchant: "Paul Bakery", amount: 14.5, currency: "EUR", category: "Food & Dining" }),
      ""
    );
    await handleUpdate(ctx, msg("Revolut: EUR 14.50 charged at Paul Bakery on 2026-10-07"));
    const cards = ctx.tg.of("sendMessage").filter((c) => c.args[1].includes("Paul Bakery"));
    expect(cards).toHaveLength(1);
  });

  it("batch_update_transactions tags multiple untagged rows in one call", async () => {
    const { ctx, id } = await setup();
    const run = askToolExecutor(ctx, "111");
    const res = await run("batch_update_transactions", {
      items: [{ transaction_id: id, category: "Groceries", merchant: "Zepto" }]
    });
    expect(res).toMatchObject({ ok: true, updated: 1 });
    expect(await getTransaction(ctx.db, "111", id)).toMatchObject({ category: "Groceries", merchant: "Zepto" });
    expect(classifyFastAgent("how much this week?")).toBe("analytics");
    expect(classifyFastAgent("tag rahul as food")).toBe("ledger");
    expect(classifyFastAgent("split dinner 50/50")).toBe("groups");
    expect(classifyFastAgent("export my csv")).toBe("account");
  });

  it("update_transaction edits, learns the merchant and refreshes the card", async () => {
    const { ctx, replies, id } = await setup();
    const before = await getTransaction(ctx.db, "111", id);
    replies.push(
      toolCall("update_transaction", { transaction_id: id, category: "Groceries" }),
      toolCall("update_transaction", { transaction_id: id, category: "Salary" }),
      "Updated."
    );
    await handleUpdate(ctx, msg("/ask make swiggy groceries"));
    const after = await getTransaction(ctx.db, "111", id);
    expect(after).toMatchObject({ category: "Groceries", kind: "spend" });
    const results = toolResults(ctx.llm.calls.at(-1));
    expect(results[0]).toMatchObject({ ok: true, changes: [{ field: "category", to: "Groceries" }] });
    expect(results[1]).toMatchObject({ ok: false });
    expect((await getMerchantRules(ctx.db, "111")).find((r) => r.category === "Groceries")).toBeTruthy();
    const edit = ctx.tg.of("editMessageText").at(-1).args;
    expect(edit[1]).toBe(before.card_message_id);
  });

  it("split_transaction auto-picks the only group", async () => {
    const { ctx, replies, id } = await setup({ groups: true });
    replies.push(toolCall("split_transaction", { transaction_id: id, mode: "50" }), "Split.");
    await handleUpdate(ctx, msg("/ask split swiggy 50-50"));
    expect(toolResults(ctx.llm.calls.at(-1))[0]).toMatchObject({ ok: true, group_chat_id: "-100", shares: [450, 450] });
    expect(await getSplitForTransaction(ctx.db, id)).not.toBeNull();
    expect(ctx.tg.of("sendMessage").some((c) => c.args[0] === "-100")).toBe(true);
  });

  it("tools: search, groups, balances, settlements, undo, trends, untagged, dashboard", async () => {
    const { ctx, id } = await setup({ groups: true });
    const run = askToolExecutor(ctx, "111");
    const found = await run("search_transactions", { merchant: "swig", transaction_type: "Debit" });
    expect(found).toMatchObject({
      count: 1,
      transactions: [{ transaction_id: id, amount: 900, type: "Debit", date: "2026-10-07" }]
    });
    expect(found.transactions[0].split).toBeUndefined();
    expect((await run("search_transactions", { min_amount: 901 })).count).toBe(0);
    expect(await run("get_groups")).toMatchObject({
      count: 1,
      groups: [
        {
          chat_id: "-100",
          members: [{ chat_id: "111" }, { chat_id: "222", name: "U222" }]
        }
      ]
    });
    const cats = await run("get_category_breakdown", { start_date: "2026-10-01", end_date: "2026-10-31" });
    expect(cats.categories[0]).toMatchObject({ amount: 900, count: 1, counts_as_spend: true });

    // Split -> check balances -> settle cash -> undo split
    await run("split_transaction", { transaction_id: id, mode: "50" });
    const bal = await run("get_group_balances", {});
    expect(bal.groups[0].balances.INR).toEqual([
      { from_id: "222", from_name: "U222", to_id: "111", to_name: "U111", amount: 450 }
    ]);
    const cash = await run("record_cash_settlement", { to_member_id: "222", amount: 150 });
    expect(cash).toMatchObject({ ok: true, amount: 150, currency: "INR" });
    const undone = await run("undo_split", { transaction_id: id });
    expect(undone).toEqual({ ok: true, transaction_id: id });

    // Trends, untagged list, dashboard pin, account status
    const trends = await run("get_spending_trends", { granularity: "monthly" });
    expect(trends.buckets).toHaveLength(6);
    expect((await run("list_untagged_transactions", {})).count).toBe(0);
    expect(await run("show_dashboard", {})).toMatchObject({ ok: true });
    expect(await run("get_account_status", {})).toMatchObject({ ok: true, status: "active" });
    expect(await run("nope")).toEqual({ error: "Unknown tool: nope" });
  });

  it("cap message counts down to IST midnight", () => {
    expect(capHitMessage(NOW)).toContain("(in 10h 30m)");
    expect(capHitMessage(NOW + 10.5 * 3600 * 1000 - 1000)).toContain("(in 1m)");
  });
});
