-- Migration 0005: Daily/historical FX rate cache (`fx_rates`) + INR-equivalent columns on `transactions`.

CREATE TABLE IF NOT EXISTS fx_rates (
  rate_date TEXT NOT NULL CHECK (rate_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  inr_rate REAL NOT NULL CHECK (inr_rate > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (rate_date, currency)
);
CREATE INDEX IF NOT EXISTS fx_by_currency_date ON fx_rates (currency, rate_date DESC);

ALTER TABLE transactions ADD COLUMN inr_minor INTEGER;
ALTER TABLE transactions ADD COLUMN fx_rate REAL;

UPDATE transactions
SET inr_minor = amount_minor, fx_rate = 1.0
WHERE currency = 'INR' AND inr_minor IS NULL;

CREATE INDEX IF NOT EXISTS tx_fx_pending ON transactions (currency, occurred_on)
WHERE currency <> 'INR' AND inr_minor IS NULL AND status <> 'deleted';
