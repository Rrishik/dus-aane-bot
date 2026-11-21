-- Simplify the 19 legacy categories into 9 Debit + 3 Credit single-word
-- categories across stored transactions and merchant rules.

UPDATE transactions
SET
  kind = CASE
    WHEN kind = 'card_payment' THEN 'transfer'
    ELSE kind
  END,
  category = CASE category
    WHEN 'Food & Dining' THEN 'Food'
    WHEN 'Bills & Utilities' THEN 'Bills'
    WHEN 'Subscriptions' THEN 'Bills'
    WHEN 'Healthcare' THEN 'Health'
    WHEN 'Entertainment' THEN 'Fun'
    WHEN 'Fuel' THEN 'Travel'
    WHEN 'Education' THEN 'Shopping'
    WHEN 'Investment' THEN 'Invest'
    WHEN 'CC Bill Payment' THEN 'Transfer'
    WHEN 'Transfer Out' THEN 'Transfer'
    WHEN 'Transfer In' THEN 'Transfer'
    WHEN 'Salary' THEN 'Income'
    WHEN 'Interest/Dividend' THEN 'Income'
    WHEN 'Cashback' THEN 'Refund'
    WHEN 'Reimbursement' THEN 'Refund'
    ELSE category
  END
WHERE kind = 'card_payment' OR category IN (
  'Food & Dining',
  'Bills & Utilities',
  'Subscriptions',
  'Healthcare',
  'Entertainment',
  'Fuel',
  'Education',
  'Investment',
  'CC Bill Payment',
  'Transfer Out',
  'Transfer In',
  'Salary',
  'Interest/Dividend',
  'Cashback',
  'Reimbursement'
);

UPDATE merchant_rules
SET
  kind = CASE
    WHEN kind = 'card_payment' THEN 'transfer'
    ELSE kind
  END,
  category = CASE category
    WHEN 'Food & Dining' THEN 'Food'
    WHEN 'Bills & Utilities' THEN 'Bills'
    WHEN 'Subscriptions' THEN 'Bills'
    WHEN 'Healthcare' THEN 'Health'
    WHEN 'Entertainment' THEN 'Fun'
    WHEN 'Fuel' THEN 'Travel'
    WHEN 'Education' THEN 'Shopping'
    WHEN 'Investment' THEN 'Invest'
    WHEN 'CC Bill Payment' THEN 'Transfer'
    WHEN 'Transfer Out' THEN 'Transfer'
    WHEN 'Transfer In' THEN 'Transfer'
    WHEN 'Salary' THEN 'Income'
    WHEN 'Interest/Dividend' THEN 'Income'
    WHEN 'Cashback' THEN 'Refund'
    WHEN 'Reimbursement' THEN 'Refund'
    ELSE category
  END
WHERE kind = 'card_payment' OR category IN (
  'Food & Dining',
  'Bills & Utilities',
  'Subscriptions',
  'Healthcare',
  'Entertainment',
  'Fuel',
  'Education',
  'Investment',
  'CC Bill Payment',
  'Transfer Out',
  'Transfer In',
  'Salary',
  'Interest/Dividend',
  'Cashback',
  'Reimbursement'
);
