'use strict';

// Daily Report — har caller ka aaj ka hisaab ek jagah.
//
//   target        : aaj ka target (no-deposit + deposited)
//   calls done    : aaj kitne alag customer touch kiye
//   deposited     : aaj kitne ne "Deposited" bola
//   fake          : aaj kitne "Fake" nikle (delete ho gaye)
//   interested    : 5 din baad wapas
//   will deposit  : 3 din baad wapas
//   not interested: 15 din baad wapas
//   tomorrow due  : kal ki calling me kitne aayenge
//
// Deposited / Fake ka ginti `remark_events` se aata hai — customer delete hone
// par bhi hisaab bacha rehta hai.

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const D = require('../lib/dates');

const router = express.Router();

router.use(auth.requireSuperAdmin);

router.get('/', async (req, res, next) => {
  try {
    const date = D.isDate(req.query.d) ? req.query.d : D.todayISO();
    const tomorrow = D.addDays(date, 1);

    // Per-caller: target, done, remark breakdown
    const perCaller = await db.rows(
      `WITH work AS (
         SELECT f.created_by AS caller_id, LOWER(f.username) AS uname
           FROM followups f WHERE f.action_date = $1::date AND f.created_by IS NOT NULL
         UNION
         SELECT k.caller_id, LOWER(k.username)
           FROM calls k WHERE k.called_at::date = $1::date AND k.caller_id IS NOT NULL
       ),
       done AS (
         SELECT caller_id, COUNT(DISTINCT uname)::int AS calls
           FROM work GROUP BY caller_id
       ),
       marks AS (
         SELECT caller_id,
                COUNT(*) FILTER (WHERE action_type = 'Deposited')::int           AS deposited,
                COUNT(*) FILTER (WHERE action_type = 'Fake')::int                AS fake,
                COUNT(*) FILTER (WHERE action_type = 'Interested')::int          AS interested,
                COUNT(*) FILTER (WHERE action_type = 'Will Deposit')::int        AS will_dep,
                COUNT(*) FILTER (WHERE action_type = 'Not Interested')::int      AS not_int,
                COUNT(*) FILTER (WHERE action_type IN ('No Answer','Number Not Reachable'))::int AS no_answer
           FROM remark_events
          WHERE action_date = $1::date AND caller_id IS NOT NULL
          GROUP BY caller_id
       ),
       tomorrow_due AS (
         SELECT assigned_to AS caller_id, COUNT(*)::int AS c
           FROM customer_board
          WHERE next_touch_on = $2::date AND do_not_contact = FALSE AND assigned_to IS NOT NULL
          GROUP BY assigned_to
       ),
       booked AS (
         SELECT assigned_to AS caller_id,
                COUNT(*) FILTER (WHERE is_nodep)::int AS nodep_total,
                COUNT(*) FILTER (WHERE NOT is_nodep)::int AS dep_total
           FROM customer_board
          WHERE do_not_contact = FALSE AND assigned_to IS NOT NULL
          GROUP BY assigned_to
       )
       SELECT u.id, u.name, u.login_id, u.team,
              COALESCE(u.nodep_target, 40)::int AS nodep_target,
              COALESCE(u.dep_target, 35)::int   AS dep_target,
              (COALESCE(u.nodep_target, 40) + COALESCE(u.dep_target, 35))::int AS target,
              COALESCE(d.calls, 0)::int AS calls,
              COALESCE(m.deposited, 0)::int AS deposited,
              COALESCE(m.fake, 0)::int AS fake,
              COALESCE(m.interested, 0)::int AS interested,
              COALESCE(m.will_dep, 0)::int AS will_dep,
              COALESCE(m.not_int, 0)::int AS not_int,
              COALESCE(m.no_answer, 0)::int AS no_answer,
              COALESCE(t.c, 0)::int AS tomorrow_due,
              COALESCE(b.nodep_total, 0)::int AS nodep_total,
              COALESCE(b.dep_total, 0)::int AS dep_total
         FROM users u
         LEFT JOIN done d         ON d.caller_id = u.id
         LEFT JOIN marks m        ON m.caller_id = u.id
         LEFT JOIN tomorrow_due t ON t.caller_id = u.id
         LEFT JOIN booked b       ON b.caller_id = u.id
        WHERE u.role <> 'super_admin'
        ORDER BY u.team, u.name`,
      [date, tomorrow]
    );

    // Carry-over: kitne customers aaj se aage khisak gaye
    const carry = await db.row(
      `SELECT
         COUNT(*) FILTER (WHERE action_type = 'Interested')::int      AS interested,
         COUNT(*) FILTER (WHERE action_type = 'Will Deposit')::int    AS will_dep,
         COUNT(*) FILTER (WHERE action_type = 'Not Interested')::int  AS not_int,
         COUNT(*) FILTER (WHERE action_type = 'Deposited')::int       AS deposited,
         COUNT(*) FILTER (WHERE action_type = 'Fake')::int            AS fake,
         COUNT(*) FILTER (WHERE action_type IN ('No Answer','Number Not Reachable'))::int AS no_answer,
         COUNT(*)::int AS total
       FROM remark_events WHERE action_date = $1::date`,
      [date]
    );

    const dueTomorrow = await db.row(
      `SELECT COUNT(*) FILTER (WHERE is_nodep)::int AS nodep,
              COUNT(*) FILTER (WHERE NOT is_nodep)::int AS dep,
              COUNT(*)::int AS total
         FROM customer_board
        WHERE next_touch_on = $1::date AND do_not_contact = FALSE AND assigned_to IS NOT NULL`,
      [tomorrow]
    );

    const totals = perCaller.reduce((a, c) => ({
      target: a.target + c.target,
      calls: a.calls + c.calls,
      deposited: a.deposited + c.deposited,
      fake: a.fake + c.fake,
      interested: a.interested + c.interested,
      will_dep: a.will_dep + c.will_dep,
      not_int: a.not_int + c.not_int,
      no_answer: a.no_answer + c.no_answer,
      tomorrow_due: a.tomorrow_due + c.tomorrow_due,
      nodep_total: a.nodep_total + c.nodep_total,
      dep_total: a.dep_total + c.dep_total,
    }), {
      target: 0, calls: 0, deposited: 0, fake: 0, interested: 0,
      will_dep: 0, not_int: 0, no_answer: 0, tomorrow_due: 0,
      nodep_total: 0, dep_total: 0,
    });

    // Kal ka load — kya caller ke 150 me fit hoga?
    totals.capacity = totals.target;
    totals.overload = totals.tomorrow_due - totals.capacity;

    // Hafta bhar ka trend
    const trend = await db.rows(
      `SELECT d::date::text AS day,
              COALESCE(e.total, 0)::int AS remarks,
              COALESCE(e.deposited, 0)::int AS deposited,
              COALESCE(e.fake, 0)::int AS fake
         FROM generate_series($1::date - 6, $1::date, '1 day') d
         LEFT JOIN (
           SELECT action_date,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE action_type = 'Deposited')::int AS deposited,
                  COUNT(*) FILTER (WHERE action_type = 'Fake')::int AS fake
             FROM remark_events GROUP BY action_date
         ) e ON e.action_date = d::date
        ORDER BY d`,
      [date]
    );

    // Pending queue abhi (aaj tak due)
    const queue = await db.row(
      `SELECT COUNT(*) FILTER (WHERE is_nodep)::int AS nodep,
              COUNT(*) FILTER (WHERE NOT is_nodep)::int AS dep,
              COUNT(*)::int AS total
         FROM customer_board
        WHERE do_not_contact = FALSE
          AND (next_touch_on IS NULL OR next_touch_on <= $1::date)`,
      [date]
    );

    res.render('daily_report', {
      title: 'Daily Report',
      page: 'daily',
      date,
      tomorrow,
      perCaller, totals, carry, dueTomorrow, trend, queue,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

