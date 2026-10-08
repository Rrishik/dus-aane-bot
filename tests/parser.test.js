import { describe, it, expect } from "vitest";
import { loadAppsScript } from "./_loader.js";

const api = loadAppsScript(
  ["BankTemplates.js", "Parser.js"],
  [
    "BANK_TEMPLATES",
    "parseTransactionText",
    "normalizeTransactionText",
    "looksLikeTransactionText",
    "splitSmsPaste",
    "validateExtraction",
    "guessCategory",
    "diffExtractions",
    "toIsoDate",
    "PARSER_AUTO_SAVE_CONFIDENCE"
  ]
);

const RECEIVED = new Date("2026-10-07T13:00:00");
const parse = (text, channel) => api.parseTransactionText(text, { channel: channel || "sms", receivedAt: RECEIVED });

describe("BANK_TEMPLATES samples", () => {
  api.BANK_TEMPLATES.forEach((tpl) => {
    tpl.samples.forEach((sample, i) => {
      it(tpl.id + " sample " + (i + 1) + " parses to its expected read", () => {
        var out = api.parseTransactionText(sample.text, {
          channel: tpl.channel === "both" ? "sms" : tpl.channel,
          receivedAt: new Date(sample.receivedAt)
        });
        expect(out.templateId).toBe(tpl.id);
        expect(out).toMatchObject(sample.expect);
        expect(out.confidence).toBeGreaterThanOrEqual(api.PARSER_AUTO_SAVE_CONFIDENCE);
      });
    });
  });

  it("template ids are unique", () => {
    var ids = api.BANK_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseTransactionText — generic rules", () => {
  it("reads a forwarded HDFC-style email, ignoring the forward header and footer", () => {
    var email =
      "---------- Forwarded message ---------\nFrom: HDFC <alerts@hdfcbank.net>\nDate: x\nSubject: y\n\n" +
      "Dear Customer, Rs.250.00 has been debited from account **1234 to VPA swiggy@ybl SWIGGY on 07-10-26. " +
      "Your UPI transaction reference number is 628012345678. Please do not reply. Never share your OTP 123456.";
    expect(parse(email, "email")).toMatchObject({
      kind: "transaction",
      amount: 250,
      transaction_type: "Debit",
      transaction_date: "2026-10-07",
      merchant: "Swiggy",
      accountLast4: "1234",
      reference: "628012345678",
      templateId: "generic_v1"
    });
  });

  it("takes direction from the verb next to the amount when both sides are mentioned", () => {
    var out = parse("Acct XX123 debited for Rs 1,499.00 on 07-Oct-26; AMAZON PAY credited. UPI:628112345678.");
    expect(out.transaction_type).toBe("Debit");
    expect(out.amount).toBe(1499);
  });

  it("uses the transaction amount, not the available balance or limit", () => {
    expect(parse("Avl bal INR 8,000. A/C X3381 debited by INR 200.00 to VPA cafe@upi Ref 123456789012").amount).toBe(
      200
    );
    expect(
      parse("Your card was charged USD 12.99 at SPOTIFY on Oct 5, 2026. Avl Limit: INR 1,20,000.00")
    ).toMatchObject({
      amount: 12.99,
      currency: "USD",
      transaction_date: "2026-10-05"
    });
  });

  it("reads refunds as credits", () => {
    expect(
      parse("Refund of Rs 499.00 from MYNTRA has been credited to your card ending 5678 on 06-10-26")
    ).toMatchObject({
      transaction_type: "Credit",
      amount: 499,
      merchant: "Myntra"
    });
  });

  it("reads amounts with no currency when anchored by 'debited by'", () => {
    expect(parse("A/C X4567 debited by 120.0 on 07Oct26 trf to UBER INDIA Refno 628312345678")).toMatchObject({
      amount: 120,
      currency: "INR",
      merchant: "Uber India"
    });
  });

  it("gives vague messages a low confidence and no date", () => {
    var out = parse("Rs. 92.50 was spent on your card");
    expect(out.amount).toBe(92.5);
    expect(out.hasDate).toBe(false);
    expect(out.confidence).toBeLessThan(api.PARSER_AUTO_SAVE_CONFIDENCE);
  });

  it("ignores dates outside the -90d..+1d window", () => {
    expect(parse("Rs 100 debited at SHOP on 01-01-20").transaction_date).toBe("");
  });

  it.each([
    ["OTP for txn of Rs 999 at AMAZON is 123456. Valid for 10 min. Do not share.", "otp"],
    ["Your txn of Rs 500 at AMAZON has been declined due to insufficient balance", "declined"],
    ["Your credit card payment of Rs 12,000 is due on 15-10-26", "reminder"],
    ["Get Rs 500 cashback offer on your next purchase. Shop now!", "promo"]
  ])("ignores non-transactions: %s", (text, reason) => {
    expect(parse(text)).toEqual({ kind: "ignored", reason: reason });
  });

  it("anti-fraud OTP / promo footers don't hide a real transaction", () => {
    var tplSms =
      "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Never share OTP/PIN. Call 1930";
    expect(parse(tplSms).templateId).toBe("hdfc_upi_sent_sms_v1");
    expect(parse("Rs 500 debited from A/c XX12 at ZEPTO on 07-10-26. Do not share OTP. Call 1800 2662").kind).toBe(
      "transaction"
    );
    expect(parse("INR 300 spent at CAFE on 07-10-26. Get 10% discount offer on your next purchase").kind).toBe(
      "transaction"
    );
  });

  it("returns null when there's no amount or direction", () => {
    expect(parse("Hello there")).toBeNull();
    expect(parse("Your account statement for Rs 0 is ready")).toBeNull();
  });
});

describe("helpers", () => {
  it("looksLikeTransactionText needs an amount", () => {
    expect(api.looksLikeTransactionText("Rs 100 debited")).toBe(true);
    expect(api.looksLikeTransactionText("debited by 120.0 on date")).toBe(true);
    expect(api.looksLikeTransactionText("hey, how are you?")).toBe(false);
  });

  it("splitSmsPaste splits on blank lines, and per line when every line has an amount", () => {
    expect(api.splitSmsPaste("Rs 100 debited at A\nRs 200 debited at B\n\nINR 5 spent on X")).toEqual([
      "Rs 100 debited at A",
      "Rs 200 debited at B",
      "INR 5 spent on X"
    ]);
    expect(api.splitSmsPaste("Rs 100 debited at A\nNot you? Call us")).toEqual([
      "Rs 100 debited at A\nNot you? Call us"
    ]);
  });

  it("validateExtraction normalises fields and flags what needs review", () => {
    var v = api.validateExtraction(
      { amount: "2,480", transaction_type: "debit", currency: "inr", transaction_date: "N/A" },
      "debited by INR 2,480.00",
      RECEIVED
    );
    expect(v.data).toMatchObject({
      amount: 2480,
      transaction_type: "Debit",
      currency: "INR",
      transaction_date: "2026-10-07"
    });
    expect(v.issues).toEqual(["date_fallback"]);
    expect(v.needsReview).toBe(false);

    var bad = api.validateExtraction({ amount: 999, transaction_type: "?" }, "Rs 100 debited", RECEIVED);
    expect(bad.issues).toEqual(expect.arrayContaining(["amount_not_in_text", "type_unknown"]));
    expect(bad.needsReview).toBe(true);
    expect(api.validateExtraction({ amount: 0, transaction_type: "Debit" }, "", RECEIVED).needsReview).toBe(true);

    var big = api.validateExtraction({ amount: 12500000, currency: "VND", transaction_type: "Debit" }, "", RECEIVED);
    expect(big.data.amount).toBe(12500000);
    expect(big.issues).toContain("amount_large");
    expect(big.needsReview).toBe(true);
  });

  it("guessCategory matches merchant keywords per direction", () => {
    expect(api.guessCategory("Swiggy", "Debit")).toBe("Food & Dining");
    expect(api.guessCategory("Netflix.com", "Debit")).toBe("Subscriptions");
    expect(api.guessCategory("Acme Salary", "Credit")).toBe("Salary");
    expect(api.guessCategory("Random Shop", "Debit")).toBe("");
  });

  it("diffExtractions compares the core fields only", () => {
    var a = { amount: 450, currency: "INR", transaction_type: "Debit", transaction_date: "2026-10-07", merchant: "A" };
    expect(api.diffExtractions(a, Object.assign({}, a, { merchant: "B" }))).toEqual([]);
    expect(api.diffExtractions(a, Object.assign({}, a, { amount: 4500, transaction_type: "credit" }))).toEqual([
      "amount",
      "transaction_type"
    ]);
  });

  it("toIsoDate accepts Date cells and ISO strings", () => {
    expect(api.toIsoDate(new Date(2026, 9, 7))).toBe("2026-10-07");
    expect(api.toIsoDate("2026-10-07T00:00:00Z")).toBe("2026-10-07");
    expect(api.toIsoDate("N/A")).toBe("");
  });

  it("normalizeTransactionText decodes entities and collapses whitespace", () => {
    expect(api.normalizeTransactionText("Rs&nbsp;100\n\n debited &amp; done")).toBe("Rs 100 debited & done");
  });
});
