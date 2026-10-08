// Default transaction kind from direction + category. Users and merchant
// rules can override it; analytics count only kind = 'spend' as spend.
const DEBIT_KINDS = {
  "CC Bill Payment": "card_payment",
  "Transfer Out": "transfer",
  Investment: "investment"
};
const CREDIT_KINDS = {
  Refund: "refund",
  Cashback: "refund",
  Reimbursement: "refund",
  "Transfer In": "transfer"
};

export const KINDS = ["spend", "income", "refund", "transfer", "card_payment", "investment", "cash"];

export function defaultKind(direction, category) {
  if (direction === "credit") return CREDIT_KINDS[category] || "income";
  return DEBIT_KINDS[category] || "spend";
}
