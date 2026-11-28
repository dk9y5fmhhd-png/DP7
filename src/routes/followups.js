'use strict';

// Remarks — caller-wise report.
//
// Do hisse:
//   1. Caller-wise summary: har caller ne date range me kaun kaun se remark kitne kiye
//   2. Detail list: har remark alag, filter ke saath (caller, type, date, search)
//
// Deposited / Fake ka data `remark_events` se aata hai (customer delete hone par
// bhi bachta hai), baaki sab `followups` se.

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const D = require('../lib/dates');
const { ACTION_TYPES } = require('../lib/actions');

const router = express.Router();

const PER_PAGE = 100;

// Report me dikhne wale remark columns — order yahi rahega
const COLS = [
  'Deposited',
  'Will Deposit',
  'Interested',
  'Not Interested',
  'No Answer',
  'Number Not Reachable',
  'Fake',
  'Wrong Number',
  'Do Not Contact',
  'Already Active',
];

router.get('/', auth.requirePage('followups'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const action = String(req.query.action || '').trim();
    const caller = req.query.caller ? Number(req.query.caller) : null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const from = D.isDate(req.query.from) ? req.query.from : D.todayISO();
    const to = D.isDate(req.query.to) ? req.query.to : D.todayISO();

    const callers = await db.rows(
      `SELECT id, name, login_id FROM users WHERE role <> 'super_admin' ORDER BY name`
    );

    /* ---------------- caller-wise summary ---------------- */

    // Followups + remark_events dono se — par ek remark do baar na gine.
    // remark_events hamesha likha jata hai (v4.9+), followups purane data ke liye.
    const sum = await db.rows(
      `WITH ev AS (
         SELECT caller_id, action_type, COUNT(*)::int AS c
           FROM remark_events
          WHERE action_date BETWEEN $1::date AND $2::date
            AND caller_id IS NOT NULL
          GROUP BY caller_id, action_type
       ),
       old AS (
         -- v4.9 se pehle ke remarks (jinका event nahi hai)
         SELECT f.created_by AS caller_id, f.action_type, COUNT(*)::int AS c
           FROM followups f
          WHERE f.action_date BETWEEN $1::date AND $2::date
            AND f.created_by IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM remark_events e
               WHERE e.caller_id = f.created_by
                 AND e.action_date = f.action_date
                 AND LOWER(e.username) = LOWER(f.username)
                 AND e.action_type = f.action_type
            )
          GROUP BY f.created_by, f.action_type
       ),
       all_marks AS (
         SELECT * FROM ev UNION ALL SELECT * FROM old
       )
       SELECT u.id, u.name, u.login_id, u.team,
              COALESCE(SUM(a.c), 0)::int AS total,
              ${COLS.map((c) => `COALESCE(SUM(a.c) FILTER (WHERE a.action_type = '${c}'), 0)::int AS "${c}"`).join(',\n              ')}
         FROM users u
         LEFT JOIN all_marks a ON a.caller_id = u.id
        WHERE u.role <> 'super_admin'
        GROUP BY u.id, u.name, u.login_id, u.team
        ORDER BY total DESC, u.name`,
      [from, to]
    );

    const summaryTotals = sum.reduce((acc, r) => {
      acc.total += r.total;
      for (const c of COLS) acc[c] = (acc[c] || 0) + (r[c] || 0);
      return acc;
    }, { total: 0 });

    /* ---------------- detail list ---------------- */

    // Detail list do source se: followups (live customer) + remark_events
    // (jin客户 ka record delete ho gaya, unke remarks bhi dikhein).
    // Ek hi remark do baar na aaye — event wala skip jab followup maujood ho.
    const combined = `
      WITH combined AS (
        SELECT f.id            AS id,
               NULL::bigint    AS event_id,
               f.username      AS username,
               f.action_type   AS action_type,
               f.action_date   AS action_date,
               f.response      AS response,
               f.follow_up_on  AS follow_up_on,
               f.created_by    AS created_by,
               f.created_at    AS created_at
          FROM followups f
        UNION ALL
        SELECT NULL, e.id, e.username, e.action_type, e.action_date, e.note, NULL,
               e.caller_id, e.created_at
          FROM remark_events e
         WHERE NOT EXISTS (
           SELECT 1 FROM followups f2
            WHERE f2.created_by IS NOT DISTINCT FROM e.caller_id
              AND f2.action_date = e.action_date
              AND LOWER(f2.username) = LOWER(e.username)
              AND f2.action_type = e.action_type
         )
      )`;

    const params = [];
    const conds = ['x.action_date BETWEEN $1::date AND $2::date'];
    params.push(from, to);

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(x.username) LIKE $${params.length} OR LOWER(COALESCE(x.response,'')) LIKE $${params.length})`);
    }
    if (action) {
      params.push(action);
      conds.push(`x.action_type = $${params.length}`);
    }
    if (caller) {
      params.push(caller);
      conds.push(`x.created_by = $${params.length}`);
    }
    const where = conds.join(' AND ');

    const total = Number(await db.value(
      `${combined} SELECT COUNT(*)::int FROM combined x WHERE ${where}`, params
    ));
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const safe = Math.min(page, pages);

    const rows = await db.rows(
      `${combined}
       SELECT x.id, x.event_id, x.username, x.action_type,
              x.action_date::text AS action_date, x.response, x.created_at,
              x.follow_up_on::text AS follow_up_on,
              u.name AS by_name,
              c.status, c.assigned_to
         FROM combined x
         LEFT JOIN users u ON u.id = x.created_by
         LEFT JOIN customers c ON LOWER(c.username) = LOWER(x.username)
        WHERE ${where}
        ORDER BY x.action_date DESC, x.created_at DESC
        LIMIT ${PER_PAGE} OFFSET ${(safe - 1) * PER_PAGE}`,
      params
    );

    // Type ke hisaab se ginti — filter ke andar
    const byType = await db.rows(
      `${combined} SELECT x.action_type, COUNT(*)::int AS c FROM combined x
        WHERE x.action_date BETWEEN $1::date AND $2::date
        GROUP BY x.action_type ORDER BY c DESC`,
      [from, to]
    );

    res.render('followups', {
      title: 'Remarks',
      page: 'followups',
      rows,
      total,
      page: safe,
      pages,
      q, action, caller: caller || '',
      from, to,
      sum, summaryTotals, COLS,
      callers,
      byType,
      actionTypes: ACTION_TYPES,
      today: D.todayISO(),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Admin se remark add karna (remark dialog)
 * ------------------------------------------------------------------ */

router.post('/', auth.requireLogin, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const actionType = String(req.body.action_type || '').trim();
    const actionDate = D.isDate(req.body.action_date) ? req.body.action_date : D.todayISO();
    const response = String(req.body.response || '').trim().slice(0, 2000);
    const back = req.get('referer') || '/followups';

    // Callers may only write on customers assigned to them.
    if (!(await require('../lib/access').canTouch(req.session.user, username))) {
      req.session.flash = { type: 'error', message: 'That customer is not assigned to you.' };
      return res.redirect(back);
    }

    const R = require('../lib/remarks');
    if (!username || !R.ALL_ACTIONS.includes(actionType)) {
      req.session.flash = { type: 'error', message: 'Pick a customer and a remark.' };
      return res.redirect(back);
    }

    const info = R.info(actionType);

    // Fake — customer permanently delete
    if (R.DELETES.has(actionType)) {
      await db.query(
        `INSERT INTO remark_events (caller_id, username, action_type, action_date, note)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.session.user.id, username, actionType, actionDate, response]
      ).catch(() => null);
      await db.query(
        `DELETE FROM calls WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(username) = LOWER($1))`,
        [username]
      ).catch(() => null);
      await db.query('DELETE FROM followups WHERE LOWER(username) = LOWER($1)', [username]);
      const del = await db.query('DELETE FROM customers WHERE LOWER(username) = LOWER($1)', [username]);
      await auth.audit(req, 'remark_fake_delete', `${username} deleted rows=${del.rowCount}`);
      req.session.flash = { type: 'success', message: `${username} marked Fake and deleted permanently.` };
      return res.redirect(back);
    }

    let followUpOn = null;
    if (req.body.follow_up_on && D.isDate(req.body.follow_up_on)) {
      followUpOn = req.body.follow_up_on;
    } else if (req.body.follow_gap !== undefined && req.body.follow_gap !== '') {
      const gap = Number(req.body.follow_gap);
      followUpOn = D.addDays(actionDate, Number.isFinite(gap) ? gap : info.days);
    } else {
      followUpOn = D.addDays(actionDate, info.days);
    }
    if (R.SUPPRESS.has(actionType) || R.MOVES_OUT.has(actionType)) followUpOn = null;

    await db.query(
      `INSERT INTO followups
         (username, action_type, action_date, response, next_action, follow_up_on, caller_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [username, actionType, actionDate, response, info.next, followUpOn, req.session.user.id]
    );
    await db.query(
      `INSERT INTO remark_events (caller_id, username, action_type, action_date, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.session.user.id, username, actionType, actionDate, response]
    ).catch(() => null);

    if (R.SUPPRESS.has(actionType)) {
      await db.query('UPDATE customers SET do_not_contact = TRUE WHERE LOWER(username) = LOWER($1)', [username]);
    }

    // Deposited — queue se nikal kar Deposited tab me
    if (R.MOVES_OUT.has(actionType)) {
      await db.query(
        `UPDATE customers SET deposit_claimed_at = NOW(), deposit_claimed_by = $2,
                              next_touch_on = NULL, last_touched_at = $3::date
          WHERE LOWER(username) = LOWER($1)`,
        [username, req.session.user.id, actionDate]
      );
      await auth.audit(req, 'remark_deposited', `${username} → Deposited`);
      req.session.flash = {
        type: 'success',
        message: `${username} marked Deposited — moved to the Deposited tab.`,
      };
      return res.redirect(back);
    }

    await require('../lib/cadence').refreshOne(username).catch(() => null);
    await auth.audit(req, 'add_followup', `${username} → ${actionType}`);
    req.session.flash = {
      type: 'success',
      message: followUpOn
        ? `Remark saved — ${username}: ${actionType}. Next touch ${D.prettyDate(followUpOn)}.`
        : `Remark saved — ${username}: ${actionType}. No follow-up.`,
    };
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// Log-only remark (customer delete ho gaya) — sirf event row delete hoti hai
router.post('/event/:id/delete', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const out = await db.query('DELETE FROM remark_events WHERE id = $1', [req.params.id]);
    await auth.audit(req, 'delete_remark_event', `id=${req.params.id} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: 'Logged remark removed from the report.' };
    res.redirect(req.get('referer') || '/followups');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const out = await db.query('DELETE FROM followups WHERE id = $1', [req.params.id]);
    await auth.audit(req, 'delete_followup', `id=${req.params.id} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: 'Remark deleted.' };
    res.redirect(req.get('referer') || '/followups');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.ACTION_TYPES = ACTION_TYPES;

