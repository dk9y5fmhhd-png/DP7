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

// Super Admin sab dekhta hai (assign/DNC/delete bhi usi ke haath me).
// Baaki har user (caller) sirf apne assigned customers dekhta hai.
function isAdminUser(user) {
  return user && user.role === 'super_admin';
}
function ownScopeSql(user, params) {
  if (isAdminUser(user)) return 'TRUE';
  params.push(user.id);
  return `b.assigned_to = $${params.length}`;
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

    const me = req.session.user;
    const admin = isAdminUser(me);

    const params = [];
    // caller ke liye base scope = sirf uske assigned customers
    const conds = [ownScopeSql(me, params)];
    if (status) { params.push(status); conds.push(`b.status = $${params.length}`); }
    if (vip) { params.push(vip); conds.push(`b.vip_category = $${params.length}`); }
    if (priority) { params.push(priority); conds.push(`b.priority = $${params.length}`); }
    if (admin) {
      if (caller === 'none') { conds.push('b.assigned_to IS NULL'); }
      else if (caller) { params.push(Number(caller)); conds.push(`b.assigned_to = $${params.length}`); }
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(b.username) LIKE $${params.length} OR b.mobile LIKE $${params.length})`);
    }
    const where = conds.join(' AND ');

    // Stats bhi wahi scope — caller ko sirf apne numbers dikhte hain
    const totals = await db.row(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'new')::int AS new_c,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active_c,
              COUNT(*) FILTER (WHERE status = 'inactive')::int AS inactive_c,
              COUNT(*) FILTER (WHERE status = 'reactivated')::int AS reactivated_c,
              COUNT(*) FILTER (WHERE vip_category <> 'normal')::int AS vip_c,
              COUNT(*) FILTER (WHERE assigned_to IS NULL)::int AS unassigned
         FROM customer_board b
        WHERE ${ownScopeSql(me, [])}`,
      admin ? [] : [me.id]
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
      `SELECT vip_category, COUNT(*)::int AS c FROM customer_board b
        WHERE ${ownScopeSql(me, [])} GROUP BY vip_category`,
      admin ? [] : [me.id]
    );

    res.render('customers', {
      title: 'Customers',
      page: 'customers',
      rows: rows.map((r) => ({ ...r, mobile_shown: C.maskMobile(r.mobile, full) })),
      totals, count, page: safe, pages,
      callers: admin ? await callers() : [],
      isAdmin: admin,
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
    const me = req.session.user;
    const admin = isAdminUser(me);

    const c = await db.row(
      `SELECT b.*, u.name AS caller_name FROM customer_board b
         LEFT JOIN users u ON u.id = b.assigned_to
        WHERE LOWER(b.username) = LOWER($1)`,
      [req.params.username]
    );
    if (!c) return res.status(404).render('error', { title: 'Not found', heading: 'Customer not found', message: 'Try again from the Customers page.' });

    // caller kisi doosre ka customer na khole
    if (!admin && c.assigned_to !== me.id) {
      return res.status(403).render('error', {
        title: 'Access denied',
        heading: 'This customer is not yours',
        message: 'You can only see customers assigned to you. Ask your admin.',
      });
    }

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
      isAdmin: admin,
      callers: admin ? await callers() : [],
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

// Bulk assign ka WHERE — wahi filter jo list page par laga hua hai.
// Pehle ye filters view se aate hi nahi the, isliye WHERE 'TRUE' ban jata tha
// aur "Poora filter assign" SAARE customers par chal jata tha — sab ek caller
// ke paas. Ab har filter explicitly aata hai.
function bulkWhere(body, params) {
  const conds = [];
  if (body.f_status) { params.push(body.f_status); conds.push(`b.status = $${params.length}`); }
  if (body.f_vip) { params.push(body.f_vip); conds.push(`b.vip_category = $${params.length}`); }
  if (body.f_priority) { params.push(body.f_priority); conds.push(`b.priority = $${params.length}`); }
  if (body.f_caller === 'none') conds.push('b.assigned_to IS NULL');
  else if (body.f_caller) { params.push(Number(body.f_caller)); conds.push(`b.assigned_to = $${params.length}`); }
  if (body.f_q) {
    params.push(`%${String(body.f_q).toLowerCase()}%`);
    conds.push(`(LOWER(b.username) LIKE $${params.length} OR b.mobile LIKE $${params.length})`);
  }
  return conds.length ? conds.join(' AND ') : 'TRUE';
}

router.post('/assign', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const unassign = req.body.unassign === '1';
    const rawCaller = String(req.body.caller_id || '').trim();
    const chosen = Number(rawCaller);
    const callerId = unassign ? null : (Number.isFinite(chosen) && chosen > 0 ? chosen : null);
    const usernames = [].concat(req.body.username || []).filter(Boolean);
    const byFilter = req.body.assign_filter === '1' || unassign;
    const back = req.get('referer') || '/customers';

    // Assign karna hai par koi caller chuna hi nahi
    if (!unassign && callerId === null) {
      req.session.flash = {
        type: 'error',
        message: 'Choose a caller first. To remove a caller use "Clear caller".',
      };
      return res.redirect(back);
    }

    if (byFilter) {
      const params = [];
      const where = bulkWhere(req.body, params);

      const total = Number(
        await db.value(`SELECT COUNT(*)::int FROM customer_board b WHERE ${where}`, params)
      );
      if (!total) {
        req.session.flash = { type: 'error', message: 'No customer matches this filter.' };
        return res.redirect(back);
      }

      // Safety: koi filter hi nahi laga → saare customers badal jayenge
      if (where === 'TRUE' && req.body.confirm_all !== '1') {
        req.session.flash = {
          type: 'error',
          message: `No filter set — this would apply to ALL ${total} customers. Set a filter first.`,
        };
        return res.redirect(back);
      }

      const out = await db.query(
        `UPDATE customers SET assigned_to = $${params.length + 1}
          WHERE id IN (SELECT b.id FROM customer_board b WHERE ${where})`,
        [...params, callerId]
      );
      await auth.audit(req, 'assign_bulk',
        `${unassign ? 'unassign' : 'caller=' + callerId} where=${where} rows=${out.rowCount}`);
      req.session.flash = {
        type: 'success',
        message: unassign
          ? `${out.rowCount} customers no longer have a caller (now unassigned).`
          : `${out.rowCount} customers assigned.`,
      };
      return res.redirect(back);
    }

    if (!usernames.length) {
      req.session.flash = { type: 'error', message: 'Choose customers first.' };
      return res.redirect(req.get('referer') || '/customers');
    }

    // ek customer sirf ek caller ke paas
    const out = await db.query(
      `UPDATE customers SET assigned_to = $1 WHERE LOWER(username) = ANY($2::text[])`,
      [callerId, usernames.map((u) => String(u).toLowerCase())]
    );
    await auth.audit(req, 'assign', `caller=${callerId} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: `${out.rowCount} customers assigned.` };
    res.redirect(req.get('referer') || '/customers');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/flags', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const dnc = req.body.do_not_contact === '1';
    await db.query('UPDATE customers SET do_not_contact = $2 WHERE id = $1', [req.params.id, dnc]);
    await auth.audit(req, 'customer_flag', `id=${req.params.id} dnc=${dnc}`);
    req.session.flash = {
      type: 'success',
      message: dnc ? 'Customer marked "Do Not Contact".' : 'Customer put back in the call list.',
    };
    res.redirect(req.get('referer') || '/customers');
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ sync ------------------------------ */

/* ------------------------------ delete ------------------------------ */

// Ek customer delete (uske remarks aur calls bhi saath jaate hain)
router.post('/:id/delete', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const c = await db.row('SELECT id, username FROM customers WHERE id = $1', [req.params.id]);
    if (!c) {
      req.session.flash = { type: 'error', message: 'Customer not found.' };
      return res.redirect('/customers');
    }
    await db.query('DELETE FROM customers WHERE id = $1', [c.id]);
    await db.query('DELETE FROM followups WHERE LOWER(username) = LOWER($1)', [c.username]);
    await auth.audit(req, 'customer_delete', c.username);
    req.session.flash = { type: 'success', message: `Customer "${c.username}" deleted (remarks and calls too).` };
    res.redirect(req.body.back === 'detail' ? '/customers' : (req.get('referer') || '/customers'));
  } catch (err) {
    next(err);
  }
});

// Chune hue customers delete
router.post('/delete-selected', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      req.session.flash = { type: 'error', message: 'Type DELETE in the confirm box — nothing was deleted.' };
      return res.redirect(req.get('referer') || '/customers');
    }

    const usernames = [].concat(req.body.username || []).filter(Boolean);
    if (!usernames.length) {
      req.session.flash = { type: 'error', message: 'Tick the customer checkboxes first.' };
      return res.redirect(req.get('referer') || '/customers');
    }

    const list = usernames.map((u) => String(u).toLowerCase());
    const out = await db.query('DELETE FROM customers WHERE LOWER(username) = ANY($1::text[])', [list]);
    await db.query('DELETE FROM followups WHERE LOWER(username) = ANY($1::text[])', [list]);
    await auth.audit(req, 'customer_delete_selected', `${out.rowCount} rows`);
    req.session.flash = {
      type: 'success',
      message: `${out.rowCount} customers deleted (with their remarks).`,
    };
    res.redirect('/customers');
  } catch (err) {
    next(err);
  }
});

// Poora customer master khaali — deposits bhi (kyunki sync dobara bana dega)
router.post('/clear', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      req.session.flash = { type: 'error', message: 'Type DELETE in the confirm box — nothing was deleted.' };
      return res.redirect('/customers');
    }

    const scope = req.body.scope === 'all' ? 'all' : 'customers';
    let customers = 0;
    let deposits = 0;

    if (scope === 'all') {
      // Sab kuch: deposits, customers, remarks, calls
      deposits = (await db.query('DELETE FROM deposits')).rowCount;
      await db.query('DELETE FROM followups');
      await db.query('DELETE FROM calls');
      customers = (await db.query('DELETE FROM customers')).rowCount;
    } else {
      // Sirf customer master (deposits ko chheda nahi — par sync dobara bana dega)
      await db.query('DELETE FROM followups');
      await db.query('DELETE FROM calls');
      customers = (await db.query('DELETE FROM customers')).rowCount;
    }

    await auth.audit(req, 'customer_clear', `scope=${scope} customers=${customers} deposits=${deposits}`);
    req.session.flash = {
      type: 'success',
      message: scope === 'all'
        ? `All clear — ${customers} customers and ${deposits} deposits deleted.`
        : `${customers} customers deleted. (Deposits are kept — pressing "Sync from deposits" rebuilds them.)`,
    };
    res.redirect('/customers');
  } catch (err) {
    next(err);
  }
});

router.post('/sync', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const r = await C.syncCustomers();
    await auth.audit(req, 'customer_sync', JSON.stringify(r));
    req.session.flash = {
      type: 'success',
      message: `Synced — ${r.total} customers, ${r.created} new, ${r.updated} updated, ${r.cleared} cleared.`,
    };
    res.redirect('/customers');
  } catch (err) {
    next(err);
  }
});

module.exports = router;



