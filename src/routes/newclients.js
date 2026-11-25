'use strict';

// New Clients — mahine ke har din kitne naye clients aaye.
//
// "Naya client" = jiska pehla deposit us din hua.
// File me date column na ho to play_date = upload ki date, isliye jo file 1 tareekh
// ko upload hui wo 1 tareekh ke new clients banate hain.
//
// Window hamesha EK mahine ka hota hai — mahina badalte hi naya mahina shuru,
// pichhla mahina khud window se hat jata hai (uska data mit-ta nahi, bas dikhna band).

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const D = require('../lib/dates');

const router = express.Router();

const MONTHS_HI = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseMonth(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) return v;
  return D.todayISO().slice(0, 7);
}
function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${MONTHS_HI[Number(m) - 1]} ${y}`;
}
function shiftMonth(ym, dir) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + dir, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Kaunse din ka data hai — per-day new client count
async function dailyCounts(ym) {
  const rows = await db.rows(
    `SELECT first_deposit::text AS d, COUNT(*)::int AS c,
            COALESCE(SUM(deposit_amount), 0)::float8 AS amt
       FROM customers
      WHERE first_deposit >= $1::date
        AND first_deposit < ($1::date + INTERVAL '1 month')
      GROUP BY first_deposit
      ORDER BY first_deposit`,
    [ym + '-01']
  );
  const map = new Map();
  for (const r of rows) map.set(Number(r.d.slice(8, 10)), { count: Number(r.c), amount: Number(r.amt) });
  return map;
}

router.get('/', auth.requirePage('newclients'), async (req, res, next) => {
  try {
    const today = D.todayISO();
    const ym = parseMonth(req.query.m);
    const currentYm = today.slice(0, 7);
    const total = daysInMonth(ym);
    const day = req.query.d ? Math.min(Math.max(1, Number(req.query.d)), total) : null;

    const counts = await dailyCounts(ym);

    // Din ka grid — 1 se 31 (ya 30/28)
    const days = [];
    for (let i = 1; i <= total; i++) {
      const dateStr = `${ym}-${String(i).padStart(2, '0')}`;
      const c = counts.get(i) || { count: 0, amount: 0 };
      days.push({
        day: i,
        date: dateStr,
        count: c.count,
        amount: c.amount,
        isToday: dateStr === today,
        isFuture: dateStr > today,
      });
    }

    const monthTotal = days.reduce((a, d) => a + d.count, 0);
    const elapsed = days.filter((d) => !d.isFuture).length;
    const bestDay = days.reduce((a, d) => (d.count > (a ? a.count : -1) ? d : a), null);
    const maxCount = Math.max(1, ...days.map((d) => d.count));

    // Pichhla mahina — comparison ke liye
    const prevYm = shiftMonth(ym, -1);
    const prevTotal = Number(
      await db.value(
        `SELECT COUNT(*)::int FROM customers
          WHERE first_deposit >= $1::date AND first_deposit < ($1::date + INTERVAL '1 month')`,
        [prevYm + '-01']
      )
    );
    const prevCounts = await dailyCounts(prevYm);

    // Selected din ke clients
    let list = [];
    if (day) {
      const dateStr = `${ym}-${String(day).padStart(2, '0')}`;
      list = await db.rows(
        `SELECT c.username, c.mobile, c.deposit_count, c.deposit_amount, c.status,
                c.vip_category, c.assigned_to, u.name AS caller_name,
                lf.action_type AS last_remark, lf.follow_up_on,
                client_level(c.deposit_amount) AS level_id
           FROM customers c
           LEFT JOIN users u ON u.id = c.assigned_to
           LEFT JOIN latest_followup lf ON lf.uname = LOWER(c.username)
          WHERE c.first_deposit = $1::date
          ORDER BY c.deposit_amount DESC, c.username`,
        [dateStr]
      );
    }

    // Mahine ka top: kis din sabse zyada, aur kis din zero
    const zeroDays = days.filter((d) => !d.isFuture && d.count === 0).length;

    res.render('new_clients', {
      title: 'New Clients',
      page: 'newclients',
      ym,
      ymLabel: monthLabel(ym),
      isCurrent: ym === currentYm,
      prevYm,
      nextYm: shiftMonth(ym, 1),
      canGoNext: shiftMonth(ym, 1) <= currentYm,
      days,
      day,
      list,
      totals: {
        month: monthTotal,
        today: (counts.get(Number(today.slice(8, 10))) || { count: 0 }).count,
        yesterday: (counts.get(Number(D.addDays(today, -1).slice(8, 10))) || { count: 0 }).count,
        yesterdayLabel: D.prettyDate(D.addDays(today, -1)),
        avg: elapsed ? Math.round((monthTotal / elapsed) * 10) / 10 : 0,
        best: bestDay && bestDay.count ? bestDay : null,
        zeroDays,
        prev: prevTotal,
        delta: monthTotal - prevTotal,
      },
      prevCounts,
      maxCount,
      today,
      grid: days.map((d) => ({ ...d, pct: Math.round((d.count / maxCount) * 100) })),
      mask: (m) => {
        const full = req.session.user && req.session.user.role === 'super_admin';
        return require('../lib/customers').maskMobile(m, full);
      },
      isAdmin: req.session.user && req.session.user.role === 'super_admin',
    });
  } catch (err) {
    next(err);
  }
});

// CSV — sirf Super Admin
router.get('/export', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const ym = parseMonth(req.query.m);
    const rows = await db.rows(
      `SELECT username, mobile, first_deposit::text AS d, deposit_count,
              deposit_amount::float8 AS amt, status, vip_category
         FROM customers
        WHERE first_deposit >= $1::date AND first_deposit < ($1::date + INTERVAL '1 month')
        ORDER BY first_deposit, username`,
      [ym + '-01']
    );
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['date', 'username', 'mobile', 'deposits', 'total_amount', 'status', 'vip'];
    const body = rows.map((r) => [r.d, r.username, r.mobile, r.deposit_count, r.amt, r.status, r.vip_category].map(cell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="new-clients-${ym}.csv"`);
    res.send('\ufeff' + head.join(',') + '\n' + body.join('\n') + '\n');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

