// amount_minor = amount × 100 for every currency (fixed scale, see 0001_init.sql).
export function toMinor(amount) {
  const n = typeof amount === "string" ? parseFloat(amount.replace(/,/g, "")) : Number(amount);
  if (!Number.isFinite(n)) throw new Error("Not an amount: " + amount);
  return Math.round(n * 100);
}

export function fromMinor(minor) {
  return Number(minor) / 100;
}
