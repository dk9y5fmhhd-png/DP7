-- ============================================================
-- DP7 v4.5 — "ID bana, deposit nahi hua" customers ka follow-up
--
-- Problem: caller ID banwata hai (customer register hota hai) par pehla
-- deposit nahi karta. Abhi aisa customer ya to CRM me aata hi nahi, ya
-- aata hai to use P4 ("active — call ki zaroorat nahi") maan liya jata hai
-- aur cadence tier C (30 din) mil jata hai. Yaani sabse garam lead
-- sabse neeche chala jata hai.
--
-- Ab:
--   • status 'no_deposit' wale ka apna priority — PD (Pehla Deposit)
--   • cadence tier N — 2 din ka cycle
--   • 30 din me deposit nahi kiya to tier C (30 din) par chala jayega
--   • created_by — kis caller ne ID banwayi (usko hi assign hota hai)
--
-- Safe to run repeatedly.
-- ============================================================

-- Kis caller ne ye ID banwayi
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Ye customer kahan se aaya — deposit se, ID upload se, ya manual
ALTER TABLE customers ADD COLUMN IF NOT EXISTS reg_source TEXT NOT NULL DEFAULT 'deposit';

CREATE INDEX IF NOT EXISTS customers_created_by_idx ON customers (created_by);

CREATE INDEX IF NOT EXISTS customers_no_deposit_idx
  ON customers (reg_date DESC) WHERE status = 'no_deposit';

-- View dobara banao — naye column + naya priority PD
DROP VIEW IF EXISTS customer_board;

CREATE VIEW customer_board AS
SELECT
  c.id, c.username, c.mobile, c.reg_date, c.first_deposit, c.last_deposit,
  c.deposit_count, c.deposit_amount, c.status, c.vip_category,
  c.assigned_to, c.do_not_contact, c.reactivated_at, c.created_at,
  c.acquired_by, c.acquired_on,
  c.cadence_tier, c.next_touch_on, c.last_touched_at,
  c.created_by, c.reg_source,
  u.name AS caller_name,
  u.team AS caller_team,
  cr.name AS creator_name,
  COALESCE(CURRENT_DATE - c.last_deposit, 9999) AS days_inactive,
  COALESCE(CURRENT_DATE - c.last_touched_at, 9999) AS days_since_touch,
  COALESCE(CURRENT_DATE - COALESCE(c.reg_date, c.created_at::date), 9999) AS days_since_reg,
  (c.next_touch_on IS NULL OR c.next_touch_on <= CURRENT_DATE) AS touch_due,
  CASE
    WHEN c.do_not_contact THEN 'P0'
    -- ID bana par ek bhi deposit nahi — sabse pehle
    WHEN c.status = 'no_deposit' THEN 'PD'
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

