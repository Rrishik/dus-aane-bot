// Default transaction kind from direction + category. Users and merchant
// rules can override it; analytics count only kind = 'spend' as spend.
const DEBIT_KINDS = {
  Transfer: "transfer",
  Invest: "investment"
};
const CREDIT_KINDS = {
  Refund: "refund",
  Transfer: "transfer"
};

export function defaultKind(direction, category) {
  if (direction === "credit") return CREDIT_KINDS[category] || "income";
  return DEBIT_KINDS[category] || "spend";
}
