-- ============================================================
-- DP7 v3.2 — summary file support
--
-- Problem: Power BI / summary export me ek customer ki ek hi row hoti hai
-- jisme lifetime total hota hai. Us se deposit COUNT nahi nikalta.
--
-- Solution: "deposit count" column optional. Row aggregate hai to us row me
-- kitni deposits samayi hain wo is column me aa jayega.
--   count khaali  → 1 (normal transaction-wise row)
--   count = 25    → VIP threshold me 25 ginega
--
-- Safe to run repeatedly.
-- ============================================================

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS txn_count INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'deposits' AND column_name = 'txn_count'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deposits_txn_count_chk'
  ) THEN
    ALTER TABLE deposits ADD CONSTRAINT deposits_txn_count_chk CHECK (txn_count >= 1);
  END IF;
END $$;

-- client_stats: sirf successful + txn_count ke saath
-- Column ka type badalna hai (bigint → int), isliye pehle drop karna padta hai.
DROP VIEW IF EXISTS client_stats;

CREATE VIEW client_stats AS
SELECT
  d.username,
  MIN(d.play_date)                              AS first_deposit,
  MAX(d.play_date)                              AS last_deposit,
  SUM(d.amount)                                 AS total_deposited,
  SUM(d.txn_count)::int                         AS deposit_count,
  COUNT(DISTINCT d.play_date)                   AS active_days,
  (ARRAY_AGG(d.mobile ORDER BY d.play_date DESC, d.id DESC))[1] AS mobile
FROM deposits d
WHERE d.status = 'successful'
GROUP BY d.username;


