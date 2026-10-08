-- Initial D1 schema for Dus Aane Bot.
--
-- Conventions:
--   * ids are text: Telegram chat ids for tenants, ULIDs for everything else.
--   * amount_minor is amount × 100 for every currency (fixed scale, not ISO
--     minor units), stored as an integer.
--   * dates are ISO "YYYY-MM-DD" text; instants are epoch milliseconds.
--   * every tenant-owned row carries tenant_id; the Worker data layer always
--     filters on it (D1 has no row-level security).

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'group')),
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'dormant', 'disabled')),
  primary_currency TEXT NOT NULL DEFAULT 'INR',
  admin_id TEXT,
  pin_message_id TEXT,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER,
  last_nag_at INTEGER,
  nag_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tenant_emails (
  email TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE
);
CREATE INDEX tenant_emails_by_tenant ON tenant_emails (tenant_id);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX group_members_by_member ON group_members (member_id);

-- Invites for people who joined a group chat before registering.
CREATE TABLE group_invites (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  occurred_on TEXT NOT NULL CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  kind TEXT NOT NULL CHECK (kind IN ('spend', 'income', 'refund', 'transfer', 'card_payment', 'investment', 'cash')),
  merchant_raw TEXT,
  merchant TEXT,
  category TEXT,
  account_last4 TEXT,
  reference TEXT,
  forwarder TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'review', 'deleted')),
  review_note TEXT,
  card_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tx_by_date ON transactions (tenant_id, occurred_on);
CREATE INDEX tx_by_match ON transactions (tenant_id, amount_minor, currency, occurred_on);
CREATE INDEX tx_by_ref ON transactions (tenant_id, reference) WHERE reference IS NOT NULL;

-- Every way a transaction reached us. An email and an SMS for the same
-- payment are two sources of one transaction.
CREATE TABLE transaction_sources (
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('email', 'sms', 'manual', 'import')),
  source_ref TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  parsed_by TEXT,
  confidence REAL,
  reread INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, source, source_ref)
);
CREATE INDEX sources_by_txn ON transaction_sources (transaction_id);

CREATE TABLE splits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payer_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  group_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX splits_by_group ON splits (group_id);

CREATE TABLE split_shares (
  split_id TEXT NOT NULL REFERENCES splits (id) ON DELETE CASCADE,
  holder_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (split_id, holder_id)
);

-- A settlement may come from a personal transaction ("I paid them back") or
-- be recorded by hand (/settle), in which case transaction_id is NULL.
CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  transaction_id TEXT UNIQUE REFERENCES transactions (id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  group_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX settlements_by_group ON settlements (group_id);

-- Merchant name/category/kind rules. tenant_id '' = shared default curated
-- by the admin; a tenant's own rows win over shared ones.
CREATE TABLE merchant_rules (
  tenant_id TEXT NOT NULL DEFAULT '',
  pattern TEXT NOT NULL,
  name TEXT,
  category TEXT,
  kind TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, pattern)
);

CREATE TABLE ask_usage (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  used_on TEXT NOT NULL,
  used_today INTEGER NOT NULL DEFAULT 0,
  lifetime INTEGER NOT NULL DEFAULT 0,
  cap_hits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE backfill_jobs (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0,
  dupes INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  chunk INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Parser telemetry: field names only, never amounts, merchants or text.
CREATE TABLE parser_events (
  ts INTEGER NOT NULL,
  tenant_id TEXT,
  channel TEXT,
  template_id TEXT,
  event TEXT NOT NULL,
  fields_changed TEXT,
  source_ref TEXT
);
CREATE INDEX parser_events_by_ts ON parser_events (ts);
CREATE INDEX parser_events_by_template ON parser_events (template_id, event, ts);

-- Small runtime settings (parser.mode, parser.disabledTemplates, ...).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Short-lived state: pending replies, Re-read results, /ask conversations.
CREATE TABLE ephemeral (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ephemeral_by_expiry ON ephemeral (expires_at);
