import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BANK_TEMPLATES,
  parseTransactionText,
  validateExtraction,
  splitSmsPaste,
  diffExtractions,
  PARSER_AUTO_SAVE_CONFIDENCE
} from "../src/parser/index.js";
import { buildParserModule, OUTPUT } from "../scripts/sync-parser.mjs";

describe("generated parser module", () => {
  it("is in sync with the Apps Script sources", () => {
    expect(readFileSync(OUTPUT, "utf8").replace(/\r\n/g, "\n")).toBe(buildParserModule());
  });

  it("runs as a strict ES module and reads every template sample", () => {
    for (const tpl of BANK_TEMPLATES) {
      for (const s of tpl.samples) {
        const out = parseTransactionText(s.text, {
          channel: tpl.channel === "both" ? "sms" : tpl.channel,
          receivedAt: new Date(s.receivedAt)
        });
        expect(out.templateId).toBe(tpl.id);
        expect(out).toMatchObject(s.expect);
        expect(out.confidence).toBeGreaterThanOrEqual(PARSER_AUTO_SAVE_CONFIDENCE);
      }
    }
  });

  it("exposes validation, splitting and diff helpers", () => {
    const v = validateExtraction(
      { amount: "450", transaction_type: "debit", currency: "inr", transaction_date: "2026-10-07" },
      "Rs 450 debited",
      new Date("2026-10-07T12:00:00")
    );
    expect(v.data).toMatchObject({ amount: 450, transaction_type: "Debit", currency: "INR" });
    expect(splitSmsPaste("Rs 1 debited at A\nRs 2 debited at B")).toHaveLength(2);
    expect(diffExtractions({ amount: 1 }, { amount: 2 })).toEqual(["amount"]);
  });
});
