'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const C = require('../lib/customers');
const telecmi = require('../lib/telecmi');
const D = require('../lib/dates');

const router = express.Router();

/* ------------------------------ click to call ------------------------------ */

router.post('/call', auth.requireLogin, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const c = await db.row(
      'SELECT * FROM customers WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (!c) throw new Error('Customer nahi mila.');

    if (c.do_not_contact) throw new Error('Is customer ko "Do Not Contact" mark kiya hua hai.');

    const out = await telecmi.clickToCall({ customer: c, callerId: req.session.user.id });
    await auth.audit(req, 'call', `${username} provider=${out.provider} ok=${out.ok}`);

    if (!out.ok) {
      req.session.flash = { type: 'error', message: out.message };
      return res.redirect(req.get('referer') || '/calling/my');
    }

    req.session.flash = {
      type: 'success',
      message: out.message + (out.dial ? ` Number: ${out.dial}` : ''),
    };
    // click-to-call ke baad seedha remark form kholne ke liye customer wapas
    res.redirect((req.get('referer') || '/calling/my') + (req.get('referer') ? '' : ''));
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(req.get('referer') || '/calling/my');
  }
});

/* ------------------------------ call log ------------------------------ */

router.get('/', auth.requirePage('calls'), async (req, res, next) => {
  try {
    const from = D.isDate(req.query.from) ? req.query.from : D.addDays(D.todayISO(), -30);
    const to = D.isDate(req.query.to) ? req.query.to : D.todayISO();
    const caller = req.query.caller ? Number(req.query.caller) : null;

    const params = [from, to];
    let extra = '';
    if (caller) { params.push(caller); extra = ` AND k.caller_id = $${params.length}`; }

    const rows = await db.rows(
      `SELECT k.*, k.called_at::text AS called, u.name AS caller_name
         FROM calls k LEFT JOIN users u ON u.id = k.caller_id
        WHERE k.called_at::date BETWEEN $1 AND $2 ${extra}
        ORDER BY k.called_at DESC LIMIT 500`,
      params
    );

    const byCaller = await db.rows(
      `SELECT u.name AS caller_name, COUNT(*)::int AS calls,
              COUNT(DISTINCT k.customer_id)::int AS customers,
              COALESCE(SUM(k.duration_sec),0)::int AS seconds
         FROM calls k LEFT JOIN users u ON u.id = k.caller_id
        WHERE k.called_at::date BETWEEN $1 AND $2
        GROUP BY u.name ORDER BY calls DESC`,
      [from, to]
    );

    const cfg = await telecmi.config();

    res.render('calls', {
      title: 'Call Log',
      page: 'calls',
      rows, byCaller, cfg,
      filters: { from, to, caller: caller || '' },
      callers: await db.rows("SELECT id, name FROM users ORDER BY name"),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

