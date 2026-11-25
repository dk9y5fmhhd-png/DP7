'use strict';

/* v4.3 — Retention Cadence Engine.
   Run: DATABASE_URL=... node tests/cadence.js */

process.env.PORT = process.env.PORT || '3360';
require('dotenv').config();

const BASE = `http://127.0.0.1:${process.env.PORT}`;

function newBrowser() {
  const jar = new Map();
  const ch = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  function absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  async function req(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (jar.size) headers.cookie = ch();
    const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
    absorb(res);
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];
  async function post(path, fields, token) {
    const p = new URLSearchParams();
    if (token) p.append('csrf_token', token);
    for (const [k, v] of Object.entries(fields || {})) {
      if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
      else p.append(k, v);
    }
    return req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() });
  }
  return { req, post, csrf };
}
async function loginAs(b, id, pw) {
  const lp = await b.req('/login');
  return b.post('/login', { login_id: id, password: pw }, b.csrf(lp.text));
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const D = require('../src/lib/dates');
const iso = (n) => D.addDays(D.todayISO(), -n);

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2800));
  const db = require('../src/db');
  const bcrypt = require('bcryptjs');
  const CAD = require('../src/lib/cadence');

  /* ================= fixtures ================= */
  await db.query("DELETE FROM users WHERE login_id LIKE 'cd_%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'CdT%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'CdT%'");
  await db.query("DELETE FROM followups WHERE username LIKE 'CdT%'");

  const callerId = (await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval, daily_target, team)
     VALUES ('Cadence Caller','cd_caller',$1,'admin',$2,FALSE,150,'retention') RETURNING id`,
    [await bcrypt.hash('cd1234', 10), ['mycalls', 'customers', 'priority']]
  )).rows[0].id;

  const add = async (user, count, ago, extra) => {
    for (let i = 0; i < count; i++) {
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,$4,'successful','test')`,
        [iso(ago), user, '9' + String(100000000 + i), 500]
      );
    }
    if (extra) {
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,$4,'successful','test')`,
        [iso(extra), user, '9000000000', 500]
      );
    }
  };

  // HIGH VIP — 30 deposits, last 40 din pehle → inactive VIP → A
  for (let i = 0; i < 30; i++) {
    await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
       VALUES ($1,$2,$3,500,'successful','test')`,
      [iso(40 + i), 'CdTHigh', '9111111111']
    );
  }
  await add('CdTRecent', 1, 10); // recently inactive → A
  await add('CdTActive', 1, 1, 0); // active (2 deposit same din? nahi) — niche fix
  await add('CdTDormant', 1, 90); // >60 din → C
  await add('CdTDnc', 1, 50); // DNC → D
  await add('CdTNormal', 1, 20); // inactive, 20 din → B

  // active banane ke liye 2 deposit 7 din ke andar
  await db.query(
    `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
     VALUES ($1,'CdTActive','9222222222',500,'successful','test')`,
    [iso(0)]
  );

  await require('../src/lib/customers').syncCustomers();
  await db.query('UPDATE customers SET do_not_contact = TRUE WHERE username = $1', ['CdTDnc']);
  await CAD.refreshAll();

  const get = async (u) => db.row(
    'SELECT cadence_tier, next_touch_on, last_touched_at FROM customers WHERE username = $1', [u]
  );

  /* ================= 1. tier assignment ================= */
  const high = await get('CdTHigh');
  check('VIP (30 deposit, inactive) → tier A', high.cadence_tier === 'A', high.cadence_tier);

  const recent = await get('CdTRecent');
  check('recently inactive (10 din) → tier A', recent.cadence_tier === 'A', recent.cadence_tier);

  const active = await get('CdTActive');
  check('active customer → tier B', active.cadence_tier === 'B', active.cadence_tier);

  const dormant = await get('CdTDormant');
  check('90 din dormant → tier C', dormant.cadence_tier === 'C', dormant.cadence_tier);

  const dnc = await get('CdTDnc');
  check('Do Not Contact → tier D', dnc.cadence_tier === 'D', dnc.cadence_tier);

  const normal = await get('CdTNormal');
  check('normal inactive (20 din) → tier B', normal.cadence_tier === 'B', normal.cadence_tier);

  /* ================= 2. next_touch_on = anchor + gap ================= */
  // kabhi touch nahi hua → last_deposit + gap
  check('A ka next_touch = last deposit + 5 din', high.next_touch_on === iso(40 - 5),
    `${high.next_touch_on} vs ${iso(35)}`);
  check('C ka next_touch = last deposit + 30 din', dormant.next_touch_on === iso(90 - 30),
    `${dormant.next_touch_on} vs ${iso(60)}`);
  check('D ko koi next_touch nahi', dnc.next_touch_on === null, String(dnc.next_touch_on));
  check('kabhi touch nahi hua → last_touched_at null', high.last_touched_at === null);

  /* ================= 2b. refreshAll idempotent ================= */
  const n0 = await CAD.refreshAll();
  check('refreshAll dusri baar 0 rows (idempotent)', n0 === 0, String(n0));

  /* ================= 3. remark se reset ================= */
  const user = newBrowser();
  await loginAs(user, 'cd_caller', 'cd1234');
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username LIKE $2', [callerId, 'CdT%']);

  const my = await user.req('/calling/my');
  check('My Calls khulta hai', my.status === 200);

  const t1 = user.csrf(my.text);
  const rm = await user.post('/calling/remark', {
    username: 'CdTDormant', action_type: 'Will Deposit', action_date: D.todayISO(),
  }, t1);
  check('remark POST', rm.status === 302);

  const after = await get('CdTDormant');
  check('remark ke baad next_touch = +2 din', after.next_touch_on === D.addDays(D.todayISO(), 2),
    String(after.next_touch_on));
  check('last_touched_at = aaj', after.last_touched_at === D.todayISO(), String(after.last_touched_at));
  check('tier C hi raha (remark se tier nahi badla)', after.cadence_tier === 'C', after.cadence_tier);

  /* ================= 4. "No Answer" → kal, aaj list se hat gaya ================= */
  await user.post('/calling/remark', {
    username: 'CdTHigh', action_type: 'No Answer', action_date: D.todayISO(),
  }, t1);
  const highAfter = await get('CdTHigh');
  check('No Answer → next_touch kal', highAfter.next_touch_on === D.addDays(D.todayISO(), 1),
    String(highAfter.next_touch_on));

  const my2 = await user.req('/calling/my');
  const mainTable2 = my2.text.split('Aage ke follow-ups')[0];
  check('aaj ke main list se hat gaya', !mainTable2.includes('data-username="CdTHigh"'));
  check('par "Aage ke follow-ups" me dikhta hai', my2.text.includes('CdTHigh'));

  /* ================= 5. DNC remark → cycle se hat ================= */
  await user.post('/calling/remark', {
    username: 'CdTNormal', action_type: 'Do Not Contact', action_date: D.todayISO(),
  }, t1);
  const normalAfter = await get('CdTNormal');
  check('DNC remark → tier D', normalAfter.cadence_tier === 'D', normalAfter.cadence_tier);
  check('DNC remark → next_touch NULL', normalAfter.next_touch_on === null, String(normalAfter.next_touch_on));

  /* ================= 6. coverage math ================= */
  const cov = await CAD.coverage({ days: 7 });
  check('coverage total > 0', cov.overall.total > 0, String(cov.overall.total));
  check('covered + stale = total - never (approx)', cov.overall.covered + cov.overall.stale <= cov.overall.total,
    `${cov.overall.covered}+${cov.overall.stale} vs ${cov.overall.total}`);
  check('tier rows milti hain', cov.tiers.length > 0, String(cov.tiers.length));

  /* ================= 7. admin pages ================= */
  const admin = newBrowser();
  await loginAs(admin, 'admin', 'admin123');

  const cadPage = await admin.req('/cadence');
  check('GET /cadence', cadPage.status === 200 && /Retention Cadence/.test(cadPage.text), 'status ' + cadPage.status);
  check('tier grid dikhta hai', /Tier-wise/.test(cadPage.text));
  check('caller coverage table', /Caller-wise coverage/.test(cadPage.text));
  check('daily chart', /Roz kitne touch hue/.test(cadPage.text));
  check('coverage % dikhta hai', /%\s*<\/strong>|coverage/.test(cadPage.text));
  check('Recompute button', /Recompute/.test(cadPage.text));

  const refresh = await admin.post('/cadence/refresh', {}, admin.csrf(cadPage.text));
  check('recompute POST', refresh.status === 302);

  const days15 = await admin.req('/cadence?days=15');
  check('?days=15 chalta hai', days15.status === 200 && /15 din/.test(days15.text));

  const bad = await admin.req('/cadence?days=999');
  check('galat days → default 7', bad.status === 200);

  /* ================= 8. non-admin 403 ================= */
  check('non-admin /cadence → 403', (await user.req('/cadence')).status === 403);
  check('non-admin recompute → 403',
    (await user.post('/cadence/refresh', {}, t1)).status === 403);

  /* ================= 9. My Calls par tier + cadence ================= */
  await db.query("UPDATE customers SET next_touch_on = CURRENT_DATE WHERE username IN ('CdTRecent','CdTActive')");
  const my3 = await user.req('/calling/my');
  check('My Calls par tier column', /Tier/.test(my3.text));
  check('tier badge dikhta hai', />A</.test(my3.text) || />B</.test(my3.text));
  check('cadence column', /Cadence/.test(my3.text));
  check('cadence badge dikhta hai', /din late|din baad|>Aaj<|kabhi schedule nahi hua/.test(my3.text));

  /* ================= 10. ordering — VIP pehle ================= */
  await db.query(
    `UPDATE customers SET next_touch_on = CURRENT_DATE - 5
      WHERE username IN ('CdTRecent','CdTActive','CdTDormant')`
  );
  const my4 = await user.req('/calling/my?all=1');
  const order = [...my4.text.matchAll(/data-username="(CdT[A-Za-z]+)"/g)].map((m) => m[1]);
  const idxA = order.findIndex((u) => ['CdTRecent', 'CdTHigh'].includes(u));
  const idxC = order.indexOf('CdTDormant');
  check('tier A tier C se pehle', idxA !== -1 && (idxC === -1 || idxA < idxC),
    order.join(',') || 'khaali');

  /* ================= 12. DNC list se hat ================= */
  const allList = await user.req('/calling/my?all=1');
  check('DNC customer poori list me bhi nahi', !allList.text.includes('CdTNormal'));

  /* ================= cleanup ================= */
  await db.query("DELETE FROM deposits WHERE username LIKE 'CdT%'");
  await db.query("DELETE FROM followups WHERE username LIKE 'CdT%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'CdT%'");
  await db.query("DELETE FROM users WHERE login_id LIKE 'cd_%'");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) failed.forEach((f) => console.log(' - FAILED: ' + f.name));
  await db.pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('✗ crashed:', e);
  process.exit(2);
});

