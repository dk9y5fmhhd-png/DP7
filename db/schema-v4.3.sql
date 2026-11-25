-- ============================================================
-- DP7 v4.3 — Retention Cadence Engine
--
-- Asli problem: follow-up date sirf remark se banti thi. Jis customer ko
-- koi call hi na kare, uski koi date hi nahi — aur "Not Interested" wala
-- 15 din tak bilkul chhup jata tha, chahe wo VIP ho.
--
-- Ab har customer ki apni CADENCE (regular touch cycle) hai:
--   A = VIP / high value        → har 5 din
--   B = normal / active         → har 12 din
--   C = purana dormant          → har 30 din
--   D = Do Not Contact          → koi touch nahi
--
-- next_touch_on = agla scheduled touch. Remark save hote hi reset hota hai.
-- Isse har customer regular cycle me aata rehta hai — pool me koi nahi padta.
--
-- Safe to run repeatedly.
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS cadence_tier TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS next_touch_on DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_touched_at DATE;

CREATE INDEX IF NOT EXISTS customers_next_touch_idx
  ON customers (next_touch_on) WHERE next_touch_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS customers_tier_idx ON customers (cadence_tier);

CREATE INDEX IF NOT EXISTS customers_touched_idx ON customers (last_touched_at);

-- customer_board me cadence bhi — warna har query me alag join karna padega
DROP VIEW IF EXISTS customer_board;

CREATE VIEW customer_board AS
SELECT
  c.id, c.username, c.mobile, c.reg_date, c.first_deposit, c.last_deposit,
  c.deposit_count, c.deposit_amount, c.status, c.vip_category,
  c.assigned_to, c.do_not_contact, c.reactivated_at, c.created_at,
  c.acquired_by, c.acquired_on,
  c.cadence_tier, c.next_touch_on, c.last_touched_at,
  u.name AS caller_name,
  u.team AS caller_team,
  COALESCE(CURRENT_DATE - c.last_deposit, 9999) AS days_inactive,
  COALESCE(CURRENT_DATE - c.last_touched_at, 9999) AS days_since_touch,
  (c.next_touch_on IS NULL OR c.next_touch_on <= CURRENT_DATE) AS touch_due,
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

