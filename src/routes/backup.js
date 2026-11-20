'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const D = require('../lib/dates');

const router = express.Router();

router.use(auth.requireSuperAdmin);

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, header, rows) {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\ufeff' + header.map(csvCell).join(',') + '\n' + body + '\n');
}

router.get('/', async (req, res, next) => {
  try {
    const stats = await db.row(
      `SELECT (SELECT COUNT(*)::int FROM deposits) AS deposits,
              (SELECT COUNT(DISTINCT LOWER(username))::int FROM deposits) AS clients,
              (SELECT COUNT(*)::int FROM followups) AS followups,
              (SELECT COUNT(*)::int FROM users) AS users,
              (SELECT MIN(play_date)::text FROM deposits) AS first_date,
              (SELECT MAX(play_date)::text FROM deposits) AS last_date`
    );
    const days = await db.rows(
      `SELECT play_date::text AS d, COUNT(*)::int AS entries, COALESCE(SUM(amount),0)::float8 AS amount
         FROM deposits GROUP BY play_date ORDER BY play_date DESC LIMIT 20`
    );
    res.render('backup', { title: 'Backup & Export', page: 'backup', stats, days });
  } catch (err) {
    next(err);
  }
});

router.get('/export/:what', async (req, res, next) => {
  try {
    const what = req.params.what;

    if (what === 'deposits') {
      const rows = await db.rows(
        `SELECT play_date::text AS play_date, username, mobile, amount::float8 AS amount, created_at
           FROM deposits ORDER BY play_date, username`
      );
      await auth.audit(req, 'export', 'deposits');
      return sendCsv(
        res,
        `dp7-deposits-${D.todayISO()}.csv`,
        ['play_date', 'username', 'mobile', 'amount', 'created_at'],
        rows.map((r) => [r.play_date, r.username, r.mobile, r.amount, r.created_at])
      );
    }

    if (what === 'followups') {
      const rows = await db.rows(
        `SELECT f.action_date::text AS action_date, f.username, f.action_type, f.response,
                u.name AS by_name, f.created_at
           FROM followups f LEFT JOIN users u ON u.id = f.created_by
          ORDER BY f.action_date, f.id`
      );
      await auth.audit(req, 'export', 'followups');
      return sendCsv(
        res,
        `dp7-followups-${D.todayISO()}.csv`,
        ['action_date', 'username', 'action_type', 'response', 'by_name', 'created_at'],
        rows.map((r) => [r.action_date, r.username, r.action_type, r.response, r.by_name, r.created_at])
      );
    }

    if (what === 'clients') {
      const rows = await db.rows(
        `SELECT cs.username, cs.mobile, cs.total_deposited::float8 AS total, cs.deposit_count,
                cs.first_deposit::text AS first_deposit, cs.last_deposit::text AS last_deposit,
                COALESCE(l.name, 'No level') AS level
           FROM client_stats cs
           LEFT JOIN levels l ON l.id = client_level(cs.total_deposited)
          ORDER BY cs.total_deposited DESC`
      );
      await auth.audit(req, 'export', 'clients');
      return sendCsv(
        res,
        `dp7-clients-${D.todayISO()}.csv`,
        ['username', 'mobile', 'total_deposited', 'deposit_count', 'first_deposit', 'last_deposit', 'level'],
        rows.map((r) => [r.username, r.mobile, r.total, r.deposit_count, r.first_deposit, r.last_deposit, r.level])
      );
    }

    if (what === 'settings') {
      const cfg = await settings.all();
      const levels = await settings.levels();
      await auth.audit(req, 'export', 'settings');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dp7-settings-${D.todayISO()}.json"`);
      return res.send(JSON.stringify({ settings: cfg, levels }, null, 2));
    }

    res.status(404).send('Unknown export');
  } catch (err) {
    next(err);
  }
});

router.post('/delete-day', async (req, res, next) => {
  try {
    const playDate = req.body.play_date;
    const pin = String(req.body.pin || '').trim();
    const realPin = String(await settings.get('delete_pin', '969696'));
    if (!D.isDate(playDate) || pin !== realPin) {
      req.session.flash = { type: 'error', message: 'Date ya T-PIN galat hai.' };
      return res.redirect('/backup');
    }
    const out = await db.query('DELETE FROM deposits WHERE play_date = $1', [playDate]);
    await auth.audit(req, 'delete_day', `date=${playDate} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: `${playDate} ka data delete: ${out.rowCount} rows.` };
    res.redirect('/backup');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

