-- ============================================================
-- DP7 — 3 callers me barabar split  (Railway Data tab ke liye)
--
-- Har block ALAG chalao — "Run" dabao, phir agla block.
-- (Data tab ka box ek hi statement leta hai, isliye tukdon me.)
--
-- Tested: 4,824 customers par — 1608/1608/1608, P1 = 89 each
-- Dobara chalane par wahi natija. Kuch delete nahi hota.
-- ============================================================


-- ============================================================
-- BLOCK 1 — pehle CHECK: aapke 3 callers mil rahe hain?
-- ============================================================
SELECT id, name, login_id, team, daily_target
  FROM users
 WHERE login_id IN ('arun', 'kamal', 'Diksha')
   AND role <> 'super_admin'
 ORDER BY id;

-- 3 rows aane chahiye. Kam aaye to BLOCK 2 ke names apne hisaab se badlein.


-- ============================================================
-- BLOCK 2 — team + roz ka target 150
-- ============================================================
UPDATE users
   SET team = 'retention',
       daily_target = 150,
       require_approval = FALSE
 WHERE login_id IN ('arun', 'kamal', 'Diksha')
   AND role <> 'super_admin';


-- ============================================================
-- BLOCK 3 — baaki callers ko acquisition par
-- ============================================================
UPDATE users
   SET team = 'acquisition',
       daily_target = 150
 WHERE login_id NOT IN ('arun', 'kamal', 'Diksha')
   AND role <> 'super_admin';


-- ============================================================
-- BLOCK 4 — ASLI SPLIT (ek hi statement, sab kuch andar)
-- ============================================================
WITH pick AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY id) - 1 AS slot,
         COUNT(*) OVER () AS total
    FROM users
   WHERE login_id IN ('arun', 'kamal', 'Diksha')
     AND role <> 'super_admin'
),
pool AS (
  SELECT c.id,
         ROW_NUMBER() OVER (
           ORDER BY
             CASE b.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2
                             WHEN 'P3' THEN 3 ELSE 4 END,
             c.deposit_count DESC,
             c.username
         ) - 1 AS rn
    FROM customers c
    JOIN customer_board b ON b.id = c.id
   WHERE c.do_not_contact = FALSE
)
UPDATE customers t
   SET assigned_to = p.id
  FROM pool pl
  JOIN pick p ON p.slot = (pl.rn % p.total)
 WHERE t.id = pl.id;


-- ============================================================
-- BLOCK 5 — VERIFY (yahi screenshot lena)
-- ============================================================
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
 ORDER BY (u.team = 'retention') DESC, assigned DESC, u.name;


-- ============================================================
-- BLOCK 6 — bina caller kitne bache
-- ============================================================
SELECT COUNT(*)::int AS bina_caller
  FROM customers
 WHERE assigned_to IS NULL;

