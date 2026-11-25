'use strict';

/* Asli file test — user ki aapki upload (username, AMOUNT, mobile number)
   Run: DATABASE_URL=... node tests/real-file.js <path-to-xlsx> */

process.env.PORT = process.env.PORT || '3222';
require('dotenv').config();

const fs = require('fs');
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
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location') };
}
const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];

async function upload(token, buffer, name, dry) {
  const fd = new FormData();
  fd.append('csrf_token', token);
  fd.append('dry', dry ? '1' : '0');
  fd.append('play_date', new Date().toISOString().slice(0, 10));
  fd.append('file', new Blob([buffer]), name);
  const res = await fetch(`${BASE}/upload/deposits`, { method: 'POST', headers: { cookie: ch() }, body: fd, redirect: 'manual' });
  absorb(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8') };
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  const file = process.argv[2] || '/tmp/.inputs/user-upload.xlsx';
  const buffer = fs.readFileSync(file);

  require('../src/server');
  await new Promise((r) => setTimeout(r, 2400));
  const db = require('../src/db');

  const lp = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp.text), login_id: 'admin', password: 'admin123' }).toString(),
  });
  const page = await req('/upload');
  const token = csrf(page.text);
  check('upload page', page.status === 200 && !!token);

  // saaf shuruaat
  await db.query("DELETE FROM deposits WHERE source = 'excel'");
  await db.query('DELETE FROM customers');
  await require('../src/lib/customers').syncCustomers();

  /* ---- 1. dry run ---- */
  const dry = await upload(token, buffer, 'user-upload.xlsx', true);
  check('dry run chala', dry.status === 200 && /Preview/.test(dry.text));
  const dryCount = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE source='excel'"));
  check('dry run me kuch insert nahi', dryCount === 0, String(dryCount));
  check('customer-wise hisaab dikha', /Is file ka hisaab/.test(dry.text));
  check('date column ki warning dikhi', /deposit date.*column nahi hai/.test(dry.text));

  /* ---- 2. asli upload ---- */
  const real = await upload(token, buffer, 'user-upload.xlsx', false);
  check('upload save', real.status === 200 && /rows save/.test(real.text));

  const total = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE source='excel'"));
  check('saari 1003 rows insert hui', total === 1003, String(total));

  /* ---- 3. Vijayst1: 53 rows, ₹10,94,905 ---- */
  const v = await db.row("SELECT * FROM customers WHERE LOWER(username)='vijayst1'");
  check('Vijayst1 count 53', v && v.deposit_count === 53, v ? String(v.deposit_count) : 'none');
  check('Vijayst1 total ₹10,94,905', v && Number(v.deposit_amount) === 1094905,
    v ? String(v.deposit_amount) : 'none');
  check('Vijayst1 53 rows se VIP nahi.. 53 = Premium VIP',
    v && v.vip_category === 'premium_vip', v ? v.vip_category : 'none');

  /* ---- 4. same-amount rows bhi gine (25,000 char baar) ---- */
  const same = await db.value(
    "SELECT COUNT(*)::int FROM deposits WHERE LOWER(username)='vijayst1' AND amount = 25000"
  );
  check('25,000 wali 4 rows sab insert hui', same === 4, String(same));

  /* ---- 5. doosre customers ---- */
  const top = await db.rows(
    `SELECT username, deposit_count, deposit_amount::float8 AS amt
       FROM customers ORDER BY deposit_count DESC LIMIT 3`
  );
  console.log('   top:', top.map((t) => `${t.username}=${t.deposit_count}/${t.amt}`).join(', '));
  check('top customer 104 rows (Vaibhav9819)',
    top[0] && top[0].username === 'Vaibhav9819' && top[0].deposit_count === 104,
    top[0] ? `${top[0].username} ${top[0].deposit_count}` : 'none');

  const stats = await db.row(
    `SELECT COUNT(*)::int AS users, SUM(deposit_count)::int AS cnt, SUM(deposit_amount)::float8 AS amt
       FROM customers`
  );
  check('94 customers bane', stats.users === 94, String(stats.users));
  check('total count 1003', stats.cnt === 1003, String(stats.cnt));

  /* ---- 6. wahi file dobara → block ---- */
  const again = await upload(token, buffer, 'user-upload.xlsx', false);
  check('wahi file dobara block hui', again.status === 409 && /pehle upload ho chuki hai/.test(again.text),
    'status ' + again.status);
  const after = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE source='excel'"));
  check('rows double nahi hui', after === 1003, String(after));

  /* ---- 7. level report me count aur total ---- */
  const lvl = await req('/reports/export?type=level');
  check('level report me Vijayst1', /Vijayst1/.test(lvl.text));
  const line = lvl.text.split('\n').find((l) => l.includes('Vijayst1')) || '';
  check('CSV me count 53 aur amount 1094905',
    line.includes('53') && line.includes('1094905'), line.slice(0, 120));

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

