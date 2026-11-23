'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const C = require('../lib/customers');
const D = require('../lib/dates');

const router = express.Router();

const PER_PAGE = 100;

// caller/staff ko poora number nahi dikhta
function canSeeFullMobile(user) {
  return user && (user.role === 'super_admin' || (user.page_access || []).includes('all'));
}

async function callers() {
  return db.rows(
    `SELECT id, name, login_id, role FROM users
      WHERE role IN ('super_admin','admin') OR page_access && ARRAY['mycalls','all']
      ORDER BY name`
  );
}

/* ------------------------------ master list ------------------------------ */

router.get('/', auth.requirePage('customers'), async (req, res, next) => {
  try {
    const status = String(req.query.status || '');
    const vip = String(req.query.vip || '');
    const priority = String(req.query.priority || '');
    const caller = String(req.query.caller || '');
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const params = [];
    const conds = ['TRUE'];
    if (status) { params.push(status); conds.push(`b.status = $${params.length}`); }
    if (vip) { params.push(vip); conds.push(`b.vip_category = $${params.length}`); }
    if (priority) { params.push(priority); conds.push(`b.priority = $${params.length}`); }
    if (caller === 'none') { conds.push('b.assigned_to IS NULL'); }
    else if (caller) { params.push(Number(caller)); conds.push(`b.assigned_to = $${params.length}`); }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(b.username) LIKE $${params.length} OR b.mobile LIKE $${params.length})`);
    }
    const where = conds.join(' AND ');

    const totals = await db.row(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'new')::int AS new_c,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active_c,
              COUNT(*) FILTER (WHERE status = 'inactive')::int AS inactive_c,
              COUNT(*) FILTER (WHERE status = 'reactivated')::int AS reactivated_c,
              COUNT(*) FILTER (WHERE vip_category <> 'normal')::int AS vip_c,
              COUNT(*) FILTER (WHERE assigned_to IS NULL)::int AS unassigned
         FROM customer_board`
    );

    const count = Number(await db.value(`SELECT COUNT(*)::int FROM customer_board b WHERE ${where}`, params));
    const pages = Math.max(1, Math.ceil(count / PER_PAGE));
    const safe = Math.min(page, pages);

    const rows = await db.rows(
      `SELECT b.*, u.name AS caller_name,
              (SELECT action_type FROM followups f WHERE LOWER(f.username) = LOWER(b.username)
                ORDER BY f.action_date DESC, f.id DESC LIMIT 1) AS last_remark
         FROM customer_board b
         LEFT JOIN users u ON u.id = b.assigned_to
        WHERE ${where}
        ORDER BY
          CASE b.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 WHEN 'P0' THEN 5 ELSE 4 END,
          b.deposit_count DESC, b.username
        LIMIT ${PER_PAGE} OFFSET ${(safe - 1) * PER_PAGE}`,
      params
    );

    const full = canSeeFullMobile(req.session.user);
    const vipCounts = await db.rows(
      `SELECT vip_category, COUNT(*)::int AS c FROM customers GROUP BY vip_category`
    );

    res.render('customers', {
      title: 'Customers',
      page: 'customers',
      rows: rows.map((r) => ({ ...r, mobile_shown: C.maskMobile(r.mobile, full) })),
      totals, count, page: safe, pages,
      callers: await callers(),
      vipCounts: new Map(vipCounts.map((v) => [v.vip_category, v.c])),
      filters: { status, vip, priority, caller, q },
      labels: { STATUS_LABEL: C.STATUS_LABEL, VIP_LABEL: C.VIP_LABEL, PRIORITY_LABEL: C.PRIORITY_LABEL },
      canSeeFull: full,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ single customer ------------------------------ */

router.get('/:username', auth.requirePage('customers'), async (req, res, next) => {
  try {
    const c = await db.row(
      `SELECT b.*, u.name AS caller_name FROM customer_board b
         LEFT JOIN users u ON u.id = b.assigned_to
        WHERE LOWER(b.username) = LOWER($1)`,
      [req.params.username]
    );
    if (!c) return res.status(404).render('error', { title: 'Not found', heading: 'Customer nahi mila', message: 'Customers page se dobara try kijiye.' });

    const deposits = await db.rows(
      `SELECT id, play_date::text AS d, amount::float8 AS amount, status, txn_id, created_at
         FROM deposits WHERE LOWER(username) = LOWER($1)
        ORDER BY play_date DESC, id DESC LIMIT 20`,
      [c.username]
    );
    const remarks = await db.rows(
      `SELECT f.*, f.action_date::text AS action_date, u.name AS by_name
         FROM followups f LEFT JOIN users u ON u.id = f.created_by
        WHERE LOWER(f.username) = LOWER($1)
        ORDER BY f.action_date DESC, f.id DESC LIMIT 40`,
      [c.username]
    );
    const calls = await db.rows(
      `SELECT k.*, u.name AS caller_name FROM calls k
         LEFT JOIN users u ON u.id = k.caller_id
        WHERE LOWER(k.username) = LOWER($1)
        ORDER BY k.called_at DESC LIMIT 25`,
      [c.username]
    );

    res.render('customer_detail', {
      title: c.username,
      page: 'customers',
      c, deposits, remarks, calls,
      callers: await callers(),
      REMARKS: require('../lib/remarks').REMARKS,
      labels: { STATUS_LABEL: C.STATUS_LABEL, VIP_LABEL: C.VIP_LABEL, PRIORITY_LABEL: C.PRIORITY_LABEL },
      canSeeFull: canSeeFullMobile(req.session.user),
      mobileShown: C.maskMobile(c.mobile, canSeeFullMobile(req.session.user)),
      today: D.todayISO(),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ assign ------------------------------ */

router.post('/assign', auth.requirePage('customers'), async (req, res, next) => {
  try {
    const callerId = Number(req.body.caller_id) || null;
    const usernames = [].concat(req.body.username || []).filter(Boolean);
    const byFilter = req.body.assign_filter === '1';

    if (byFilter) {
      // filter ke hisaab se bulk assign
      const params = [];
      const conds = ['TRUE'];
      if (req.body.f_status) { params.push(req.body.f_status); conds.push(`status = $${params.length}`); }
      if (req.body.f_vip) { params.push(req.body.f_vip); conds.push(`vip_category = $${params.length}`); }
      if (req.body.f_priority) { params.push(req.body.f_priority); conds.push(`priority = $${params.length}`); }
      const where = conds.join(' AND ');

      const out = await db.query(
        `UPDATE customers SET assigned_to = $${params.length + 1}
          WHERE id IN (SELECT id FROM customer_board WHERE ${where})`,
        [...params, callerId]
      );
      await auth.audit(req, 'assign_bulk', `caller=${callerId} rows=${out.rowCount}`);
      req.session.flash = {
        type: 'success',
        message: out.rowCount + ' customers assign ho gaye.',
      };
      return res.redirect(req.get('referer') || '/customers');
    }

    if (!usernames.length) {
      req.session.flash = { type: 'error', message: 'Pehle customers chunein.' };
      return res.redirect(req.get('referer') || '/customers');
    }

    // ek customer sirf ek caller ke paas
    const out = await db.query(
      `UPDATE customers SET assigned_to = $1 WHERE LOWER(username) = ANY($2::text[])`,
      [callerId, usernames.map((u) => String(u).toLowerCase())]
    );
    await auth.audit(req, 'assign', `caller=${callerId} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: out.rowCount + ' customers assign ho gaye.' };
    res.redirect(req.get('referer') || '/customers');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/flags', auth.requirePage('customers'), async (req, res, next) => {
  try {
    const dnc = req.body.do_not_contact === '1';
    await db.query('UPDATE customers SET do_not_contact = $2 WHERE id = $1', [req.params.id, dnc]);
    await auth.audit(req, 'customer_flag', `id=${req.params.id} dnc=${dnc}`);
    req.session.flash = {
      type: 'success',
      message: dnc ? 'Customer "Do Not Contact" me daal diya.' : 'Customer ko dobara call list me daal diya.',
    };
    res.redirect(req.get('referer') || '/customers');
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ sync ------------------------------ */

router.post('/sync', auth.requirePage('customers'), async (req, res, next) => {
  try {
    const r = await C.syncCustomers();
    await auth.audit(req, 'customer_sync', JSON.stringify(r));
    req.session.flash = {
      type: 'success',
      message: `Sync ho gaya — ${r.total} customers, ${r.created} naye, ${r.updated} update, ${r.cleared} clear.`,
    };
    res.redirect('/customers');
  } catch (err) {
    next(err);
  }
});

module.exports = router;


