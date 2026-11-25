-- ============================================================
-- DP7 v4.1 — daily target + progress
--
-- Har caller ka ek roz ka target (default 40). My Calls par progress bar,
-- list sirf baaki target jitni dikhti hai, aur admin ko Follow-ups Due par
-- har caller ka target / kiya / baaki.
--
-- "Aaj ka kaam" = aaj jitne alag customers ko touch kiya (remark ya call).
--
-- Safe to run repeatedly.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_target INTEGER NOT NULL DEFAULT 40;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_daily_target_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_daily_target_chk
      CHECK (daily_target >= 0 AND daily_target <= 500);
  END IF;
END $$;

-- Aaj kis-kis customer ko touch kiya (remark ya call) — target ka base
CREATE OR REPLACE VIEW caller_daily_work AS
SELECT caller_id, work_date, COUNT(DISTINCT uname)::int AS customers, COUNT(*)::int AS actions
FROM (
  SELECT created_by AS caller_id, action_date AS work_date, LOWER(username) AS uname
    FROM followups WHERE created_by IS NOT NULL
  UNION ALL
  SELECT caller_id, called_at::date AS work_date, LOWER(username) AS uname
    FROM calls WHERE caller_id IS NOT NULL
) t
GROUP BY caller_id, work_date;

