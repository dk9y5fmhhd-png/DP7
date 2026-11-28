-- ============================================================
-- DP7 v4.8 — har caller ke do alag daily target
--
--   nodep_target : "No deposit" tab  — naye ID ko pehla deposit dilana
--   dep_target   : "Deposited" tab   — purane customer ka follow-up
--
-- Pehle ek hi `daily_target` tha, isliye dono tab ek hi number dikhate the
-- aur caller ko pata nahi chalta tha kis tab me kitna kaam baaki hai.
--
-- daily_target bacha hua hai (purane code/reports ke liye) aur hamesha
-- nodep_target + dep_target ke barabar rakha jaata hai.
--
-- Backfill sirf pehli baar chalta hai (jab column naya banta hai) — dobara
-- chalane par admin ke set kiye number nahi badalte.
--
-- Safe to run repeatedly.
-- ============================================================

DO $$
DECLARE
  fresh BOOLEAN;
BEGIN
  SELECT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'nodep_target'
  ) INTO fresh;

  ALTER TABLE users ADD COLUMN IF NOT EXISTS nodep_target INTEGER NOT NULL DEFAULT 40;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS dep_target   INTEGER NOT NULL DEFAULT 35;

  IF fresh THEN
    -- 0 = no limit tha, use 0 hi rehne do
    UPDATE users SET nodep_target = 0, dep_target = 0
     WHERE role <> 'super_admin' AND daily_target = 0;

    -- baaki sab: 40:35 ke ratio me baant do (total capacity wahi rahe)
    -- 75 → 40/35, 150 → 80/70, 100 → 53/47
    UPDATE users
       SET nodep_target = GREATEST(1, ROUND(daily_target * 40.0 / 75.0)),
           dep_target   = daily_target - GREATEST(1, ROUND(daily_target * 40.0 / 75.0))
     WHERE role <> 'super_admin' AND daily_target > 0;
  END IF;
END $$;

-- daily_target ko dono ka jod rakho
UPDATE users
   SET daily_target = nodep_target + dep_target
 WHERE role <> 'super_admin'
   AND daily_target <> (nodep_target + dep_target);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_nodep_target_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_nodep_target_chk
      CHECK (nodep_target >= 0 AND nodep_target <= 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_dep_target_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_dep_target_chk
      CHECK (dep_target >= 0 AND dep_target <= 500);
  END IF;
END $$;

