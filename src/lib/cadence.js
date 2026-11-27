'use strict';

// Retention Cadence Engine
//
// Har customer ki regular touch cycle. Remark se date bante hi reset hoti hai,
// par jo call hi na hua use bhi cycle wapas laata hai.
//
//   A = VIP / high value      → 5 din
//   B = normal / active       → 12 din
//   C = purana dormant (>60d) → 30 din
//   D = Do Not Contact        → koi cycle nahi
//
// next_touch_on = agla scheduled touch.
//   remark hai aur usme follow_up_on hai  → wahi date (caller ka faisla)
//   remark hai par follow_up_on khaali    → action_date + gap
//   remark hi nahi                        → max(last_deposit, first_deposit) + gap

const db = require('../db');

const GAPS = { N: 1, A: 5, B: 12, C: 30, D: null };

const TIERS = {
  N: { key: 'N', label: 'ID created, no deposit', gap: 1, tone: 'warn', hint: 'first call next day' },
  A: { key: 'A', label: 'VIP / high value', gap: 5, tone: 'accent', hint: 'every 5 days' },
  B: { key: 'B', label: 'Normal / active', gap: 12, tone: 'info', hint: 'every 12 days' },
  C: { key: 'C', label: 'Old dormant', gap: 30, tone: 'neutral', hint: 'every 30 days' },
  D: { key: 'D', label: 'Do Not Contact', gap: null, tone: 'danger', hint: 'no touch at all' },
};

const ORDER = ['N', 'A', 'B', 'C', 'D'];

const DORMANT_DAYS = 60; // isse purana = tier C
const HIGH_VALUE_COUNT = 25; // itne deposit = high value

// SQL expression — tier nikaalne ka ek hi source of truth
// N = ID bana par ek bhi deposit nahi. Sirf 30 din tak — uske baad C (dormant).
const NO_DEPOSIT_DAYS = 30;

const TIER_SQL = `
  CASE
    WHEN c.do_not_contact THEN 'D'
    WHEN c.status = 'no_deposit'
         AND COALESCE(CURRENT_DATE - COALESCE(c.reg_date, c.created_at::date), 9999) <= ${NO_DEPOSIT_DAYS}
      THEN 'N'
    WHEN c.vip_category <> 'normal' THEN 'A'
    WHEN c.deposit_count >= ${HIGH_VALUE_COUNT} THEN 'A'
    WHEN c.status = 'inactive' AND COALESCE(CURRENT_DATE - c.last_deposit, 9999) <= 14 THEN 'A'
    WHEN COALESCE(CURRENT_DATE - c.last_deposit, 9999) > ${DORMANT_DAYS} THEN 'C'
    ELSE 'B'
  END`;

/**
 * Poora base dobara compute karo — tier, last touched, next touch.
 * 4-5k customers par ~50ms. Startup par aur sync ke baad chalta hai.
 */
async function refreshAll() {
  const out = await db.query(`
    WITH lf AS (
      -- sabse latest remark (GROUP BY nahi, warna correlated subquery nahi chalti)
      SELECT DISTINCT ON (LOWER(username))
             LOWER(username) AS uname,
             action_date     AS last_date,
             follow_up_on    AS next_date
        FROM followups
       ORDER BY LOWER(username), action_date DESC, id DESC
    ),
    calc AS (
      SELECT c.id,
             ${TIER_SQL} AS tier,
             lf.last_date AS touched,
             lf.next_date AS remark_next,
             COALESCE(c.last_deposit, c.first_deposit, c.reg_date) AS anchor
        FROM customers c
        LEFT JOIN lf ON lf.uname = LOWER(c.username)
    )
    UPDATE customers t
       SET cadence_tier   = x.tier,
           last_touched_at = x.touched,
           next_touch_on =
             CASE
               WHEN x.tier = 'D' THEN NULL
               WHEN x.remark_next IS NOT NULL THEN x.remark_next
               WHEN x.touched IS NOT NULL THEN x.touched + (CASE x.tier WHEN 'N' THEN 1 WHEN 'A' THEN 5 WHEN 'B' THEN 12 ELSE 30 END)
               ELSE x.anchor + (CASE x.tier WHEN 'N' THEN 1 WHEN 'A' THEN 5 WHEN 'B' THEN 12 ELSE 30 END)
             END
      FROM calc x
     WHERE t.id = x.id
       AND (t.cadence_tier   IS DISTINCT FROM x.tier
         OR t.last_touched_at IS DISTINCT FROM x.touched
         OR t.next_touch_on IS DISTINCT FROM
              CASE
                WHEN x.tier = 'D' THEN NULL
                WHEN x.remark_next IS NOT NULL THEN x.remark_next
                WHEN x.touched IS NOT NULL THEN x.touched + (CASE x.tier WHEN 'N' THEN 1 WHEN 'A' THEN 5 WHEN 'B' THEN 12 ELSE 30 END)
                ELSE x.anchor + (CASE x.tier WHEN 'N' THEN 1 WHEN 'A' THEN 5 WHEN 'B' THEN 12 ELSE 30 END)
              END)`);

  return out.rowCount;
}

/** Ek customer — remark save hote hi. */
async function refreshOne(username) {
  const r = await db.row(
    `SELECT c.id,
            ${TIER_SQL} AS tier,
            (SELECT MAX(action_date) FROM followups f WHERE LOWER(f.username) = LOWER(c.username)) AS touched,
            (SELECT follow_up_on FROM followups f WHERE LOWER(f.username) = LOWER(c.username)
              ORDER BY f.action_date DESC, f.id DESC LIMIT 1) AS remark_next,
            COALESCE(c.last_deposit, c.first_deposit, c.reg_date) AS anchor
       FROM customers c
      WHERE LOWER(c.username) = LOWER($1)`,
    [username]
  );
  if (!r) return null;

  const gap = GAPS[r.tier];
  let next = null;
  if (gap) {
    if (r.remark_next) next = r.remark_next;
    else if (r.touched) next = addDays(r.touched, gap);
    else next = addDays(r.anchor, gap);
  }

  await db.query(
    `UPDATE customers SET cadence_tier = $2, last_touched_at = $3, next_touch_on = $4 WHERE id = $1`,
    [r.id, r.tier, r.touched, next]
  );
  return { tier: r.tier, next };
}

function addDays(dateLike, n) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Coverage — asli health metric.
 * Kitne customers cycle ke andar touch hue, kitne untouched.
 */
async function coverage({ days = 7, callerId = null } = {}) {
  const params = [days];
  let callerWhere = '';
  if (callerId) {
    params.push(Number(callerId));
    callerWhere = ` AND b.assigned_to = $${params.length}`;
  }

  const tiers = await db.rows(
    `SELECT b.cadence_tier AS tier,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE b.touch_due)::int AS due,
            COUNT(*) FILTER (WHERE b.days_since_touch > $1::int)::int AS stale,
            COUNT(*) FILTER (WHERE b.last_touched_at IS NULL)::int AS never
       FROM customer_board b
      WHERE b.do_not_contact = FALSE ${callerWhere}
      GROUP BY b.cadence_tier
      ORDER BY b.cadence_tier`,
    params
  );

  const overall = await db.row(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE b.touch_due)::int AS due,
            COUNT(*) FILTER (WHERE b.days_since_touch > $1::int)::int AS stale,
            COUNT(*) FILTER (WHERE b.last_touched_at IS NULL)::int AS never,
            COUNT(*) FILTER (WHERE b.days_since_touch <= $1::int)::int AS covered
       FROM customer_board b
      WHERE b.do_not_contact = FALSE ${callerWhere}`,
    params
  );

  return { tiers, overall };
}

/** Roz kitne customer touch hue — rollout ka progress. */
async function dailyTouches(days = 7) {
  return db.rows(
    `WITH d AS (
       SELECT generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, '1 day')::date AS day
     ),
     t AS (
       SELECT action_date AS day, COUNT(DISTINCT LOWER(username))::int AS customers
         FROM followups
        WHERE action_date >= CURRENT_DATE - ($1::int - 1)
        GROUP BY action_date
     )
     SELECT d.day::text AS day,
            COALESCE(t.customers, 0)::int AS customers,
            (SELECT COUNT(*)::int FROM users u WHERE u.role <> 'super_admin') AS callers
       FROM d LEFT JOIN t ON t.day = d.day
      ORDER BY d.day`,
    [days]
  );
}

module.exports = { GAPS, TIERS, ORDER, TIER_SQL, DORMANT_DAYS, NO_DEPOSIT_DAYS, HIGH_VALUE_COUNT, refreshAll, refreshOne, coverage, dailyTouches, addDays };

