// LLM fallback extraction for messages the parser can't read confidently.
import { runToolLoop, parseJsonContent } from "../llm/azure.js";
import { CATEGORIES, CREDIT_CATEGORIES } from "./constants.js";
import { resolveMerchant } from "../db/merchantRules.js";

export const EXTRACTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_merchant_category",
      description:
        "Look up the default category for a merchant. Call this when you are unsure about the category for a merchant. Do NOT call for well-known merchants where the category is obvious (e.g., Amazon=Shopping, Swiggy=Food & Dining).",
      parameters: {
        type: "object",
        properties: { merchant: { type: "string", description: "The merchant name extracted from the message" } },
        required: ["merchant"]
      }
    }
  }
];

export function extractionSystemPrompt() {
  return (
    "You are a transaction extraction assistant. Extract structured transaction details from bank emails and SMS.\n\n" +
    "Return a JSON object with fields:\n" +
    "- transaction_date (YYYY-MM-DD)\n" +
    '- merchant (if identifiable; use empty string "" if generic bank alert with no merchant/payee)\n' +
    "- amount (numeric only, no currency symbols)\n" +
    "- currency (3-letter ISO code, default INR)\n" +
    "- category\n" +
    "- transaction_type (Debit or Credit)\n" +
    '- account_last4 (last 3-4 digits of the account or card, or "")\n' +
    '- reference (UPI ref / RRN / UTR / transaction reference number, or "")\n\n' +
    "Rules for transaction_type:\n" +
    '- Money spent (purchase, bill payment) = "Debit"\n' +
    '- Money received (refund, salary, cashback) = "Credit"\n\n' +
    "Rules for merchant:\n" +
    "- Extract the actual merchant/payee name, NOT the bank name\n" +
    '- Generic bank debit/credit alert with no merchant info = ""\n\n' +
    "Rules for category:\n" +
    "- Debit: must be one of: " +
    CATEGORIES.join(", ") +
    "\n- Credit: must be one of: " +
    CREDIT_CATEGORIES.join(", ") +
    "\n\nIf the message is NOT a transaction (surveys, OTPs, marketing, feedback, declined transactions, alerts with no monetary value), return:\n" +
    '{"not_a_transaction": true, "reason": "brief reason"}\n\n' +
    "Use the get_merchant_category tool ONLY when you are unsure about the category. " +
    "For well-known merchants (Amazon, Flipkart, Swiggy, Zomato, Uber, etc.) categorize directly."
  );
}

// Returns the model's JSON (a transaction or { not_a_transaction }) or null
// when the reply isn't JSON. LlmError propagates so callers can retry later.
export async function extractWithLlm(llm, text, channel, rules) {
  const out = await runToolLoop(llm, {
    messages: [
      { role: "system", content: extractionSystemPrompt() },
      {
        role: "user",
        content: "Extract transaction details from this " + (channel === "sms" ? "SMS" : "email") + ":\n\n" + text
      }
    ],
    tools: EXTRACTION_TOOLS,
    maxIterations: 2,
    maxTokens: 300,
    executeTool: async (name, args) => {
      if (name !== "get_merchant_category") return { error: "Unknown tool" };
      const r = resolveMerchant(args.merchant, rules);
      return r.category
        ? { merchant: r.merchant, category: r.category }
        : { merchant: args.merchant, category: null, message: "No mapping found, use your best guess" };
    }
  });
  return out.kind === "final" ? parseJsonContent(out.content) : null;
}
