'use strict';

const express = require('express');
const db = require('../db');
const CAD = require('../lib/cadence');
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
    const today = D.todayISO();
    const me = req.session.user;
    const admin = me.role === 'super_admin';

    // caller ko poora master nahi — sirf apne assigned customers
    const caller = admin && req.query.caller ? Number(req.query.caller) : null;
    const onlyFree = admin && req.query.free === '1';

    const params = [priority];
    let extra = '';
    if (admin) {
      if (caller) { params.push(caller); extra += ` AND b.assigned_to = $${params.length}`; }
      if (onlyFree) extra += ' AND b.assigned_to IS NULL';
    } else {
      params.push(me.id);
      extra += ` AND b.assigned_to = $${params.length}`;
    }

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
         FROM customer_board b
        WHERE ${admin ? 'TRUE' : 'b.assigned_to = $1'}
        GROUP BY priority ORDER BY priority`,
      admin ? [] : [me.id]
    );

    res.render('priority', {
      title: 'Calling List',
      page: 'priority',
      rows: rows.map((r) => ({ ...r, mobile_shown: C.maskMobile(r.mobile, false) })),
      priority, counts: new Map(counts.map((c) => [c.priority, c])),
      filters: { caller: caller || '', free: onlyFree },
      isAdmin: admin,
      callers: admin ? await callerList() : [],
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

/* --------------------------- daily target --------------------------- */

const DEFAULT_TARGET = 40;

async function targetInfo(userId) {
  const target = Number(await db.value('SELECT daily_target FROM users WHERE id = $1', [userId]));
  const doneRow = await db.value(
    `SELECT customers FROM caller_daily_work
      WHERE caller_id = $1 AND work_date = CURRENT_DATE`,
    [userId]
  );
  const done = Number(doneRow || 0);
  // 0 = koi limit nahi (admin ne jaan-boojh ke off kiya)
  const t = Number.isFinite(target) && target >= 0 ? target : DEFAULT_TARGET;
  const unlimited = t === 0;
  return {
    target: t,
    done,
    unlimited,
    remaining: unlimited ? Infinity : Math.max(0, t - done),
    pct: unlimited ? 0 : Math.min(100, Math.round((done / t) * 100)),
    complete: !unlimited && done >= t,
  };
}

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
    const forceAll = req.query.full === '1'; // target poora hone par bhi poori list

    const base = mineCte();
    const tgt = await targetInfo(me);

    // List sirf baaki target jitni — target poora ho to koi row nahi
    const limit = showAll || forceAll || tgt.unlimited ? null : tgt.remaining;

    const rows = await db.rows(
      `${base}
       SELECT *,
              (next_touch_on IS NOT NULL AND next_touch_on < $2::date) AS is_overdue,
              ($2::date - next_touch_on) AS days_late,
              (next_touch_on IS NULL) AS never_scheduled
         FROM mine
        WHERE $3::boolean OR next_touch_on IS NULL OR next_touch_on <= $2::date
        ORDER BY
          -- overdue pehle
          CASE WHEN next_touch_on IS NOT NULL AND next_touch_on < $2::date THEN 0 ELSE 1 END,
          -- phir VIP (tier A), phir normal, phir dormant — target kam pade to
          -- VIP kabhi squeezed out na ho
          CASE cadence_tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END,
          next_touch_on ASC NULLS FIRST,
          deposit_count DESC, days_inactive ASC`,
      [me, today, showAll]
    );

    // Target ke hisaab se kaat do (baaki queue ka number batao)
    const queueCount = rows.length;
    const visibleRows = limit === null ? rows : rows.slice(0, limit);

    const stats = await db.row(
      `${base}
       SELECT
         COUNT(*) FILTER (WHERE next_touch_on IS NULL
                            OR next_touch_on = $2::date)::int   AS due,
         COUNT(*) FILTER (WHERE next_touch_on < $2::date)::int   AS overdue,
         COUNT(*) FILTER (WHERE next_touch_on > $2::date)::int   AS snoozed,
         COUNT(*) FILTER (WHERE priority = 'P1' AND (next_touch_on IS NULL OR next_touch_on <= $2::date))::int AS due_p1,
         COUNT(*) FILTER (WHERE cadence_tier = 'A' AND (next_touch_on IS NULL OR next_touch_on <= $2::date))::int AS due_a,
         COUNT(*) FILTER (WHERE cadence_tier = 'B' AND (next_touch_on IS NULL OR next_touch_on <= $2::date))::int AS due_b,
         COUNT(*) FILTER (WHERE cadence_tier = 'C' AND (next_touch_on IS NULL OR next_touch_on <= $2::date))::int AS due_c,
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
       SELECT username, next_touch_on, cadence_tier, last_remark, ($2::date - next_touch_on) AS in_days
         FROM mine
        WHERE next_touch_on > $2::date
        ORDER BY next_touch_on ASC LIMIT 12`,
      [me, today]
    );

    res.render('mycalls', {
      title: 'My Calls',
      page: 'mycalls',
      rows: visibleRows.map((r) => ({ ...r, mobile_shown: C.maskMobile(r.mobile, false) })),
      target: tgt,
      queueCount,
      stats, doneToday, upcoming,
      hiddenCount: queueCount - visibleRows.length,
      showAll, forceAll, today,
      remarks: R.REMARKS,
      quickDates: R.QUICK_DATES,
      tiers: CAD.TIERS,
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
      `SELECT u.id, u.name AS caller_name, u.daily_target,
              COALESCE(cdw.customers, 0)::int AS done_today,
              GREATEST(u.daily_target - COALESCE(cdw.customers, 0), 0)::int AS left_today,
              COUNT(*) FILTER (WHERE lf.follow_up_on IS NULL OR lf.follow_up_on = CURRENT_DATE)::int AS due,
              COUNT(*) FILTER (WHERE lf.follow_up_on IS NULL OR lf.follow_up_on <= CURRENT_DATE)::int AS pending,
              COUNT(*) FILTER (WHERE lf.follow_up_on < CURRENT_DATE)::int AS overdue,
              COUNT(*) FILTER (WHERE lf.follow_up_on > CURRENT_DATE)::int AS snoozed,
              COUNT(*)::int AS total
         FROM customer_board b
         JOIN users u ON u.id = b.assigned_to
         LEFT JOIN latest_followup lf ON lf.uname = LOWER(b.username)
         LEFT JOIN caller_daily_work cdw
                ON cdw.caller_id = u.id AND cdw.work_date = CURRENT_DATE
        WHERE b.do_not_contact = FALSE
        GROUP BY u.id, u.name, u.daily_target, cdw.customers
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
      done: perCaller.reduce((a, c) => a + c.done_today, 0),
      target: perCaller.reduce((a, c) => a + Number(c.daily_target || 0), 0),
      left: perCaller.reduce((a, c) => a + c.left_today, 0),
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

    // Cadence clock reset — remark save hote hi agla touch schedule ho jata hai
    const cad = await CAD.refreshOne(username).catch(() => null);

    await auth.audit(req, 'remark', `${username} → ${action} · fu=${followUpOn || 'none'} · tier=${cad ? cad.tier : '?'}`);
    const nextTouch = cad && cad.next;
    req.session.flash = {
      type: 'success',
      message: nextTouch
        ? `Remark save — ${username}: ${action}. Agla touch ${D.prettyDate(nextTouch)} (${D.relativeDays(nextTouch, date)}).`
        : `Remark save — ${username}: ${action}. Cycle se hata diya.`,
    };
    res.redirect(req.get('referer') || '/calling/my');
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(req.get('referer') || '/calling/my');
  }
});

module.exports = router;

