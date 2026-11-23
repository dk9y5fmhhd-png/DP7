-- ============================================================
-- DP7 v3.4 — upload batch protection
--
-- Problem: transaction-wise file me kai rows ka amount same ho sakta hai
-- (jaise 25,000 char baar). Pehle har same-amount row ko "duplicate" maan ke
-- skip kar diya jaata tha — isliye count aur total dono kam aate the.
--
-- Solution: rows ko kabhi amount se match nahi karte. Duplicate ka pehchan
-- sirf do cheezon se:
--   1. transaction ID (jo file me ho)
--   2. file ka hash (batch) — wahi file dobara upload ho to poora block
--
-- Safe to run repeatedly.
-- ============================================================

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS batch TEXT;

CREATE INDEX IF NOT EXISTS deposits_batch_idx ON deposits (batch) WHERE batch IS NOT NULL;

-- Excel se aane wale deposits me mobile khaali hota hai (mobile customers file se
-- aata hai). Isliye client_stats me customer master ka mobile fallback rakho —
-- warna Level Report me number khaali dikhta hai.
DROP VIEW IF EXISTS client_stats;

CREATE VIEW client_stats AS
SELECT
  d.username,
  MIN(d.play_date)                              AS first_deposit,
  MAX(d.play_date)                              AS last_deposit,
  SUM(d.amount)                                 AS total_deposited,
  SUM(d.txn_count)::int                         AS deposit_count,
  COUNT(DISTINCT d.play_date)                   AS active_days,
  COALESCE(NULLIF(MAX(c.mobile), ''), NULLIF(MAX(d.mobile), ''), '') AS mobile
FROM deposits d
LEFT JOIN customers c ON LOWER(c.username) = LOWER(d.username)
WHERE d.status = 'successful'
GROUP BY d.username;


