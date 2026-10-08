import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { loadAppsScript } from "./_loader.js";

const COLS = {
  EMAIL_DATE_COLUMN: 1,
  TRANSACTION_DATE_COLUMN: 2,
  MERCHANT_COLUMN: 3,
  AMOUNT_COLUMN: 4,
  CATEGORY_COLUMN: 5,
  TRANSACTION_TYPE_COLUMN: 6,
  USER_COLUMN: 7,
  MESSAGE_ID_COLUMN: 8,
  CURRENCY_COLUMN: 9
};

const NOW = new Date("2026-10-07T18:00:00");
const HDFC_SMS =
  "Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161";

function existingRows(rows) {
  var data = [["h"]].concat(rows);
  return {
    getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => data.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc))
    })
  };
}

function setup(overrides) {
  var sent = [];
  var saves = [];
  var stubs = Object.assign(
    {
      ...COLS,
      PARSER_EVENT: { SAVED: "saved" },
      gateTenantForCommand: vi.fn(() => true),
      ensureSheetHeaders: vi.fn(),
      sendChatAction: vi.fn(),
      sendTelegramMessage: (chat, text) => sent.push(text),
      getMerchantResolutionsForTenant: () => [],
      findRowByColumnValue: vi.fn(() => -1),
      isParserTemplateDisabled: () => false,
      extractWithLLM: vi.fn(() => null),
      getCurrentTenant: () => ({ chat_id: "111", emails: ["alice@x.com"], name: "Alice" }),
      getSpreadsheet: () => ({ getSheets: () => [existingRows([])] }),
      saveExtractedTransaction: vi.fn((data, ctx) => {
        saves.push({ data: data, ctx: ctx });
        return { data: data, status: ctx.forceReview ? "review" : "" };
      }),
      logParserEvent: vi.fn(),
      stampLastForward: vi.fn(),
      reactivateIfDormant: vi.fn(),
      currencySymbol: () => "₹",
      formatAmount: (n) => String(n),
      Utilities: {
        DigestAlgorithm: { SHA_256: "sha256" },
        Charset: { UTF_8: "utf8" },
        computeDigest: (_alg, text) => Array.from(createHash("sha256").update(text).digest()),
        formatDate: (d) => d.toISOString().slice(0, 10)
      }
    },
    overrides || {}
  );
  var api = loadAppsScript(
    ["BankTemplates.js", "Parser.js", "SmsPaste.js"],
    ["handleSmsPaste", "smsContentHash", "findNearDuplicate"],
    stubs
  );
  return { api: api, stubs: stubs, sent: sent, saves: saves };
}

describe("handleSmsPaste", () => {
  it("ignores plain chat with no amount (returns false, stays silent)", () => {
    var t = setup();
    expect(t.api.handleSmsPaste("111", "hey, what's up?", NOW)).toBe(false);
    expect(t.stubs.gateTenantForCommand).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it("gates unregistered chats", () => {
    var t = setup({ gateTenantForCommand: vi.fn(() => false) });
    expect(t.api.handleSmsPaste("111", HDFC_SMS, NOW)).toBe(true);
    expect(t.saves).toEqual([]);
  });

  it("saves a confident template read with a content-hash id and the raw text", () => {
    var t = setup();
    t.api.handleSmsPaste("111", HDFC_SMS, NOW);
    expect(t.saves).toHaveLength(1);
    var ctx = t.saves[0].ctx;
    expect(ctx.messageId).toMatch(/^sms-[0-9a-f]{16}$/);
    expect(ctx.parsedBy).toBe("hdfc_upi_sent_sms_v1");
    expect(ctx.storeSourceText).toBe(true);
    expect(ctx.sourceText).toBe(HDFC_SMS);
    expect(ctx.forceReview).toBe(false);
    expect(ctx.userEmail).toBe("alice@x.com");
    expect(t.stubs.extractWithLLM).not.toHaveBeenCalled();
    expect(t.stubs.logParserEvent.mock.calls[0][0]).toMatchObject({ event: "saved", channel: "sms" });
    expect(t.stubs.stampLastForward).toHaveBeenCalledWith("111");
  });

  it("the same SMS pasted twice is reported as already recorded", () => {
    var t = setup({ findRowByColumnValue: vi.fn(() => 5) });
    t.api.handleSmsPaste("111", HDFC_SMS, NOW);
    expect(t.saves).toEqual([]);
    expect(t.sent).toEqual(["ℹ️ Already recorded."]);
  });

  it("hash ignores whitespace and case differences", () => {
    var t = setup();
    expect(t.api.smsContentHash("Rs 100  debited\nat X")).toBe(t.api.smsContentHash("rs 100 debited at x"));
  });

  it("a likely duplicate of an existing (email) row goes to review with a note", () => {
    var t = setup({
      getSpreadsheet: () => ({
        getSheets: () => [
          existingRows([[new Date(), "2026-10-07", "Swiggy", 250, "Food", "Debit", "a", "gmail-1", "INR"]])
        ]
      })
    });
    t.api.handleSmsPaste("111", HDFC_SMS, NOW);
    var ctx = t.saves[0].ctx;
    expect(ctx.forceReview).toBe(true);
    expect(ctx.reviewNote).toMatch(/^looks like a duplicate of Swiggy ₹250 on/);
  });

  it("low-confidence or undated reads go to review", () => {
    var t = setup();
    t.api.handleSmsPaste("111", "Rs. 92.50 was spent on your card", NOW);
    expect(t.saves[0].ctx.forceReview).toBe(true);
    expect(t.saves[0].ctx.reviewNote).toMatch(/no date/);
  });

  it("falls back to the LLM when the parser can't read it", () => {
    var t = setup({
      extractWithLLM: vi.fn(() => ({ amount: 75, transaction_type: "Debit", currency: "INR", merchant: "Chai" }))
    });
    t.api.handleSmsPaste("111", "INR 75 at the tea stall", NOW);
    expect(t.stubs.extractWithLLM).toHaveBeenCalledWith("INR 75 at the tea stall", [], "sms");
    expect(t.saves[0].ctx.parsedBy).toBe("llm");
    expect(t.stubs.logParserEvent).not.toHaveBeenCalled();
  });

  it("gives promo/declined-looking text a second opinion from the LLM", () => {
    var t = setup({
      extractWithLLM: vi.fn(() => ({ amount: 1200, transaction_type: "Debit", currency: "INR", merchant: "Myntra" }))
    });
    t.api.handleSmsPaste("111", "Transaction of Rs 1,200 at Myntra. Get 10% discount on your next purchase", NOW);
    expect(t.stubs.extractWithLLM).toHaveBeenCalledTimes(1);
    expect(t.saves).toHaveLength(1);
  });

  it("replies 'No transaction found' for an OTP (and never sends it to the LLM)", () => {
    var t = setup();
    t.api.handleSmsPaste("111", "OTP for txn of Rs 999 at AMAZON is 123456. Do not share.", NOW);
    expect(t.saves).toEqual([]);
    expect(t.stubs.extractWithLLM).not.toHaveBeenCalled();
    expect(t.sent).toEqual(["ℹ️ No transaction found in that."]);
  });

  it("handles several SMS in one paste", () => {
    var t = setup();
    t.api.handleSmsPaste(
      "111",
      HDFC_SMS + "\n\n" + HDFC_SMS.replace("250.00", "99.00").replace("SWIGGY", "ZEPTO"),
      NOW
    );
    expect(t.saves).toHaveLength(2);
    expect(t.saves[0].ctx.messageId).not.toBe(t.saves[1].ctx.messageId);
  });
});
