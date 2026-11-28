-- ============================================================
-- DP7 v4.9 — "No deposit" pipeline (deposited / fake / intervals)
--
-- Caller ke 5 remark ka seedha asar:
--
--   1. Deposited       → customer no-deposit tab se hat kar Deposited tab me
--                        chala jata hai, CALLER WAHI rehta hai
--   2. Interested      → 5 din baad wapas My Calls me
--   3. Will Deposit    → 3 din baad wapas My Calls me
--   4. Fake            → customer permanently delete (remarks + calls bhi)
--   5. Not Interested  → 15 din baad wapas My Calls me
--
-- Saath me ek alag log — `remark_events` — kyunki Fake wale customer ke
-- delete hone par uske followups bhi chale jate hain, aur admin ko roz ka
-- hisaab chahiye (kitne deposited, kitne fake) chaahe customer rahe ya na rahe.
--
-- Safe to run repeatedly.
-- ============================================================

-- Caller ne "Deposited" bola — asli deposit Excel se aayega, tab tak ye nishan
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deposit_claimed_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deposit_claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS customers_claimed_idx
  ON customers (deposit_claimed_at) WHERE deposit_claimed_at IS NOT NULL;

-- Har remark ka permanent log — customer delete hone par bhi bacha rehta hai
CREATE TABLE IF NOT EXISTS remark_events (
  id          BIGSERIAL PRIMARY KEY,
  caller_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS remark_events_day_idx ON remark_events (action_date DESC, action_type);
CREATE INDEX IF NOT EXISTS remark_events_caller_idx ON remark_events (caller_id, action_date DESC);

-- Board view dobara — claimed customer no-deposit se nikal jaye
DROP VIEW IF EXISTS customer_board;

CREATE VIEW customer_board AS
SELECT
  c.id, c.username, c.mobile, c.reg_date, c.first_deposit, c.last_deposit,
  c.deposit_count, c.deposit_amount, c.status, c.vip_category,
  c.assigned_to, c.do_not_contact, c.reactivated_at, c.created_at,
  c.acquired_by, c.acquired_on,
  c.cadence_tier, c.next_touch_on, c.last_touched_at,
  c.created_by, c.reg_source,
  c.deposit_claimed_at, c.deposit_claimed_by,
  u.name AS caller_name,
  u.team AS caller_team,
  cr.name AS creator_name,
  COALESCE(CURRENT_DATE - c.last_deposit, 9999) AS days_inactive,
  COALESCE(CURRENT_DATE - c.last_touched_at, 9999) AS days_since_touch,
  COALESCE(CURRENT_DATE - COALESCE(c.reg_date, c.created_at::date), 9999) AS days_since_reg,
  (c.next_touch_on IS NULL OR c.next_touch_on <= CURRENT_DATE) AS touch_due,
  -- "No deposit" ka asli matlab: ID bana, deposit nahi, aur caller ne
  -- abhi-deposited bhi nahi kaha
  (c.status = 'no_deposit' AND c.deposit_claimed_at IS NULL) AS is_nodep,
  CASE
    WHEN c.do_not_contact THEN 'P0'
    WHEN c.status = 'no_deposit' AND c.deposit_claimed_at IS NULL THEN 'PD'
    WHEN c.status <> 'inactive' AND c.status <> 'new' THEN 'P4'
    WHEN c.status = 'inactive' AND c.vip_category <> 'normal' THEN 'P1'
    WHEN c.status = 'inactive' AND (CURRENT_DATE - c.last_deposit) <= 14 THEN 'P1'
    WHEN c.status = 'new' THEN 'P2'
    WHEN c.status = 'inactive' THEN 'P2'
    ELSE 'P3'
  END AS priority
FROM customers c
LEFT JOIN users u ON u.id = c.assigned_to
LEFT JOIN users cr ON cr.id = c.created_by;

