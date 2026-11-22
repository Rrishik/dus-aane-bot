-- Migration 0004: Card/account labels + historical canonical merchant cleanup.
--
-- 1. Adds `account_labels` so users can optionally name card/account last-4
--    digits (e.g. `5678` -> `Infinia`) for `CC Bill · Infinia` and card analytics.
-- 2. Cleans inconsistent historical `transactions.merchant` and `merchant_rules.name`
--    values (ALL-CAPS bank strings, corporate suffixes, gateway prefixes, SIP -> Mutual Funds).

CREATE TABLE IF NOT EXISTS account_labels (
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  last4 TEXT NOT NULL CHECK (length(last4) BETWEEN 3 AND 4),
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'card' CHECK (kind IN ('card', 'account')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, last4)
);

-- Map known VPA brand handles before clearing opaque QR VPA handles (`ox...@pty`) from display `merchant`.
UPDATE transactions
SET merchant = CASE
  WHEN LOWER(merchant) LIKE '%swiggy%@%' THEN 'Swiggy'
  WHEN LOWER(merchant) LIKE '%zomato%@%' THEN 'Zomato'
  WHEN LOWER(merchant) LIKE '%blinkit%@%' THEN 'Blinkit'
  WHEN LOWER(merchant) LIKE '%zepto%@%' THEN 'Zepto'
  WHEN LOWER(merchant) LIKE '%amazon%@%' THEN 'Amazon'
  ELSE NULL
END
WHERE merchant LIKE '%@%' AND LOWER(TRIM(merchant)) NOT LIKE 'booking.com%';

-- Canonicalize brand, legal-entity, clearing-house, and generic labels on historical transactions.
UPDATE transactions
SET merchant = CASE
  WHEN LOWER(TRIM(merchant)) IN ('sip', 'sips', 'mf', 'mutual fund', 'mutual funds')
    OR LOWER(merchant) LIKE '%indian clearing%'
    OR LOWER(merchant) LIKE '%bse star%'
    OR LOWER(merchant) LIKE '%nse clearing%'
    OR LOWER(TRIM(merchant)) = 'iccl' THEN 'Mutual Funds'
  WHEN LOWER(TRIM(merchant)) IN ('cc bill', 'card bill', 'cc bill payment', 'credit card bill', 'cred')
    OR LOWER(merchant) LIKE '%dreamplug%'
    OR LOWER(merchant) LIKE '%cred club%'
    OR LOWER(merchant) LIKE '%billdesk cc%' THEN 'CC Bill'
  WHEN LOWER(TRIM(merchant)) IN ('dividend', 'dividends') THEN 'Dividend'
  WHEN LOWER(TRIM(merchant)) = 'salary' THEN 'Salary'
  WHEN LOWER(TRIM(merchant)) = 'interest' THEN 'Interest'
  WHEN LOWER(TRIM(merchant)) = 'cashback' THEN 'Cashback'
  WHEN LOWER(TRIM(merchant)) = 'refund' THEN 'Refund'
  WHEN LOWER(TRIM(merchant)) IN ('reimburse', 'reimbursement') THEN 'Reimbursement'
  WHEN LOWER(TRIM(merchant)) = 'rent' THEN 'Rent'
  WHEN LOWER(TRIM(merchant)) = 'maintenance' THEN 'Maintenance'
  WHEN LOWER(TRIM(merchant)) IN ('maid', 'cook', 'househelp') THEN 'Househelp'
  WHEN LOWER(TRIM(merchant)) IN ('petrol', 'diesel', 'fuel') THEN 'Fuel'
  WHEN LOWER(merchant) LIKE '%swiggy instamart%' OR LOWER(TRIM(merchant)) = 'instamart' THEN 'Instamart'
  WHEN LOWER(merchant) LIKE '%bundl tech%' OR LOWER(TRIM(merchant)) = 'swiggy' THEN 'Swiggy'
  WHEN LOWER(merchant) LIKE '%eternal ltd%' OR LOWER(TRIM(merchant)) = 'zomato' THEN 'Zomato'
  WHEN LOWER(merchant) LIKE '%eazydiner%' THEN 'EazyDiner'
  WHEN LOWER(merchant) LIKE '%grofers%' OR LOWER(merchant) LIKE '%blinkit%' THEN 'Blinkit'
  WHEN LOWER(merchant) LIKE '%kirana kart%' OR LOWER(merchant) LIKE '%zepto%' THEN 'Zepto'
  WHEN LOWER(merchant) LIKE '%avenue supermarts%' OR LOWER(TRIM(merchant)) IN ('dmart', 'd-mart') THEN 'DMart'
  WHEN LOWER(merchant) LIKE '%innovative retail%' OR LOWER(merchant) LIKE '%supermarket grocery%' OR LOWER(merchant) LIKE '%bigbasket%' THEN 'BigBasket'
  WHEN LOWER(merchant) LIKE '%retail groceries%' THEN 'Groceries'
  WHEN LOWER(merchant) LIKE '%urbanclap%' OR LOWER(merchant) LIKE '%urban company%' THEN 'Urban Company'
  WHEN LOWER(merchant) LIKE '%mygate%' THEN 'MyGate'
  WHEN LOWER(merchant) LIKE '%nobroker%' THEN 'NoBroker'
  WHEN LOWER(merchant) LIKE '%amazon pay%' THEN 'Amazon Pay'
  WHEN LOWER(TRIM(merchant)) = 'amazon' THEN 'Amazon'
  WHEN LOWER(merchant) LIKE '%flipkart%' THEN 'Flipkart'
  WHEN LOWER(merchant) LIKE '%myntra%' THEN 'Myntra'
  WHEN LOWER(merchant) LIKE '%nykaa%' THEN 'Nykaa'
  WHEN LOWER(merchant) LIKE '%ajio%' THEN 'Ajio'
  WHEN LOWER(merchant) LIKE '%decathlon%' THEN 'Decathlon'
  WHEN LOWER(merchant) LIKE '%apollo pharm%' THEN 'Apollo Pharmacy'
  WHEN LOWER(merchant) LIKE '%medplus%' THEN 'MedPlus'
  WHEN LOWER(merchant) LIKE '%pharmeasy%' THEN 'PharmEasy'
  WHEN LOWER(merchant) LIKE '%cult.fit%' OR LOWER(merchant) LIKE '%cultfit%' OR LOWER(merchant) LIKE '%curefit%' THEN 'Cult.fit'
  WHEN LOWER(merchant) LIKE '%bookmyshow%' THEN 'BookMyShow'
  WHEN LOWER(merchant) LIKE '%zerodha%' THEN 'Zerodha'
  WHEN LOWER(merchant) LIKE '%groww%' THEN 'Groww'
  WHEN LOWER(merchant) LIKE '%kuvera%' THEN 'Kuvera'
  WHEN LOWER(merchant) LIKE '%upstox%' THEN 'Upstox'
  WHEN LOWER(merchant) LIKE '%two villas holiday%' THEN 'Two Villas Holiday'
  WHEN UPPER(TRIM(merchant)) = 'FIREFLY THB' THEN 'Firefly'
  ELSE merchant
END
WHERE merchant IS NOT NULL;

UPDATE merchant_rules
SET name = CASE
  WHEN LOWER(TRIM(name)) IN ('sip', 'sips', 'mf', 'mutual fund', 'mutual funds') THEN 'Mutual Funds'
  WHEN LOWER(TRIM(name)) IN ('cc bill', 'card bill', 'cc bill payment', 'credit card bill') THEN 'CC Bill'
  WHEN LOWER(TRIM(name)) IN ('dividend', 'dividends') THEN 'Dividend'
  WHEN LOWER(TRIM(name)) = 'blinkit' THEN 'Blinkit'
  WHEN LOWER(TRIM(name)) = 'zepto' THEN 'Zepto'
  WHEN LOWER(TRIM(name)) IN ('dmart', 'd-mart') THEN 'DMart'
  WHEN LOWER(TRIM(name)) = 'eazydiner' THEN 'EazyDiner'
  WHEN LOWER(TRIM(name)) = 'mygate' THEN 'MyGate'
  WHEN LOWER(name) LIKE '%urbanclap%' THEN 'Urban Company'
  ELSE name
END
WHERE name IS NOT NULL;
