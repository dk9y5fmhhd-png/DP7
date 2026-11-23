-- ============================================================
-- DP7 v3 — Retention CRM (spec: 7-day rule, VIP by count,
-- P1/P2/P3 priority, caller assignment, TeleCMI click-to-call)
-- Safe to run repeatedly.
-- ============================================================

-- ---------- deposit transactions: txn id + status ----------
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS txn_id TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'successful';
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deposits_status_chk'
  ) THEN
    ALTER TABLE deposits
      ADD CONSTRAINT deposits_status_chk
      CHECK (status IN ('successful', 'failed', 'pending', 'reversed'));
  END IF;
END $$;

-- ek transaction id sirf ek baar (null allowed, multiple)
CREATE UNIQUE INDEX IF NOT EXISTS deposits_txn_uniq
  ON deposits (LOWER(txn_id)) WHERE txn_id IS NOT NULL AND txn_id <> '';

CREATE INDEX IF NOT EXISTS deposits_status_idx ON deposits (status);

-- ---------- customer master ----------
CREATE TABLE IF NOT EXISTS customers (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL,
  mobile          TEXT NOT NULL DEFAULT '',
  reg_date        DATE,
  first_deposit   DATE,
  last_deposit    DATE,
  deposit_count   INTEGER NOT NULL DEFAULT 0,
  deposit_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'active', 'inactive', 'reactivated', 'no_deposit')),
  vip_category    TEXT NOT NULL DEFAULT 'normal'
                  CHECK (vip_category IN ('normal', 'vip', 'premium_vip', 'high_value_vip')),
  assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  do_not_contact  BOOLEAN NOT NULL DEFAULT FALSE,
  reactivated_at  DATE,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS customers_username_uniq ON customers (LOWER(username));
CREATE INDEX IF NOT EXISTS customers_status_idx ON customers (status);
CREATE INDEX IF NOT EXISTS customers_vip_idx ON customers (vip_category);
CREATE INDEX IF NOT EXISTS customers_caller_idx ON customers (assigned_to);
CREATE INDEX IF NOT EXISTS customers_mobile_idx ON customers (mobile);

-- ---------- call log (TeleCMI / manual) ----------
CREATE TABLE IF NOT EXISTS calls (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  caller_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL DEFAULT 'manual',
  provider_ref  TEXT,
  status        TEXT NOT NULL DEFAULT 'initiated',
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  recording_url TEXT,
  note          TEXT NOT NULL DEFAULT '',
  called_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw           JSONB
);

CREATE INDEX IF NOT EXISTS calls_customer_idx ON calls (customer_id, called_at DESC);
CREATE INDEX IF NOT EXISTS calls_caller_idx ON calls (caller_id, called_at DESC);

-- ---------- followups: remark → next action ----------
ALTER TABLE followups ADD COLUMN IF NOT EXISTS next_action TEXT NOT NULL DEFAULT '';
ALTER TABLE followups ADD COLUMN IF NOT EXISTS caller_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS followups_action_idx ON followups (action_type);

-- ---------- view: live customer scoreboard ----------
CREATE OR REPLACE VIEW customer_board AS
SELECT
  c.id, c.username, c.mobile, c.reg_date, c.first_deposit, c.last_deposit,
  c.deposit_count, c.deposit_amount, c.status, c.vip_category,
  c.assigned_to, c.do_not_contact, c.reactivated_at, c.created_at,
  u.name AS caller_name,
  COALESCE(CURRENT_DATE - c.last_deposit, 9999) AS days_inactive,
  CASE
    WHEN c.do_not_contact THEN 'P0'
    WHEN c.status <> 'inactive' AND c.status <> 'new' THEN 'P4'
    WHEN c.status = 'inactive' AND c.vip_category <> 'normal' THEN 'P1'
    WHEN c.status = 'inactive' AND (CURRENT_DATE - c.last_deposit) <= 14 THEN 'P1'
    WHEN c.status = 'new' THEN 'P2'
    WHEN c.status = 'inactive' THEN 'P2'
    ELSE 'P3'
  END AS priority
FROM customers c
LEFT JOIN users u ON u.id = c.assigned_to;

