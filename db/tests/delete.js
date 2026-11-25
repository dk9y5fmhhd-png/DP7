'use strict';

/* Customer delete test — single, bulk, clear-all, stale dates.
   Run: DATABASE_URL=... node tests/delete.js */

process.env.PORT = process.env.PORT || '3220';
require('dotenv').config();

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let jar = new Map();

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
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}
const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];
async function post(path, fields, token) {
  const p = new URLSearchParams();
  p.append('csrf_token', token);
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  return req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() });
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2400));
  const db = require('../src/db');

  const lp = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp.text), login_id: 'admin', password: 'admin123' }).toString(),
  });
  const page = await req('/customers');
  const token = csrf(page.text);
  check('customers page', page.status === 200 && !!token);
  check('delete ka UI page par hai', /Customer data delete/.test(page.text) && /delOne/.test(page.text));

  // ---- fixtures ----
  const names = ['DelTest01', 'DelTest02', 'DelTest03', 'DelTest04'];
  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM customers WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM followups WHERE username = ANY($1::text[])', [names]);

  for (const u of names) {
    await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
       VALUES ('2026-11-20', $1, '9000000001', 500, 'successful', 'test')`, [u]
    );
  }
  const C = require('../src/lib/customers');
  await C.syncCustomers();
  const made = Number(await db.value('SELECT COUNT(*)::int FROM customers WHERE username = ANY($1::text[])', [names]));
  check('4 customers bane', made === 4, String(made));

  // remarks ek customer par
  await db.query(
    `INSERT INTO followups (username, action_type, action_date, response) VALUES ('DelTest01','No Answer','2026-11-20','x')`
  );

  // ---- 1. single delete ----
  const one = await db.row("SELECT id, username FROM customers WHERE username='DelTest01'");
  const d1 = await post(`/customers/${one.id}/delete`, { back: 'detail' }, token);
  check('single delete POST', d1.status === 302);
  const gone1 = await db.row("SELECT id FROM customers WHERE username='DelTest01'");
  check('DelTest01 master se hat gaya', !gone1);
  const rm1 = await db.value("SELECT COUNT(*)::int FROM followups WHERE username='DelTest01'");
  check('uske remarks bhi hate', rm1 === 0, String(rm1));
  const dep1 = await db.value("SELECT COUNT(*)::int FROM deposits WHERE username='DelTest01'");
  check('deposits row bachi rahi (alag cheez hai)', dep1 === 1, String(dep1));

  // ---- 2. bulk delete (do) ----
  const bulk = await post('/customers/delete-selected', {
    username: ['DelTest02', 'DelTest03'], confirm: 'DELETE',
  }, token);
  check('bulk delete POST', bulk.status === 302);
  const left = Number(await db.value('SELECT COUNT(*)::int FROM customers WHERE username = ANY($1::text[])', [['DelTest02', 'DelTest03']]));
  check('dono delete hue', left === 0, String(left));

  // ---- 3. galat confirm par kuch na ho ----
  const bad = await post('/customers/delete-selected', { username: ['DelTest04'], confirm: 'haan' }, token);
  const still = await db.value("SELECT COUNT(*)::int FROM customers WHERE username='DelTest04'");
  check('galat confirm par delete nahi', Number(still) === 1, String(still));

  // ---- 4. clear sirf customers ----
  const beforeDeposits = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE username LIKE 'DelTest%'"));
  const clearC = await post('/customers/clear', { scope: 'customers', confirm: 'DELETE' }, token);
  check('clear customers POST', clearC.status === 302);
  const custLeft = Number(await db.value("SELECT COUNT(*)::int FROM customers WHERE username LIKE 'DelTest%'"));
  check('sab customers saaf', custLeft === 0, String(custLeft));
  const depLeft = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE username LIKE 'DelTest%'"));
  check('deposits bache (sirf master delete)', depLeft === beforeDeposits, `${depLeft}`);

  // ---- 5. sync se dobara ban jayein ----
  await C.syncCustomers();
  const reborn = Number(await db.value("SELECT COUNT(*)::int FROM customers WHERE username LIKE 'DelTest%'"));
  check('sync par wapas ban gaye (expected)', reborn === 4, String(reborn));

  // ---- 6. clear all ----
  const clearAll = await post('/customers/clear', { scope: 'all', confirm: 'DELETE' }, token);
  check('clear all POST', clearAll.status === 302);
  const allCust = Number(await db.value("SELECT COUNT(*)::int FROM customers WHERE username LIKE 'DelTest%'"));
  const allDep = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE username LIKE 'DelTest%'"));
  check('customers gaye', allCust === 0, String(allCust));
  check('deposits bhi gaye', allDep === 0, String(allDep));

  // ---- 7. stale dates clear hote hain ----
  await db.query("DELETE FROM customers WHERE username='DelTest09'");
  await db.query("DELETE FROM deposits WHERE username='DelTest09'");
  await db.query(
    `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
     VALUES ('2026-04-30','DelTest09','9000000009',5000,'successful','test')`
  );
  await C.syncCustomers();
  const withDate = await db.row("SELECT last_deposit, deposit_count FROM customers WHERE username='DelTest09'");
  check('deposit ke saath last_deposit set', withDate && withDate.last_deposit === '2026-04-30', JSON.stringify(withDate));

  await db.query("DELETE FROM deposits WHERE username='DelTest09'");
  await C.syncCustomers();
  const noDate = await db.row("SELECT last_deposit, first_deposit, deposit_count, status FROM customers WHERE username='DelTest09'");
  check('deposit hatne par last_deposit NULL', noDate && noDate.last_deposit === null, JSON.stringify(noDate));
  check('count 0 aur status no_deposit', noDate && noDate.deposit_count === 0 && noDate.status === 'no_deposit', JSON.stringify(noDate));

  // ---- 7b. purani stale date repair (pehle se no_deposit) ----
  await db.query("DELETE FROM customers WHERE username='DelTest10'");
  await db.query(
    `INSERT INTO customers (username, mobile, status, deposit_count, deposit_amount, first_deposit, last_deposit)
     VALUES ('DelTest10','9000000010','no_deposit',0,0,'2026-04-30','2026-04-30')`
  );
  await C.syncCustomers();
  const repaired = await db.row("SELECT last_deposit, first_deposit FROM customers WHERE username='DelTest10'");
  check('purani chipki date sync se saaf hui',
    repaired && repaired.last_deposit === null && repaired.first_deposit === null, JSON.stringify(repaired));

  // ---- 8. restricted user delete nahi kar sakta ----
  await db.query("DELETE FROM users WHERE login_id='delstaff'");
  const bcrypt = require('bcryptjs');
  await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
     VALUES ('Del Staff','delstaff',$1,'admin',$2,FALSE)`,
    [await bcrypt.hash('test1234', 10), ['customers']]
  );
  jar = new Map();
  const lp2 = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp2.text), login_id: 'delstaff', password: 'test1234' }).toString(),
  });
  const page2 = await req('/customers');
  const t2 = csrf(page2.text);
  const target = await db.row('SELECT id FROM customers LIMIT 1');
  if (target) {
    const deny = await post(`/customers/${target.id}/delete`, {}, t2);
    check('staff delete nahi kar sakta (403)', deny.status === 403, 'status ' + deny.status);
  } else {
    check('staff delete test skip (koi customer nahi)', true);
  }
  await db.query("DELETE FROM users WHERE login_id='delstaff'");

  // ---- cleanup ----
  await db.query("DELETE FROM deposits WHERE username LIKE 'DelTest%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'DelTest%'");

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

