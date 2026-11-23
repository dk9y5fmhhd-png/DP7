-- ============================================================
-- DP7 v3.5 — purana daily-unique index zabardasti hatao + version check
--
-- Problem: kisi bhi database me (play_date + username) par bana UNIQUE index —
-- chahe uska naam kuch bhi ho — ek din me ek hi row aane deta hai. Isse
-- upload me sirf pehli row bachti hai aur count 1 ho jaata hai.
--
-- Yahan har aise index ko dhoondh ke drop kiya jaata hai (naam ka koi bharosa
-- nahi kiya jaata). Safe to run repeatedly.
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT i.indexname
      FROM pg_indexes i
     WHERE i.tablename = 'deposits'
       AND i.indexdef ILIKE '%UNIQUE%'
       AND i.indexdef ILIKE '%play_date%'
       AND i.indexdef ILIKE '%username%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
    RAISE NOTICE 'dropped old unique index: %', r.indexname;
  END LOOP;
END $$;

-- Ek din me ek hi manual entry (Add Data page) — ye chahiye
CREATE UNIQUE INDEX IF NOT EXISTS deposits_manual_day_uniq
  ON deposits (play_date, LOWER(username)) WHERE source = 'manual';

-- Ek transaction id sirf ek baar
CREATE UNIQUE INDEX IF NOT EXISTS deposits_txn_uniq
  ON deposits (LOWER(txn_id)) WHERE txn_id IS NOT NULL AND txn_id <> '';

