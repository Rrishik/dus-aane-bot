import { describe, it, expect } from "vitest";
import { testContext, seedTenant, seedGroup, llmTxn } from "./helpers/app.js";
import { ingest } from "../src/app/ingest.js";
import { getSources, listTransactions } from "../src/db/transactions.js";
import { upsertMerchantRule } from "../src/db/merchantRules.js";
import { setSetting, disableTemplate } from "../src/db/settings.js";

const HDFC_SMS =
  "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161";
const HDFC_EMAIL =
  "Dear Customer, Rs.250.00 has been debited from account **1234 to VPA swiggy@ybl SWIGGY on 07-10-26. Your UPI transaction reference number is 628012345678.";

async function setup(opts) {
  const ctx = testContext(opts);
  const tenant = await seedTenant(ctx, "111");
  return { ctx, tenant };
}
const sms = (tenant, text = HDFC_SMS, ref = "sms-1") => ({ tenant, source: "sms", sourceRef: ref, text });
const email = (tenant, text = HDFC_EMAIL, ref = "gmail-1", extra = {}) => ({
  tenant,
  source: "email",
  sourceRef: ref,
  text,
  forwarder: "alice",
  ...extra
});
const events = async (ctx) =>
  (await ctx.db.prepare("SELECT event, template_id FROM parser_events ORDER BY rowid").all()).results;

describe("ingest — SMS", () => {
  it("saves a template read without the LLM, sends the card and stamps activity", async () => {
    const { ctx, tenant } = await setup();
    const res = await ingest(ctx, sms(tenant));
    expect(res.status).toBe("saved");
    expect(ctx.llm.calls).toHaveLength(0);

    const [t] = await listTransactions(ctx.db, "111");
    expect(t).toMatchObject({
      amount_minor: 25000,
      direction: "debit",
      kind: "spend",
      merchant: "Swiggy",
      category: "Food & Dining",
      account_last4: "1234",
      reference: "628012345678",
      status: "confirmed",
      card_message_id: 100
    });
    const [src] = await getSources(ctx.db, "111", t.id);
    expect(src).toMatchObject({ source: "sms", parsed_by: "hdfc_upi_sent_sms_v1", raw_text: HDFC_SMS });

    const card = ctx.tg.of("sendMessage")[0];
    expect(card.args[0]).toBe("111");
    expect(card.args[1]).toMatch(/^🔴 \*Swiggy\* — ₹250\n🗓 07 Oct 2026, 13:30$/);
    expect(card.args[2].reply_markup.inline_keyboard.at(-1).map((b) => b.text)).toEqual([
      "🏷 Swiggy ▾",
      "📂 Food ▾",
      "⋯"
    ]);
    expect(await events(ctx)).toEqual([{ event: "saved", template_id: "hdfc_upi_sent_sms_v1" }]);
    expect((await ctx.db.prepare("SELECT last_activity_at FROM tenants WHERE id='111'").first()).last_activity_at).toBe(
      ctx.now()
    );
  });

  it("the same source twice is a duplicate", async () => {
    const { ctx, tenant } = await setup();
    await ingest(ctx, sms(tenant));
    expect((await ingest(ctx, sms(tenant))).status).toBe("duplicate");
    expect(await listTransactions(ctx.db, "111")).toHaveLength(1);
  });

  it("OTPs are ignored without asking the LLM", async () => {
    const { ctx, tenant } = await setup();
    const res = await ingest(ctx, sms(tenant, "OTP for txn of Rs 999 at AMAZON is 123456. Do not share."));
    expect(res.status).toBe("ignored");
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it("low-confidence / undated reads become review cards with a note", async () => {
    const { ctx, tenant } = await setup();
    const res = await ingest(ctx, sms(tenant, "Rs. 92.50 was spent on your card"));
    expect(res.status).toBe("review");
    const [t] = await listTransactions(ctx.db, "111", { statuses: ["review"] });
    expect(t.review_note).toBe("no date in the SMS, used today's");
    const kb = ctx.tg.of("sendMessage")[0].args[2].reply_markup.inline_keyboard[0].map((b) => b.callback_data);
    expect(kb).toEqual(["rvok_" + t.id, "rr_" + t.id, "rvno_" + t.id]);
  });

  it("falls back to the LLM when the parser can't read it", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn({ merchant: "Chai Point", amount: 75 })] });
    const res = await ingest(ctx, sms(tenant, "INR 75 at the tea stall"));
    expect(res.status).toBe("saved");
    const [t] = await listTransactions(ctx.db, "111");
    expect((await getSources(ctx.db, "111", t.id))[0].parsed_by).toBe("llm");
  });

  it("a disabled template's messages go to the LLM instead", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn({ reference: "628012345678" })] });
    await disableTemplate(ctx.db, "hdfc_upi_sent_sms_v1");
    expect((await ingest(ctx, sms(tenant))).status).toBe("saved");
    expect(ctx.llm.calls).toHaveLength(1);
    const [t] = await listTransactions(ctx.db, "111");
    expect((await getSources(ctx.db, "111", t.id))[0].parsed_by).toBe("llm");
    expect(t.account_last4).toBeNull(); // a disabled template's read isn't trusted for anything
    expect(t.reference).toBe("628012345678"); // the LLM's own read
  });
});

describe("ingest — email", () => {
  it("shadow mode (default) saves the LLM read and logs agreement", async () => {
    const { ctx, tenant } = await setup({
      llmReplies: [llmTxn({ account_last4: "1234", reference: "628012345678" })]
    });
    const res = await ingest(ctx, email(tenant));
    expect(res.status).toBe("saved");
    const [t] = await listTransactions(ctx.db, "111");
    expect((await getSources(ctx.db, "111", t.id))[0]).toMatchObject({ parsed_by: "llm", raw_text: null });
    expect(t.forwarder).toBe("alice");
    expect(await events(ctx)).toEqual([{ event: "shadow_match", template_id: "generic_v1" }]);
  });

  it("on mode skips the LLM for confident parses", async () => {
    const { ctx, tenant } = await setup();
    await setSetting(ctx.db, "parser.mode", "on");
    expect((await ingest(ctx, email(tenant))).status).toBe("saved");
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it("takes account/reference from the parser when the LLM omits them", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn()] });
    await ingest(ctx, email(tenant));
    const [t] = await listTransactions(ctx.db, "111");
    expect(t).toMatchObject({ account_last4: "1234", reference: "628012345678" });
  });

  it("LLM failures return 'failed' and save nothing (the poller retries)", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [new Error("Azure 429")] });
    expect((await ingest(ctx, email(tenant))).status).toBe("failed");
    expect(await listTransactions(ctx.db, "111", { statuses: ["confirmed", "review"] })).toEqual([]);
  });

  it("not_a_transaction is ignored", async () => {
    const { ctx, tenant } = await setup({ llmReplies: ['{"not_a_transaction":true,"reason":"survey"}'] });
    expect((await ingest(ctx, email(tenant, "Rate your experience with us"))).status).toBe("ignored");
  });

  it("an amount missing from the text sends the row to review", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn({ amount: 2500 })] });
    expect((await ingest(ctx, email(tenant))).status).toBe("review");
  });

  it("silent (backfill) saves never use review status and send no card", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn({ amount: 2500 })] });
    expect((await ingest(ctx, email(tenant, HDFC_EMAIL, "g", { silent: true }))).status).toBe("saved");
    expect(ctx.tg.of("sendMessage")).toHaveLength(0);
  });
});

describe("ingest — linking the same payment across email and SMS", () => {
  it("an email after its SMS links to the same transaction (no second card)", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn({ reference: "628012345678" })] });
    await ingest(ctx, sms(tenant));
    const res = await ingest(ctx, email(tenant));
    expect(res.status).toBe("linked");
    const all = await listTransactions(ctx.db, "111");
    expect(all).toHaveLength(1);
    expect((await getSources(ctx.db, "111", all[0].id)).map((s) => s.source)).toEqual(["sms", "email"]);
    expect(ctx.tg.of("sendMessage")).toHaveLength(1);
  });

  it("two identical emails are two transactions", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn(), llmTxn()] });
    await ingest(ctx, email(tenant, HDFC_EMAIL, "g1"));
    await ingest(ctx, email(tenant, HDFC_EMAIL, "g2"));
    expect(await listTransactions(ctx.db, "111")).toHaveLength(2);
  });

  it("an amount-only match becomes a review card naming the existing transaction", async () => {
    const { ctx, tenant } = await setup({ llmReplies: [llmTxn({ amount: 250 })] });
    await ingest(ctx, email(tenant, "Your card was charged Rs 250.00 at SWIGGY on 07-10-26", "g1"));
    const res = await ingest(ctx, sms(tenant, "Rs 250 debited on 07-10-26 at SWIGGY"));
    expect(res.status).toBe("review");
    const [r] = await listTransactions(ctx.db, "111", { statuses: ["review"] });
    expect(r.review_note).toBe("looks like a duplicate of Swiggy ₹250 on 7 Oct");
  });

  it("never links across tenants", async () => {
    const { ctx, tenant } = await setup();
    const bob = await seedTenant(ctx, "222");
    await ingest(ctx, sms(tenant));
    expect((await ingest(ctx, sms(bob))).status).toBe("saved");
  });
});

describe("ingest — merchant rules and cards", () => {
  it("the user's own category and kind beat the LLM; shared rules fill gaps", async () => {
    const { ctx, tenant } = await setup({
      llmReplies: [llmTxn({ merchant: "BUNDL TECH", category: "Food & Dining" })]
    });
    await upsertMerchantRule(ctx.db, null, "bundl tech", { name: "Swiggy" });
    await upsertMerchantRule(ctx.db, "111", "swiggy", { category: "Groceries", kind: "spend" });
    await ingest(ctx, email(tenant));
    const [t] = await listTransactions(ctx.db, "111");
    expect(t).toMatchObject({ merchant_raw: "BUNDL TECH", merchant: "Swiggy", category: "Groceries" });
  });

  it("transfer categories get a non-spend kind", async () => {
    const { ctx, tenant } = await setup({
      llmReplies: [llmTxn({ merchant: "HDFC Credit Card", category: "CC Bill Payment", amount: 250 })]
    });
    await ingest(ctx, email(tenant));
    expect((await listTransactions(ctx.db, "111"))[0].kind).toBe("card_payment");
  });

  it("group members get a Split button per group on the card", async () => {
    const { ctx, tenant } = await setup();
    await seedTenant(ctx, "222");
    await seedGroup(ctx, "-100", ["111", "222"], "Flat");
    const res = await ingest(ctx, sms(tenant));
    const rows = ctx.tg.of("sendMessage")[0].args[2].reply_markup.inline_keyboard;
    expect(rows[0]).toEqual([{ text: "👥 Split with Flat ▾", callback_data: "gnav:" + res.transactionId + ":-100" }]);
  });
});
