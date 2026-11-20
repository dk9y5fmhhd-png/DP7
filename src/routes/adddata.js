'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const D = require('../lib/dates');

const router = express.Router();

const SPLIT = /\s*[\t,;|]\s*|\s{2,}|\s+/;

function normaliseMobile(raw) {
  return String(raw || '').replace(/[^\d]/g, '');
}

function parseLine(line) {
  const parts = line.split(SPLIT).filter((p) => p !== '');
  if (!parts.length) return null;
  const username = String(parts[0] || '').trim();
  const mobile = normaliseMobile(parts[1] || '');
  let amount = 0;
  if (parts[2] !== undefined && parts[2] !== '') {
    amount = Number(String(parts[2]).replace(/[₹,\s]/g, ''));
  }
  return { username, mobile, amount: Number.isFinite(amount) ? amount : NaN };
}

function parseBulk(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  const errors = [];
  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parsed = parseLine(trimmed);
    if (!parsed) return;
    if (!parsed.username) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Username khaali hai' });
      return;
    }
    if (parsed.username.length > 60) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Username 60 characters se bada hai' });
      return;
    }
    if (!parsed.mobile || parsed.mobile.length < 6) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Mobile number galat ya missing hai' });
      return;
    }
    if (!Number.isFinite(parsed.amount) || parsed.amount < 0) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Amount galat hai' });
      return;
    }
    rows.push({ line: i + 1, username: parsed.username, mobile: parsed.mobile, amount: parsed.amount });
  });
  return { rows, errors };
}

async function recentDays() {
  return db.rows(
    `SELECT play_date::text AS d,
            COUNT(*)::int AS entries,
            COUNT(DISTINCT LOWER(username))::int AS clients,
            COALESCE(SUM(amount),0)::float8 AS amount
       FROM deposits
      GROUP BY play_date
      ORDER BY play_date DESC
      LIMIT 14`
  );
}

router.get('/', auth.requirePage('adddata'), async (req, res, next) => {
  try {
    const days = await recentDays();
    res.render('adddata', {
      title: 'Add Data',
      page: 'adddata',
      today: D.todayISO(),
      days,
      result: null,
      draft: '',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', auth.requirePage('adddata'), async (req, res, next) => {
  try {
    const playDate = D.isDate(req.body.play_date) ? req.body.play_date : D.todayISO();
    const draft = String(req.body.rows || '');
    const dryRun = req.body.dry === '1';
    const parsed = parseBulk(draft);

    if (!parsed.rows.length) {
      return res.status(400).render('adddata', {
        title: 'Add Data',
        page: 'adddata',
        today: playDate,
        days: await recentDays(),
        draft,
        result: {
          dryRun,
          playDate,
          inserted: 0,
          skipped: 0,
          errors: parsed.errors,
          empty: true,
        },
      });
    }

    let inserted = 0;
    let skipped = 0;

    if (!dryRun) {
      const usernames = parsed.rows.map((r) => r.username);
      const mobiles = parsed.rows.map((r) => r.mobile);
      const amounts = parsed.rows.map((r) => r.amount);

      const out = await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, created_by)
         SELECT $1::date, u, m, a, $5
           FROM UNNEST($2::text[], $3::text[], $4::numeric[]) AS t(u, m, a)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [playDate, usernames, mobiles, amounts, req.session.user.id]
      );
      inserted = out.rowCount;
      skipped = parsed.rows.length - inserted;
      await auth.audit(req, 'add_data', `date=${playDate} inserted=${inserted} skipped=${skipped}`);
    }

    res.render('adddata', {
      title: 'Add Data',
      page: 'adddata',
      today: playDate,
      days: await recentDays(),
      draft: dryRun ? draft : '',
      result: {
        dryRun,
        playDate,
        inserted,
        skipped,
        errors: parsed.errors,
        parsed: parsed.rows.slice(0, 200),
        totalRows: parsed.rows.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Poora din delete — T-PIN ke saath
router.post('/delete-day', auth.requirePage('adddata'), async (req, res, next) => {
  try {
    const playDate = req.body.play_date;
    const pin = String(req.body.pin || '').trim();
    const realPin = String(await settings.get('delete_pin', '969696'));

    if (!D.isDate(playDate)) {
      req.session.flash = { type: 'error', message: 'Date galat hai.' };
      return res.redirect('/add-data');
    }
    if (pin !== realPin) {
      req.session.flash = { type: 'error', message: 'T-PIN galat hai. Kuch delete nahi hua.' };
      return res.redirect('/add-data');
    }
    const out = await db.query('DELETE FROM deposits WHERE play_date = $1', [playDate]);
    await auth.audit(req, 'delete_day', `date=${playDate} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: `${playDate} ke ${out.rowCount} entries delete ho gaye.` };
    res.redirect('/add-data');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

