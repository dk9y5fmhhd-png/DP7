-- ============================================================
-- DP7 v4.2 — even auto-split + caller load
--
-- Problem: "Poora filter assign karein" poora batch ek caller ko de deta hai.
-- 2,786 customers ko 8 callers me 600-600 baantna checkbox se namumkin tha.
--
-- Solution: split_runs + split helper — ek click me barabar baant, aur
-- har caller ko priority ka mix (VIP sab ek ke paas na chale jayein).
--
-- Safe to run repeatedly.
-- ============================================================

-- Team — kis caller ka kaam kya hai (retention = purane client, acquisition = naye)
ALTER TABLE users ADD COLUMN IF NOT EXISTS team TEXT NOT NULL DEFAULT 'retention';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_team_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_team_chk
      CHECK (team IN ('retention', 'acquisition', 'admin'));
  END IF;
END $$;

-- Kis customer ko kis caller ne laaya (acquisition team ke liye)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS acquired_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS acquired_on DATE;

CREATE INDEX IF NOT EXISTS customers_acquired_idx ON customers (acquired_by, acquired_on);

-- Har split ka record — "kisne kab kitne baante"
CREATE TABLE IF NOT EXISTS split_runs (
  id          BIGSERIAL PRIMARY KEY,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scope       TEXT NOT NULL DEFAULT 'unassigned',
  total       INTEGER NOT NULL DEFAULT 0,
  callers     INTEGER NOT NULL DEFAULT 0,
  per_caller  INTEGER NOT NULL DEFAULT 0,
  detail      JSONB
);

-- customer_board me team bhi, taaki caller load ek query me bane
DROP VIEW IF EXISTS customer_board;

CREATE VIEW customer_board AS
SELECT
  c.id, c.username, c.mobile, c.reg_date, c.first_deposit, c.last_deposit,
  c.deposit_count, c.deposit_amount, c.status, c.vip_category,
  c.assigned_to, c.do_not_contact, c.reactivated_at, c.created_at,
  c.acquired_by, c.acquired_on,
  u.name AS caller_name,
  u.team AS caller_team,
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

