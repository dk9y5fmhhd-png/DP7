-- ============================================================
-- DP7 — 3 callers me barabar split  (SQL fallback)
--
-- Kab: jab /callers page na khule (views upload nahi hue ho).
-- Kahan: Railway → Postgres service → Data → Query tab → poora paste → Run
--
-- Tested: 4,824 customers par chalake dekha —
--   arun 1608 (P1 89) · kamal 1608 (P1 89) · Diksha 1608 (P1 89)
--   bina caller 0
--
-- Dobara chalane par wahi natija (idempotent). Data delete nahi hota.
-- ============================================================


-- ---------- 1. apne 3 callers ke login_id yahan likhein ----------
-- 'arun', 'kamal', 'Diksha' ki jagah jo bhi ho. Exactly 3 hone chahiye.

CREATE TEMP TABLE split_callers AS
SELECT id, login_id,
       ROW_NUMBER() OVER (ORDER BY id) - 1 AS slot
  FROM users
 WHERE login_id IN ('arun', 'kamal', 'Diksha')
   AND role <> 'super_admin';

-- Ye 3 rows dikhni chahiye. Kam dikhi to naam galat likha hai — ruk jayein.
SELECT slot, login_id FROM split_callers ORDER BY slot;


-- ---------- 2. team + roz ka target ----------
UPDATE users
   SET team = 'retention',
       daily_target = 150,
       require_approval = FALSE
 WHERE id IN (SELECT id FROM split_callers);


-- ---------- 3. baaki callers → acquisition, unke pass kuch nahi ----------
UPDATE users
   SET team = 'acquisition',
       daily_target = 150
 WHERE id NOT IN (SELECT id FROM split_callers)
   AND role <> 'super_admin';


-- ---------- 4. barabar split ----------
-- Priority ke hisaab se line lagti hai (P1 → P2 → P3 → P4), phir har teesra
-- customer ek caller ko. Isse har caller ko har priority ka barabar hissa
-- milta hai — VIP sab ek ke paas nahi jaate.
WITH pool AS (
  SELECT c.id,
         ROW_NUMBER() OVER (
           ORDER BY
             CASE b.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
             c.deposit_count DESC,
             c.username
         ) - 1 AS rn
    FROM customers c
    JOIN customer_board b ON b.id = c.id
   WHERE c.do_not_contact = FALSE
),
assign AS (
  SELECT p.id,
         (SELECT s.id FROM split_callers s WHERE s.slot = (p.rn % 3)) AS caller_id
    FROM pool p
)
UPDATE customers t
   SET assigned_to = a.caller_id
  FROM assign a
 WHERE t.id = a.id;


-- ---------- 5. verify — yahi numbers screenshot lena ----------
SELECT u.name AS caller,
       u.team,
       u.daily_target,
       COUNT(c.id)::int AS assigned,
       COUNT(c.id) FILTER (WHERE b.priority = 'P1')::int AS p1,
       COUNT(c.id) FILTER (WHERE b.priority = 'P2')::int AS p2,
       COUNT(c.id) FILTER (WHERE b.priority = 'P4')::int AS p4
  FROM users u
  LEFT JOIN customers c ON c.assigned_to = u.id
  LEFT JOIN customer_board b ON b.id = c.id
 WHERE u.role <> 'super_admin'
 GROUP BY u.name, u.team, u.daily_target
 ORDER BY u.team, assigned DESC, u.name;

-- Bina caller kitne bache (sirf Do Not Contact bachenge)
SELECT COUNT(*)::int AS bina_caller FROM customers WHERE assigned_to IS NULL;

DROP TABLE split_callers;

