'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const C = require('../lib/customers');
const telecmi = require('../lib/telecmi');
const access = require('../lib/access');
const D = require('../lib/dates');

const router = express.Router();

/* ------------------------------ click to call ------------------------------ */

router.post('/call', auth.requireLogin, async (req, res) => {
  const back = req.get('referer') || '/calling/my';
  let result;
  try {
    const username = String(req.body.username || '').trim();
    const customer = await access.ownCustomer(req.session.user, username);
    if (!customer) throw new Error('That customer is not assigned to you.');
    if (customer.do_not_contact) throw new Error('This customer is marked "Do Not Contact".');

    const out = await telecmi.dial({ customer, user: req.session.user });
    await auth.audit(req, 'call', `${customer.username} ok=${out.ok}`);
    result = out;
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  // The call pop-up asks for JSON and stays on the page.
  if (String(req.get('accept') || '').includes('application/json')) {
    return res.json({ ok: result.ok, message: res.locals._tm(result.message) });
  }
  req.session.flash = { type: result.ok ? 'success' : 'error', message: result.message };
  res.redirect(back);
});

/* ------------------------------ call log ------------------------------ */

router.get('/', auth.requirePage('calls'), async (req, res, next) => {
  try {
    const from = D.isDate(req.query.from) ? req.query.from : D.addDays(D.todayISO(), -30);
    const to = D.isDate(req.query.to) ? req.query.to : D.todayISO();
    const me = req.session.user;
    const admin = me.role === 'super_admin';

    // Non-admin sirf apni calls dekhta hai — doosre callers ki nahi
    const caller = admin && req.query.caller ? Number(req.query.caller) : null;

    const params = [from, to];
    let extra = '';
    if (admin) {
      if (caller) { params.push(caller); extra = ` AND k.caller_id = $${params.length}`; }
    } else {
      params.push(me.id);
      extra = ` AND k.caller_id = $${params.length}`;
    }

    const rows = await db.rows(
      `SELECT k.*, k.called_at::text AS called, u.name AS caller_name
         FROM calls k LEFT JOIN users u ON u.id = k.caller_id
        WHERE k.called_at::date BETWEEN $1 AND $2 ${extra}
        ORDER BY k.called_at DESC LIMIT 500`,
      params
    );

    const bcParams = admin ? [from, to] : [from, to, me.id];
    const byCaller = await db.rows(
      `SELECT u.name AS caller_name, COUNT(*)::int AS calls,
              COUNT(DISTINCT k.customer_id)::int AS customers,
              COALESCE(SUM(k.duration_sec),0)::int AS seconds
         FROM calls k LEFT JOIN users u ON u.id = k.caller_id
        WHERE k.called_at::date BETWEEN $1 AND $2
          ${admin ? '' : ' AND k.caller_id = $3'}
        GROUP BY u.name ORDER BY calls DESC`,
      bcParams
    );

    const cfg = { enabled: await telecmi.isEnabled() };

    res.render('calls', {
      title: 'Call Log',
      page: 'calls',
      rows, byCaller, cfg, isAdmin: admin,
      filters: { from, to, caller: caller || '' },
      callers: admin ? await db.rows("SELECT id, name FROM users ORDER BY name") : [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

