'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const C = require('../lib/customers');
const R = require('../lib/remarks');
const D = require('../lib/dates');

const router = express.Router();

const PRIORITIES = ['P1', 'P2', 'P3'];

/* --------------------------- calling lists --------------------------- */

router.get('/', auth.requirePage('priority'), async (req, res, next) => {
  try {
    const priority = PRIORITIES.includes(req.query.p) ? req.query.p : 'P1';
    const caller = req.query.caller ? Number(req.query.caller) : null;
    const onlyFree = req.query.free === '1';

    const params = [priority];
    let extra = '';
    if (caller) { params.push(caller); extra += ` AND b.assigned_to = $${params.length}`; }
    if (onlyFree) extra += ' AND b.assigned_to IS NULL';

    const rows = await db.rows(
      `SELECT b.*, u.name AS caller_name,
              (SELECT action_type FROM followups f WHERE LOWER(f.username) = LOWER(b.username)
                ORDER BY f.action_date DESC, f.id DESC LIMIT 1) AS last_remark
         FROM customer_board b LEFT JOIN users u ON u.id = b.assigned_to
        WHERE b.priority = $1 ${extra}
        ORDER BY b.deposit_count DESC, b.days_inactive ASC`,
      params
    );

    const counts = await db.rows(
      `SELECT priority, COUNT(*)::int AS c,
              COUNT(*) FILTER (WHERE assigned_to IS NULL)::int AS free
         FROM customer_board GROUP BY priority ORDER BY priority`
    );

    res.render('priority', {
      title: 'Calling List',
      page: 'priority',
      rows: rows.map((r) => ({ ...r, mobile_shown: C.maskMobile(r.mobile, false) })),
      priority, counts: new Map(counts.map((c) => [c.priority, c])),
      filters: { caller: caller || '', free: onlyFree },
      callers: await db.rows("SELECT id, name FROM users WHERE role IN ('super_admin','admin') OR page_access && ARRAY['mycalls','all'] ORDER BY name"),
      labels: { VIP_LABEL: C.VIP_LABEL, PRIORITY_LABEL: C.PRIORITY_LABEL },
      roleWeights: { P1: 'VIP inactive + recently inactive', P2: 'Normal inactive + new customer', P3: 'Callback pending' },
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- my calls (caller) --------------------------- */

router.get('/my', auth.requirePage('mycalls'), async (req, res, next) => {
  try {
    const me = req.session.user.id;
    const today = D.todayISO();

    const rows = await db.rows(
      `SELECT b.*,
              (SELECT action_type FROM followups f WHERE LOWER(f.username) = LOWER(b.username)
                ORDER BY f.action_date DESC, f.id DESC LIMIT 1) AS last_remark,
              (SELECT action_date::text FROM followups f WHERE LOWER(f.username) = LOWER(b.username)
                ORDER BY f.action_date DESC, f.id DESC LIMIT 1) AS last_remark_date,
              (SELECT COUNT(*)::int FROM calls k
                WHERE k.customer_id = b.id AND k.called_at::date = $2) AS calls_today
         FROM customer_board b
        WHERE b.assigned_to = $1 AND b.do_not_contact = FALSE
        ORDER BY
          CASE b.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
          b.deposit_count DESC, b.days_inactive ASC`,
      [me, today]
    );

    const stats = await db.row(
      `SELECT
         COUNT(*) FILTER (WHERE b.priority IN ('P1','P2','P3'))::int AS pending,
         COUNT(*) FILTER (WHERE b.priority = 'P1')::int AS p1,
         COUNT(*) FILTER (WHERE b.priority = 'P2')::int AS p2,
         COUNT(*) FILTER (WHERE b.priority = 'P3')::int AS p3,
         COUNT(*)::int AS total
       FROM customer_board b
      WHERE b.assigned_to = $1 AND b.do_not_contact = FALSE`,
      [me]
    );

    const doneToday = await db.row(
      `SELECT COUNT(*)::int AS calls,
              COUNT(DISTINCT customer_id)::int AS customers
         FROM calls WHERE caller_id = $1 AND called_at::date = $2`,
      [me, today]
    );

    res.render('mycalls', {
      title: 'My Calls',
      page: 'mycalls',
      rows: rows.map((r) => ({ ...r, mobile_shown: C.maskMobile(r.mobile, false) })),
      stats, doneToday, today,
      remarks: R.REMARKS,
      labels: { VIP_LABEL: C.VIP_LABEL, PRIORITY_LABEL: C.PRIORITY_LABEL, STATUS_LABEL: C.STATUS_LABEL },
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- remark save --------------------------- */

router.post('/remark', auth.requireLogin, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const action = String(req.body.action_type || '').trim();
    const note = String(req.body.response || '').trim().slice(0, 2000);
    const date = D.isDate(req.body.action_date) ? req.body.action_date : D.todayISO();

    if (!username) throw new Error('Customer chunein.');
    if (!R.ALL_ACTIONS.includes(action)) throw new Error('Remark chunein.');

    const nextAction = R.nextActionFor(action);

    await db.query(
      `INSERT INTO followups (username, action_type, action_date, response, next_action, caller_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [username, action, date, note, nextAction, req.session.user.id, req.session.user.id]
    );

    // Do Not Contact → customer suppress
    if (R.SUPPRESS.has(action)) {
      await db.query('UPDATE customers SET do_not_contact = TRUE WHERE LOWER(username) = LOWER($1)', [username]);
    }

    await auth.audit(req, 'remark', `${username} → ${action}`);
    req.session.flash = {
      type: 'success',
      message: `Remark save — ${username}: ${action}${nextAction ? ' → ' + nextAction : ''}`,
    };
    res.redirect(req.get('referer') || '/my-calls');
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(req.get('referer') || '/my-calls');
  }
});

module.exports = router;

