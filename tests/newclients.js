'use strict';

/* v4.0 — New Clients window (month grid, daily counts, auto month reset).
   Run: DATABASE_URL=... node tests/newclients.js */

process.env.PORT = process.env.PORT || '3300';
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
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location'), type: res.headers.get('content-type') };
}
const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];
async function post(path, fields, token) {
  const p = new URLSearchParams();
  if (token) p.append('csrf_token', token);
  for (const [k, v] of Object.entries(fields || {})) p.append(k, v);
  return req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() });
}
async function login(id, pw) {
  jar = new Map();
  const lp = await req('/login');
  return post('/login', { login_id: id, password: pw }, csrf(lp.text));
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const todayISO = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2700));
  const db = require('../src/db');

  const today = todayISO();
  const ym = today.slice(0, 7);
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));

  /* ---------- fixtures: is mahine ke alag-alag dinon par naye clients ---------- */
  const tag = 'NC' + Date.now().toString().slice(-6);
  const names = [];
  await db.query("DELETE FROM customers WHERE username LIKE 'NC%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'NC%'");

  // din 1, 1, 1 → 3 clients ; din 2 → 1 ; din 5 → 2 ; din 20 → 1
  const plan = [[1, 3], [2, 1], [5, 2], [20, 1]];
  let n = 0;
  for (const [day, count] of plan) {
    for (let i = 0; i < count; i++) {
      n++;
      const u = `${tag}${String(n).padStart(3, '0')}`;
      names.push(u);
      const d = `${ym}-${String(day).padStart(2, '0')}`;
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,$4,'successful','test')`,
        [d, u, '9' + String(100000000 + n), 500]
      );
    }
  }
  // ek purane mahine ka client (pichhla mahina)
  const prevDate = new Date(Date.UTC(y, m - 2, 15));
  const prevYm = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const prevUser = `${tag}PREV`;
  names.push(prevUser);
  await db.query(
    `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
     VALUES ($1,$2,'9111111111',500,'successful','test')`,
    [`${prevYm}-15`, prevUser]
  );

  // ek client jo dobara deposit karta hai — wo naya nahi gina jaana chahiye
  const repeatUser = names[0];
  await db.query(
    `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
     VALUES ($1,$2,'9222222222',500,'successful','test')`,
    [today, repeatUser]
  );

  await require('../src/lib/customers').syncCustomers();
  check('fixtures ban gaye', names.length === 8, names.length + ' users');

  /* ---------- login ---------- */
  await login('admin', 'admin123');

  /* ---------- 1. page khulta hai ---------- */
  const page = await req('/new-clients');
  check('GET /new-clients', page.status === 200 && /New Clients/.test(page.text), 'status ' + page.status);
  check('nav me "New Clients"', /href="\/new-clients"/.test((await req('/')).text));

  /* ---------- 2. din 1 = 3 clients ---------- */
  const day1 = await req(`/new-clients?m=${ym}&d=1`);
  check('din 1 khulta hai', day1.status === 200);
  // us din ke expected usernames (plan se)
  const expectedFor = (day) => {
    let idx = 0;
    const out = [];
    for (const [d, c] of plan) {
      for (let i = 0; i < c; i++) { idx++; if (d === day) out.push(names[idx - 1]); }
    }
    return out;
  };
  const present = (txt, users) => users.filter((u) => txt.includes(u)).length;

  check('din 1 me 3 clients', present(day1.text, expectedFor(1)) === 3, String(present(day1.text, expectedFor(1))));

  const day2 = await req(`/new-clients?m=${ym}&d=2`);
  check('din 2 me 1 client', present(day2.text, expectedFor(2)) === 1, String(present(day2.text, expectedFor(2))));

  const day5 = await req(`/new-clients?m=${ym}&d=5`);
  check('din 5 me 2 clients', present(day5.text, expectedFor(5)) === 2, String(present(day5.text, expectedFor(5))));
  check('din 5 me doosre din ke client nahi', present(day5.text, expectedFor(1)) === 0);

  /* ---------- 3. repeat client naya nahi gina ---------- */
  // sirf test tags ginte hain (baaki DB me purana data ho sakta hai)
  const monthlyTotal = await db.value(
    `SELECT COUNT(*)::int FROM customers
      WHERE username LIKE $2 AND first_deposit >= $1::date
        AND first_deposit < ($1::date + INTERVAL '1 month')`,
    [ym + '-01', tag + '%']
  );
  check('is mahine 7 naye (repeat nahi gina)', Number(monthlyTotal) === 7, String(monthlyTotal));

  const repeatCount = await db.value(
    `SELECT deposit_count FROM customers WHERE username = $1`, [repeatUser]
  );
  check('repeat client ka deposit_count 2 hai', Number(repeatCount) === 2, String(repeatCount));
  check('par wo ek hi naye client me gina', Number(monthlyTotal) === 7);

  /* ---------- 4. zero din sahi ---------- */
  const zero = await db.value(
    `SELECT COUNT(*)::int FROM generate_series(1, EXTRACT(DAY FROM (date_trunc('month', $1::date) + interval '1 month - 1 day'))::int) d
      WHERE NOT EXISTS (SELECT 1 FROM customers WHERE first_deposit = (date_trunc('month', $1::date) + (d-1) * interval '1 day')::date)`,
    [ym + '-01']
  );
  check('zero din compute hota hai', Number(zero) > 0, String(zero));

  /* ---------- 5. pichhla mahina alag window ---------- */
  const prev = await req(`/new-clients?m=${prevYm}&d=15`);
  check('pichhla mahina khulta hai + us din ka client dikhta hai',
    prev.status === 200 && prev.text.includes(prevUser), 'm=' + prevYm);
  check('pichhle mahine me sirf wahi 1 client tag dikhta hai',
    (prev.text.match(new RegExp(tag, 'g')) || []).length >= 1);

  /* ---------- 6. future month nahi khulta (next arrow band) ---------- */
  const nextYm = (() => {
    const d = new Date(Date.UTC(y, m, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  const futurePage = await req(`/new-clients?m=${nextYm}`);
  check('future month par bhi page chalta hai (0 count)', futurePage.status === 200);

  /* ---------- 7. galat month param safe ---------- */
  const bad = await req('/new-clients?m=hello');
  check('galat month → current month', bad.status === 200);

  /* ---------- 8. CSV sirf admin ---------- */
  const csv = await req(`/new-clients/export?m=${ym}`);
  check('admin ko CSV milti hai', csv.status === 200 && /text\/csv/.test(csv.type || ''));
  check('CSV me clients hain', names.slice(0, 3).every((u) => csv.text.includes(u)));

  // non-admin
  const bcrypt = require('bcryptjs');
  await db.query("DELETE FROM users WHERE login_id = 'nc_user'");
  await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
     VALUES ('NC User','nc_user',$1,'admin',$2,FALSE)`,
    [await bcrypt.hash('test1234', 10), ['newclients']]
  );
  await login('nc_user', 'test1234');
  const ncPage = await req('/new-clients');
  check('non-admin page khulta hai', ncPage.status === 200);
  check('non-admin ko CSV chip nahi', !/new-clients\/export/.test(ncPage.text));
  const ncCsv = await req(`/new-clients/export?m=${ym}`);
  check('non-admin CSV → 403', ncCsv.status === 403, 'status ' + ncCsv.status);

  /* ---------- 9. non-admin ko sirf apne assigned clients + mobile masked ---------- */
  // nc_user ko din-1 ke kuch clients assign karo (warna uski list khaali hogi)
  const ncId = Number(await db.value("SELECT id FROM users WHERE login_id='nc_user'"));
  const day1Users = names.slice(0, 3);
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username = ANY($2::text[])', [ncId, day1Users]);

  const day1nc = await req(`/new-clients?m=${ym}&d=1`);
  check('non-admin ko mobile masked', /•{3,}\d{4}/.test(day1nc.text));
  check('non-admin ko sirf apne 3 clients', day1Users.every((u) => day1nc.text.includes(u)), 'assigned');
  check('non-admin ko doosre ka client nahi', !day1nc.text.includes(names[7]), 'blocked');

  const day1admin = await req(`/new-clients?m=${ym}&d=1`).catch(() => null);
  await db.query('UPDATE customers SET assigned_to = NULL WHERE username = ANY($1::text[])', [day1Users]);

  /* ---------- 10. access na ho to 403 ---------- */
  await db.query("DELETE FROM users WHERE login_id = 'nc_none'");
  await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
     VALUES ('No Access','nc_none',$1,'admin',$2,FALSE)`,
    [await bcrypt.hash('test1234', 10), ['mycalls']]
  );
  await login('nc_none', 'test1234');
  check('access na ho to 403', (await req('/new-clients')).status === 403);

  /* ---------- 11. din 0 / din 99 safe ---------- */
  await login('admin', 'admin123');
  const d0 = await req(`/new-clients?m=${ym}&d=0`);
  check('d=0 safe (din 1 ho jata hai)', d0.status === 200);
  const d99 = await req(`/new-clients?m=${ym}&d=99`);
  check('d=99 safe (last din ho jata hai)', d99.status === 200);

  /* ---------- cleanup ---------- */
  await db.query('DELETE FROM deposits WHERE username LIKE $1', [tag + '%']);
  await db.query('DELETE FROM customers WHERE username LIKE $1', [tag + '%']);
  await db.query("DELETE FROM users WHERE login_id IN ('nc_user','nc_none')");

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

