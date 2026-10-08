import { describe, it, expect } from "vitest";
import { testContext, seedTenant, seedGroup, llmTxn } from "./helpers/app.js";
import { handleUpdate } from "../src/app/webhook.js";
import { ingest } from "../src/app/ingest.js";
import { getTransaction, getSources } from "../src/db/transactions.js";
import { getMerchantRules } from "../src/db/merchantRules.js";
import { createSplit } from "../src/db/splits.js";
import { getDisabledTemplates, logParserEvent } from "../src/db/settings.js";
import { shortenMerchantPattern } from "../src/app/cardActions.js";

const HDFC_SMS =
  "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161";

const tap = (data, messageId = 100) => ({
  callback_query: {
    id: "cb",
    data,
    from: { id: 111, first_name: "Alice" },
    message: { chat: { id: 111 }, message_id: messageId }
  }
});
const reply = (text) => ({
  message: { chat: { id: 111, type: "private" }, from: { id: 111, first_name: "Alice" }, text }
});

async function withCard(opts = {}) {
  const ctx = testContext(opts);
  const tenant = await seedTenant(ctx, "111");
  const res = await ingest(ctx, { tenant, source: "sms", sourceRef: "sms-1", text: opts.text || HDFC_SMS });
  return { ctx, id: res.transactionId };
}
const lastMarkup = (ctx) => ctx.tg.of("editMessageReplyMarkup").at(-1).args[2];
const lastEdit = (ctx) => ctx.tg.of("editMessageText").at(-1).args;
const sent = (ctx) => ctx.tg.of("sendMessage").map((c) => c.args[1]);

describe("category picker", () => {
  it("opens in place and a pick updates category + kind and teaches the user's rules", async () => {
    const { ctx, id } = await withCard();
    await handleUpdate(ctx, tap("editcat_" + id));
    const picker = lastMarkup(ctx).inline_keyboard;
    expect(picker[0].map((b) => b.callback_data)).toEqual(["cat_" + id + "_0", "cat_" + id + "_1", "cat_" + id + "_2"]);
    expect(picker.at(-1)[0].callback_data).toBe("back_" + id);

    await handleUpdate(ctx, tap("cat_" + id + "_12")); // Transfer Out
    expect(await getTransaction(ctx.db, "111", id)).toMatchObject({ category: "Transfer Out", kind: "transfer" });
    expect(lastMarkup(ctx).inline_keyboard.at(-1)[1].text).toBe("📂 Transfer ▾");
    expect(await getMerchantRules(ctx.db, "111")).toEqual([
      { pattern: "swiggy", name: null, category: "Transfer Out", kind: null, personal: true }
    ]);
  });

  it("rejects an out-of-range index", async () => {
    const { ctx, id } = await withCard();
    await handleUpdate(ctx, tap("cat_" + id + "_99"));
    expect(sent(ctx).at(-1)).toBe("❌ *Invalid category*");
  });
});

describe("🏷 tag", () => {
  it("prompts, then a reply renames the card and teaches both the exact and numbered patterns", async () => {
    const { ctx, id } = await withCard({
      llmReplies: [llmTxn({ merchant: "BUNDL TECH 12345", reference: "1" })],
      text: "Payment of 250 done"
    });
    await handleUpdate(ctx, tap("tag_" + id));
    expect(ctx.tg.of("sendMessage").at(-1).args[2].reply_markup.force_reply).toBe(true);

    await handleUpdate(ctx, reply("Swiggy"));
    expect((await getTransaction(ctx.db, "111", id)).merchant).toBe("Swiggy");
    expect(lastEdit(ctx)[2]).toMatch(/^🔴 \*Swiggy\* — ₹250/);
    const patterns = (await getMerchantRules(ctx.db, "111")).map((r) => [r.pattern, r.name]);
    expect(patterns).toEqual(
      expect.arrayContaining([
        ["bundl tech 12345", "Swiggy"],
        ["bundl tech", "Swiggy"]
      ])
    );
  });

  it("too-long tags keep the prompt open; /cancel closes it; a later message isn't swallowed", async () => {
    const { ctx, id } = await withCard();
    await handleUpdate(ctx, tap("tag_" + id));
    await handleUpdate(ctx, reply("x".repeat(19)));
    expect(sent(ctx).at(-1)).toMatch(/Tag must be 1–18 characters/);
    await handleUpdate(ctx, reply("/cancel"));
    expect(sent(ctx).at(-1)).toBe("↩️ *Tag unchanged.*");
    await handleUpdate(ctx, reply("hello there"));
    expect((await getTransaction(ctx.db, "111", id)).merchant).toBe("Swiggy");
  });

  it("the pending tag expires after 10 minutes", async () => {
    const { ctx, id } = await withCard();
    await handleUpdate(ctx, tap("tag_" + id));
    ctx.advance(11 * 60 * 1000);
    await handleUpdate(ctx, reply("Zomato"));
    expect((await getTransaction(ctx.db, "111", id)).merchant).toBe("Swiggy");
  });

  it("shortenMerchantPattern strips trailing transaction ids", () => {
    expect(shortenMerchantPattern("bundl tech 12345")).toBe("bundl tech");
    expect(shortenMerchantPattern("AMAZON #123-456")).toBe("AMAZON");
    expect(shortenMerchantPattern("7Eleven")).toBe("7Eleven");
  });
});

describe("⋯ menu, back and delete", () => {
  it("offers Re-read for parser rows and Report once re-read", async () => {
    const { ctx, id } = await withCard();
    await handleUpdate(ctx, tap("help_" + id));
    expect(lastMarkup(ctx).inline_keyboard[0].map((b) => b.callback_data)).toEqual(["rr_" + id, "del_" + id]);
    await handleUpdate(ctx, tap("rrk_" + id));
    await handleUpdate(ctx, tap("help_" + id));
    expect(lastMarkup(ctx).inline_keyboard[0].map((b) => b.callback_data)).toEqual(["report_" + id, "del_" + id]);
  });

  it("split transactions hide and refuse delete", async () => {
    const { ctx, id } = await withCard();
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"]);
    await createSplit(ctx.db, {
      transactionId: id,
      groupId: "-100",
      payerId: "111",
      mode: "50",
      shares: [{ holderId: "222", amountMinor: 12500 }]
    });
    await handleUpdate(ctx, tap("help_" + id));
    expect(lastMarkup(ctx).inline_keyboard[0].map((b) => b.callback_data)).toEqual(["report_" + id]);
    await handleUpdate(ctx, tap("delyes_" + id));
    expect(sent(ctx).at(-1)).toMatch(/Make it personal again first/);
    expect((await getTransaction(ctx.db, "111", id)).status).toBe("confirmed");
    await handleUpdate(ctx, tap("back_" + id));
    expect(lastMarkup(ctx).inline_keyboard[0][0].callback_data).toBe("gun:" + id);
  });

  it("delete asks to confirm, then soft-deletes and tombstones the card", async () => {
    const { ctx, id } = await withCard();
    await handleUpdate(ctx, tap("del_" + id));
    expect(lastMarkup(ctx).inline_keyboard[0].map((b) => b.callback_data)).toEqual(["delyes_" + id, "back_" + id]);
    await handleUpdate(ctx, tap("delyes_" + id));
    expect((await getTransaction(ctx.db, "111", id)).status).toBe("deleted");
    expect(lastEdit(ctx)[2]).toBe("🗑️ *Transaction deleted*");
    await handleUpdate(ctx, tap("help_" + id));
    expect(sent(ctx).at(-1)).toBe("❌ *Transaction not found.*");
  });

  it("other tenants' transactions are not found", async () => {
    const { ctx, id } = await withCard();
    await seedTenant(ctx, "222");
    await handleUpdate(ctx, {
      callback_query: {
        id: "cb",
        data: "delyes_" + id,
        from: { id: 222 },
        message: { chat: { id: 222 }, message_id: 1 }
      }
    });
    expect((await getTransaction(ctx.db, "111", id)).status).toBe("confirmed");
  });

  it("report DMs the admin with source details and logs the event", async () => {
    const { ctx, id } = await withCard();
    await handleUpdate(ctx, tap("report_" + id));
    const adminDm = ctx.tg.of("sendMessage").find((c) => c.args[0] === "999");
    expect(adminDm.args[1]).toMatch(
      /Reported txn[\s\S]*amount: INR 250[\s\S]*parsed by: hdfc\\_upi\\_sent\\_sms\\_v1[\s\S]*source: sms sms-1/
    );
    expect(lastMarkup(ctx).inline_keyboard[0][0].text).toBe("📩 Reported — thanks!");
    const evt = await ctx.db.prepare("SELECT event, template_id FROM parser_events WHERE event = 'report'").first();
    expect(evt).toEqual({ event: "report", template_id: "hdfc_upi_sent_sms_v1" });
  });
});

describe("Re-read", () => {
  it("shows only the changed fields; Use this applies them and marks the source llm", async () => {
    const { ctx, id } = await withCard({ llmReplies: [llmTxn({ amount: 2500 })] });
    // LLM reads ₹2500 but the text says 250 — validation keeps it, the user decides.
    await handleUpdate(ctx, tap("rr_" + id));
    expect(lastEdit(ctx)[2]).toMatch(/\n🔄 Re-read: ₹2500$/);
    expect(lastEdit(ctx)[3].reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      "rra_" + id,
      "rrk_" + id
    ]);
    await handleUpdate(ctx, tap("rra_" + id));
    expect(await getTransaction(ctx.db, "111", id)).toMatchObject({ amount_minor: 250000, status: "confirmed" });
    expect((await getSources(ctx.db, "111", id))[0]).toMatchObject({ parsed_by: "llm", reread: 1 });
    const events = (await ctx.db.prepare("SELECT event, fields_changed FROM parser_events ORDER BY rowid").all())
      .results;
    expect(events.slice(1)).toEqual([
      { event: "reparse_requested", fields_changed: null },
      { event: "reparse_accepted", fields_changed: "amount" }
    ]);
    // An expired / consumed re-read can't be applied twice.
    await handleUpdate(ctx, tap("rra_" + id));
    expect(sent(ctx).at(-1)).toMatch(/re-read expired/);
  });

  it("same result marks it re-read and offers Report", async () => {
    const { ctx, id } = await withCard({ llmReplies: [llmTxn()] });
    await handleUpdate(ctx, tap("rr_" + id));
    expect(lastEdit(ctx)[2]).toMatch(/_Re-read: same result_$/);
    expect((await getSources(ctx.db, "111", id))[0].reread).toBe(1);
    await handleUpdate(ctx, tap("rr_" + id));
    expect(sent(ctx).at(-1)).toMatch(/Already re-read/);
  });

  it("re-reads emails via Apps Script's get_email_body", async () => {
    const ctx = testContext({
      llmReplies: [llmTxn({ amount: 250 })],
      appsScript: (action, p) => ({
        ok: true,
        text: action === "get_email_body" && p.messageId === "g1" ? "Rs 250 debited" : ""
      })
    });
    const tenant = await seedTenant(ctx, "111");
    const { setSetting } = await import("../src/db/settings.js");
    await setSetting(ctx.db, "parser.mode", "on");
    const res = await ingest(ctx, {
      tenant,
      source: "email",
      sourceRef: "g1",
      text: "Rs.250.00 has been debited from account **1234 to VPA swiggy@ybl SWIGGY on 07-10-26."
    });
    await handleUpdate(ctx, tap("rr_" + res.transactionId));
    expect(ctx.asCalls.map((c) => c.action)).toEqual(["get_email_body"]);
    expect(lastEdit(ctx)[2]).toMatch(/same result/);
  });

  it("three accepted re-reads in a week auto-disable the template and tell the admin", async () => {
    const { ctx, id } = await withCard({ llmReplies: [llmTxn({ amount: 2500 })] });
    for (let i = 0; i < 2; i++) {
      await logParserEvent(ctx.db, { templateId: "hdfc_upi_sent_sms_v1", event: "reparse_accepted" }, ctx.now());
    }
    await handleUpdate(ctx, tap("rr_" + id));
    await handleUpdate(ctx, tap("rra_" + id));
    expect(await getDisabledTemplates(ctx.db)).toEqual(["hdfc_upi_sent_sms_v1"]);
    expect(ctx.tg.of("sendMessage").find((c) => c.args[0] === "999").args[1]).toMatch(/auto-disabled/);
  });
});

describe("review cards", () => {
  it("Save confirms the row; Discard removes it", async () => {
    const { ctx, id } = await withCard({ text: "Rs. 92.50 was spent on your card" });
    expect((await getTransaction(ctx.db, "111", id)).status).toBe("review");
    await handleUpdate(ctx, tap("rvok_" + id));
    expect((await getTransaction(ctx.db, "111", id)).status).toBe("confirmed");
    expect(lastEdit(ctx)[2]).not.toMatch(/Check this/);

    const tenant = await ctx.db.prepare("SELECT * FROM tenants WHERE id='111'").first();
    const r2 = await ingest(ctx, { tenant, source: "sms", sourceRef: "sms-2", text: "Rs. 10 was spent on your card" });
    await handleUpdate(ctx, tap("rvno_" + r2.transactionId));
    expect((await getTransaction(ctx.db, "111", r2.transactionId)).status).toBe("deleted");
    expect(lastEdit(ctx)[2]).toBe("✖ *Discarded*");
  });
});
