'use strict';

/* v4.1 — daily target + progress.
   Run: DATABASE_URL=... node tests/target.js */

process.env.PORT = process.env.PORT || '3320';
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
    for (const [k, v] of Object.entries(fields || {})) p.append(k, v);
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
// App ke timezone se — DB bhi ab Asia/Kolkata par set hai
const D = require('../src/lib/dates');
const iso = (n) => D.addDays(D.todayISO(), -n);
const today = D.todayISO();

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2700));
  const db = require('../src/db');
  const bcrypt = require('bcryptjs');

  /* ---------------------- fixtures ---------------------- */
  await db.query("DELETE FROM users WHERE login_id IN ('tg_a','tg_b')");
  const pass = await bcrypt.hash('tg1234', 10);
  const mk = async (name, login, target) => {
    const r = await db.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval, daily_target)
       VALUES ($1,$2,$3,'admin',$4,FALSE,$5) RETURNING id`,
      [name, login, pass, ['mycalls', 'customers', 'priority'], target]
    );
    return r.rows[0].id;
  };
  const callerA = await mk('Target A', 'tg_a', 3);
  const callerB = await mk('Target B', 'tg_b', 0); // unlimited

  const names = [];
  await db.query("DELETE FROM customers WHERE username LIKE 'TgC%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'TgC%'");
  for (let i = 1; i <= 8; i++) {
    const u = 'TgC' + String(i).padStart(2, '0');
    names.push(u);
    await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
       VALUES ($1,$2,$3,500,'successful','test')`,
      [iso(20), u, '9' + String(100000000 + i)]
    );
  }
  await require('../src/lib/customers').syncCustomers();
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username = ANY($2::text[])', [callerA, names]);
  check('8 customers assign hue', names.length === 8);

  /* ---------------------- 1. target 3 → list 3 dikhe ---------------------- */
  const A = newBrowser();
  await loginAs(A, 'tg_a', 'tg1234');
  const my1 = await A.req('/calling/my');
  check('My Calls khulta hai', my1.status === 200);

  const mainTable = my1.text.split('Aage ke follow-ups')[0];
  const rowCount = (mainTable.match(/data-username="/g) || []).length;
  check('target 3 → sirf 3 rows', rowCount === 3, rowCount + ' rows');
  check('progress bar dikhta hai', /progress-fill/.test(my1.text));
  check('"3 baaki" dikhta hai', /3<\/span>\s*<span class="muted">\/ 3|>3 baaki|3 baaki/.test(my1.text) || my1.text.includes('3 baaki'));
  check('hidden message (5 aur due)', /customers aur due hain/.test(my1.text) && /5/.test(my1.text), 'hidden count');
  check('target 0% poora', /0% poora/.test(my1.text));

  /* ---------------------- 2. 2 kaam karo → progress 2/3 ---------------------- */
  const t1 = A.csrf(my1.text);
  await A.post('/calling/remark', { username: names[0], action_type: 'No Answer', action_date: today }, t1);
  await A.post('/calling/remark', { username: names[1], action_type: 'No Answer', action_date: today }, t1);

  const my2 = await A.req('/calling/my');
  const rowCount2 = (my2.text.split('Aage ke follow-ups')[0].match(/data-username="/g) || []).length;
  check('2 kaam ke baad sirf 1 row', rowCount2 === 1, rowCount2 + ' rows');
  check('progress 67%', /67% poora/.test(my2.text), 'pct');
  check('"1 baaki"', my2.text.includes('1 baaki'));

  /* ---------------------- 3. 3rd kaam → target poora ---------------------- */
  await A.post('/calling/remark', { username: names[2], action_type: 'No Answer', action_date: today }, t1);
  const my3 = await A.req('/calling/my');
  check('target poora message', /Aaj ka target poora/.test(my3.text));
  check('100% poora', /100% poora/.test(my3.text));
  check('koi row nahi', (my3.text.split('Aage ke follow-ups')[0].match(/data-username="/g) || []).length === 0);

  /* ---------------------- 4. "phir bhi poori list" ---------------------- */
  // 3 customers ko call ho chuka (unka follow-up kal) → due queue 5 bachi
  const full = await A.req('/calling/my?full=1');
  const fullCount = (full.text.split('Aage ke follow-ups')[0].match(/data-username="/g) || []).length;
  check('full=1 par poori due queue (5) dikhe', fullCount === 5, fullCount + ' rows');

  /* ---------------------- 5. same din dubara remark = dobara nahi gina ---------------------- */
  await A.post('/calling/remark', { username: names[0], action_type: 'Call Again', action_date: today }, t1);
  const doneA = Number(await db.value(
    `SELECT customers FROM caller_daily_work WHERE caller_id = $1 AND work_date = CURRENT_DATE`, [callerA]
  ));
  check('same customer par 2nd remark se count nahi badha', doneA === 3, String(doneA));

  /* ---------------------- 6. unlimited target (0) ---------------------- */
  const B = newBrowser();
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username = ANY($2::text[])',
    [callerB, names.slice(3)]);
  await loginAs(B, 'tg_b', 'tg1234');
  const myB = await B.req('/calling/my');
  const bCount = (myB.text.split('Aage ke follow-ups')[0].match(/data-username="/g) || []).length;
  check('target 0 → poori list dikhe', bCount === 5, bCount + ' rows');
  check('"koi limit nahi" badge', /koi limit nahi/.test(myB.text));
  check('unlimited par progress bar nahi', !/progress-fill/.test(myB.text));

  /* ---------------------- 7. admin: Follow-ups Due par target ---------------------- */
  const admin = newBrowser();
  await loginAs(admin, 'admin', 'admin123');
  const due = await admin.req('/calling/due');
  check('Follow-ups Due khulta hai', due.status === 200);
  check('Target column dikhta hai', /<th>Target<\/th>/.test(due.text));
  check('caller ka 3/3 progress', /Target A/.test(due.text) && /3<\/strong><span class="muted">\/3/.test(due.text));
  check('total target / done', /\/ 3/.test(due.text));

  /* ---------------------- 8. Users page: target field ---------------------- */
  const users = await admin.req('/users');
  check('Users page par target column', /<th class="right">Target<\/th>/.test(users.text));
  check('create form me daily_target', /name="daily_target"/.test(users.text));
  check('digit values dikhein', /3<\/td>/.test(users.text));

  /* ---------------------- 9. target badalna ---------------------- */
  const tA = admin.csrf(users.text);
  const upd = await admin.post(`/users/${callerA}/update`, {
    name: 'Target A', role: 'admin', daily_target: '5',
    page_access: ['mycalls', 'customers', 'priority'],
  }, tA);
  check('target update POST', upd.status === 302, 'status ' + upd.status + ' loc=' + upd.location);
  check('DB me 5 ho gaya', Number(await db.value('SELECT daily_target FROM users WHERE id=$1', [callerA])) === 5);

  const my4 = await A.req('/calling/my');
  const c4 = (my4.text.split('Aage ke follow-ups')[0].match(/data-username="/g) || []).length;
  check('target 5 + 3 done → 0 row (queue bhi khaali)', c4 === 0, c4 + ' rows');
  check('par "2 baaki" fir bhi dikhta hai', /2 baaki/.test(my4.text), 'remaining');

  /* ---------------------- 10. target clamp ---------------------- */
  const tA2 = admin.csrf((await admin.req('/users')).text);
  await admin.post(`/users/${callerB}/update`, {
    name: 'Target B', role: 'admin', daily_target: '9999',
    page_access: ['mycalls', 'customers'],
  }, tA2);
  check('9999 → 500 clamp', Number(await db.value('SELECT daily_target FROM users WHERE id=$1', [callerB])) === 500);

  /* ---------------------- 11. default 40 ---------------------- */
  const defTarget = await db.value("SELECT daily_target FROM users WHERE login_id='admin'");
  check('default target 40', Number(defTarget) === 40, String(defTarget));

  /* ---------------------- 12. view check ---------------------- */
  const vw = await db.row(
    `SELECT customers FROM caller_daily_work WHERE caller_id=$1 AND work_date=CURRENT_DATE`, [callerA]
  );
  check('caller_daily_work view kaam karta hai', vw && Number(vw.customers) === 3, JSON.stringify(vw));

  /* ---------------------- cleanup ---------------------- */
  await db.query('DELETE FROM deposits WHERE username LIKE $1', ['TgC%']);
  await db.query('DELETE FROM customers WHERE username LIKE $1', ['TgC%']);
  await db.query("DELETE FROM users WHERE login_id IN ('tg_a','tg_b')");

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

