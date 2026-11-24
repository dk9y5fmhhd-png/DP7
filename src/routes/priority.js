'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const C = require('../lib/customers');
const R = require('../lib/remarks');
const D = require('../lib/dates');

const router = express.Router();

const PRIORITIES = ['P1', 'P2', 'P3'];

async function callerList() {
  return db.rows(
    `SELECT id, name FROM users
      WHERE role IN ('super_admin','admin') OR page_access && ARRAY['mycalls','all']
      ORDER BY name`
  );
}

/* --------------------------- calling lists (admin) --------------------------- */

router.get('/', auth.requirePage('priority'), async (req, res, next) => {
  try {
    const priority = PRIORITIES.includes(req.query.p) ? req.query.p : 'P1';
    const caller = req.query.caller ? Number(req.query.caller) : null;
    const onlyFree = req.query.free === '1';
    const today = D.todayISO();

    const params = [priority];
    let extra = '';
    if (caller) { params.push(caller); extra += ` AND b.assigned_to = $${params.length}`; }
    if (onlyFree) extra += ' AND b.assigned_to IS NULL';

    const rows = await db.rows(
      `SELECT b.*, u.name AS caller_name,
              lf.action_type AS last_remark, lf.follow_up_on, lf.outcome AS last_outcome
         FROM customer_board b
         LEFT JOIN users u ON u.id = b.assigned_to
         LEFT JOIN latest_followup lf ON lf.uname = LOWER(b.username)
        WHERE b.priority = $1 ${extra}
        ORDER BY
          CASE WHEN lf.follow_up_on IS NOT NULL AND lf.follow_up_on < CURRENT_DATE THEN 0 ELSE 1 END,
          b.deposit_count DESC, b.days_inactive ASC`,
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
      callers: await callerList(),
      labels: { VIP_LABEL: C.VIP_LABEL, PRIORITY_LABEL: C.PRIORITY_LABEL },
      today,
      roleWeights: {
        P1: 'VIP inactive + recently inactive (14 din)',
        P2: 'Normal inactive + naya customer',
        P3: 'Reactivated — dobara active hua',
      },
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- my calls (caller) --------------------------- */

// Caller ki list = sirf WAHI customers jinka follow-up aaj ya pehle due hai.
// Jiska agla follow-up aage hai wo tab tak chhupa rehta hai.
function mineCte() {
  return `
    WITH mine AS (
      SELECT b.*,
             u.name AS caller_name,
             lf.action_type   AS last_remark,
             lf.action_date   AS last_remark_date,
             lf.follow_up_on  AS follow_up_on,
             lf.outcome       AS last_outcome,
             (SELECT COUNT(*)::int FROM calls k
               WHERE k.customer_id = b.id AND k.called_at::date = $2::date) AS calls_today
        FROM customer_board b
        LEFT JOIN users u ON u.id = b.assigned_to
        LEFT JOIN latest_followup lf ON lf.uname = LOWER(b.username)
       WHERE b.assigned_to = $1 AND b.do_not_contact = FALSE
    )`;
}

router.get('/my', auth.requirePage('mycalls'), async (req, res, next) => {
  try {
    const me = req.session.user.id;
    const today = D.todayISO();
    const showAll = req.query.all === '1';

    const base = mineCte();

    const rows = await db.rows(
      `${base}
       SELECT *,
              (follow_up_on IS NOT NULL AND follow_up_on < $2::date) AS is_overdue,
              ($2::date - follow_up_on) AS days_late
         FROM mine
        WHERE $3::boolean OR follow_up_on IS NULL OR follow_up_on <= $2::date
        ORDER BY
          CASE WHEN follow_up_on IS NOT NULL AND follow_up_on < $2::date THEN 0 ELSE 1 END,
          follow_up_on ASC NULLS FIRST,
          CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
          deposit_count DESC, days_inactive ASC`,
      [me, today, showAll]
    );

    const stats = await db.row(
      `${base}
       SELECT
         COUNT(*) FILTER (WHERE follow_up_on IS NULL
                            OR follow_up_on = $2::date)::int   AS due,
         COUNT(*) FILTER (WHERE follow_up_on < $2::date)::int   AS overdue,
         COUNT(*) FILTER (WHERE follow_up_on > $2::date)::int   AS snoozed,
         COUNT(*) FILTER (WHERE priority = 'P1' AND (follow_up_on IS NULL OR follow_up_on <= $2::date))::int AS due_p1,
         COUNT(*)::int AS total
       FROM mine`,
      [me, today]
    );

    const doneToday = await db.row(
      `SELECT COUNT(*)::int AS remarks,
              COUNT(DISTINCT LOWER(username))::int AS customers
         FROM followups
        WHERE created_by = $1 AND action_date = $2::date`,
      [me, today]
    );

    const upcoming = await db.rows(
      `${base}
       SELECT username, follow_up_on, last_remark, ($2::date - follow_up_on) AS in_days
         FROM mine
        WHERE follow_up_on > $2::date
        ORDER BY follow_up_on ASC LIMIT 12`,
      [me, today]
    );

    res.render('mycalls', {
      title: 'My Calls',
      page: 'mycalls',
      rows: rows.map((r) => ({ ...r, mobile_shown: C.maskMobile(r.mobile, false) })),
      stats, doneToday, upcoming, showAll, today,
      remarks: R.REMARKS,
      quickDates: R.QUICK_DATES,
      labels: { VIP_LABEL: C.VIP_LABEL, PRIORITY_LABEL: C.PRIORITY_LABEL, STATUS_LABEL: C.STATUS_LABEL },
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- follow-ups due (admin) --------------------------- */

// Kis caller ka kitna pending / overdue / aaj due
router.get('/due', auth.requirePage('due'), async (req, res, next) => {
  try {
    const today = D.todayISO();

    const perCaller = await db.rows(
      `SELECT u.id, u.name AS caller_name,
              COUNT(*) FILTER (WHERE lf.follow_up_on IS NULL OR lf.follow_up_on = CURRENT_DATE)::int AS due,
              COUNT(*) FILTER (WHERE lf.follow_up_on IS NULL OR lf.follow_up_on <= CURRENT_DATE)::int AS pending,
              COUNT(*) FILTER (WHERE lf.follow_up_on < CURRENT_DATE)::int AS overdue,
              COUNT(*) FILTER (WHERE lf.follow_up_on > CURRENT_DATE)::int AS snoozed,
              COUNT(*)::int AS total
         FROM customer_board b
         JOIN users u ON u.id = b.assigned_to
         LEFT JOIN latest_followup lf ON lf.uname = LOWER(b.username)
        WHERE b.do_not_contact = FALSE
        GROUP BY u.id, u.name
        ORDER BY overdue DESC, due DESC`
    );

    const doneToday = await db.rows(
      `SELECT u.name AS caller_name, COUNT(*)::int AS remarks,
              COUNT(DISTINCT LOWER(f.username))::int AS customers
         FROM followups f JOIN users u ON u.id = f.created_by
        WHERE f.action_date = CURRENT_DATE
        GROUP BY u.name ORDER BY remarks DESC`
    );

    const overdueRows = await db.rows(
      `SELECT b.username, b.mobile, b.priority, b.deposit_count, b.vip_category,
              u.name AS caller_name, lf.action_type, lf.follow_up_on,
              (CURRENT_DATE - lf.follow_up_on)::int AS days_late
         FROM customer_board b
         JOIN users u ON u.id = b.assigned_to
         JOIN latest_followup lf ON lf.uname = LOWER(b.username)
        WHERE b.do_not_contact = FALSE AND lf.follow_up_on < CURRENT_DATE
        ORDER BY days_late DESC, b.deposit_count DESC
        LIMIT 100`
    );

    const totals = {
      overdue: perCaller.reduce((a, c) => a + c.overdue, 0),
      due: perCaller.reduce((a, c) => a + c.due, 0),
      pending: perCaller.reduce((a, c) => a + c.pending, 0),
      done: doneToday.reduce((a, c) => a + c.remarks, 0),
    };

    res.render('followups_due', {
      title: 'Follow-ups Due',
      page: 'due',
      perCaller, doneToday, overdueRows, totals, today,
      labels: { VIP_LABEL: C.VIP_LABEL, PRIORITY_LABEL: C.PRIORITY_LABEL },
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

    const q = R.info(action);

    // Follow-up date: caller ne chuni ho → wahi; warna remark ka default gap
    let followUpOn = null;
    if (req.body.follow_up_on && D.isDate(req.body.follow_up_on)) {
      followUpOn = req.body.follow_up_on;
    } else if (req.body.follow_gap !== undefined && req.body.follow_gap !== '') {
      const gap = Number(req.body.follow_gap);
      followUpOn = D.addDays(date, Number.isFinite(gap) ? gap : q.days);
    } else {
      followUpOn = D.addDays(date, q.days);
    }

    // Do Not Contact → koi follow-up nahi
    if (R.SUPPRESS.has(action)) followUpOn = null;

    await db.query(
      `INSERT INTO followups
         (username, action_type, action_date, response, next_action, follow_up_on, caller_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [username, action, date, note, q.next, followUpOn, req.session.user.id]
    );

    if (R.SUPPRESS.has(action)) {
      await db.query('UPDATE customers SET do_not_contact = TRUE WHERE LOWER(username) = LOWER($1)', [username]);
    }

    await auth.audit(req, 'remark', `${username} → ${action} · fu=${followUpOn || 'none'}`);
    req.session.flash = {
      type: 'success',
      message: followUpOn
        ? `Remark save — ${username}: ${action}. Agla follow-up ${D.prettyDate(followUpOn)} (${D.relativeDays(followUpOn, date)}).`
        : `Remark save — ${username}: ${action}. List se hata diya.`,
    };
    res.redirect(req.get('referer') || '/calling/my');
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(req.get('referer') || '/calling/my');
  }
});

module.exports = router;

