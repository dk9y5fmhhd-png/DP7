'use strict';

// Retention Cadence — admin dekhta hai har tier ka coverage, aur 7 din ka
// rollout progress (kitne customers touch hue, kitne bhoole gaye).

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const CAD = require('../lib/cadence');

const router = express.Router();

router.use(auth.requireSuperAdmin);

router.get('/', async (req, res, next) => {
  try {
    const days = [7, 15, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;

    const { tiers, overall } = await CAD.coverage({ days });
    const daily = await CAD.dailyTouches(days);

    // Per caller coverage
    const perCaller = await db.rows(
      `SELECT u.id, u.name, u.team, u.daily_target,
              COUNT(b.id)::int AS assigned,
              COUNT(b.id) FILTER (WHERE b.days_since_touch <= $1::int)::int AS covered,
              COUNT(b.id) FILTER (WHERE b.days_since_touch > $1::int)::int AS stale,
              COUNT(b.id) FILTER (WHERE b.last_touched_at IS NULL)::int AS never,
              COUNT(b.id) FILTER (WHERE b.touch_due)::int AS due,
              COUNT(b.id) FILTER (WHERE b.cadence_tier = 'A')::int AS tier_a,
              COUNT(b.id) FILTER (WHERE b.cadence_tier = 'B')::int AS tier_b,
              COUNT(b.id) FILTER (WHERE b.cadence_tier = 'C')::int AS tier_c
         FROM users u
         LEFT JOIN customer_board b
                ON b.assigned_to = u.id AND b.do_not_contact = FALSE
        WHERE u.role <> 'super_admin'
        GROUP BY u.id, u.name, u.team, u.daily_target
        ORDER BY u.team, assigned DESC, u.name`,
      [days]
    );
    for (const c of perCaller) {
      c.coverage = c.assigned ? Math.round((c.covered / c.assigned) * 100) : 0;
      c.need_per_day = days ? Math.ceil(c.stale / days) : 0;
    }

    // Rollout — poore base par ek round kitne din me
    const totals = perCaller.reduce((a, c) => ({
      assigned: a.assigned + c.assigned,
      covered: a.covered + c.covered,
      stale: a.stale + c.stale,
      need_per_day: a.need_per_day + c.need_per_day,
      target: a.target + Number(c.daily_target || 0),
    }), { assigned: 0, covered: 0, stale: 0, need_per_day: 0, target: 0 });

    totals.daysToFinish = totals.target ? Math.ceil(totals.stale / totals.target) : null;
    totals.coverage = totals.assigned ? Math.round((totals.covered / totals.assigned) * 100) : 0;

    // Overdue cadence — jinka touch date nikal gaya
    const worst = await db.rows(
      `SELECT b.username, b.cadence_tier, b.next_touch_on::text AS next_touch_on,
              b.days_since_touch, b.deposit_count, b.deposit_amount,
              b.status, b.vip_category, u.name AS caller_name
         FROM customer_board b
         LEFT JOIN users u ON u.id = b.assigned_to
        WHERE b.do_not_contact = FALSE
          AND b.next_touch_on IS NOT NULL
          AND b.next_touch_on < CURRENT_DATE - 3
          AND b.deposit_count >= 2
        ORDER BY b.days_since_touch DESC
        LIMIT 25`
    );

    const tierRows = CAD.ORDER.map((k) => {
      const t = tiers.find((x) => x.tier === k) || { total: 0, due: 0, stale: 0, never: 0 };
      return { ...CAD.TIERS[k], ...t };
    });

    res.render('cadence', {
      title: 'Retention Cadence',
      page: 'cadence',
      days, tierRows, overall, daily, perCaller, totals, worst,
      tiers: CAD.TIERS,
    });
  } catch (err) {
    next(err);
  }
});

// Poora base dobara compute — manual button
router.post('/refresh', async (req, res, next) => {
  try {
    const n = await CAD.refreshAll();
    await auth.audit(req, 'cadence_refresh', `rows=${n}`);
    req.session.flash = {
      type: 'success',
      message: n ? `${n} customers ka cadence update ho gaya.` : 'Sab pehle se up to date hai.',
    };
    res.redirect('/cadence');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

