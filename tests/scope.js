'use strict';

/* v3.8.2 — caller ko sirf apne assigned customers dikhein.
   Run: DATABASE_URL=... node tests/scope.js */

process.env.PORT = process.env.PORT || '3270';
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
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
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

const iso = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2600));
  const db = require('../src/db');
  const bcrypt = require('bcryptjs');

  // ---- do callers + 10 customers (5-5 assign) ----
  await db.query("DELETE FROM users WHERE login_id IN ('sc_a','sc_b')");
  const mk = async (name, login) => {
    const r = await db.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access)
       VALUES ($1,$2,$3,'admin',$4) RETURNING id`,
      [name, login, await bcrypt.hash('test1234', 10), ['mycalls', 'customers', 'priority']]
    );
    return r.rows[0].id;
  };
  const cA = await mk('Scope A', 'sc_a');
  const cB = await mk('Scope B', 'sc_b');

  const namesA = ['ScA1', 'ScA2', 'ScA3', 'ScA4', 'ScA5'];
  const namesB = ['ScB1', 'ScB2', 'ScB3', 'ScB4', 'ScB5'];
  const all = [...namesA, ...namesB, 'ScFree1', 'ScFree2'];

  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [all]);
  await db.query('DELETE FROM customers WHERE username = ANY($1::text[])', [all]);
  await db.query('DELETE FROM followups WHERE username = ANY($1::text[])', [all]);

  for (const u of all) {
    await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
       VALUES ($1,$2,'9000000001',500,'successful','test')`,
      [iso(20), u]
    );
  }
  await require('../src/lib/customers').syncCustomers();
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username = ANY($2::text[])', [cA, namesA]);
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username = ANY($2::text[])', [cB, namesB]);

  /* ---------- 1. caller A ka Customers page ---------- */
  await login('sc_a', 'test1234');
  const pageA = await req('/customers');
  check('caller /customers khulta hai', pageA.status === 200);

  const statA = pageA.text.match(/Total customers[\s\S]{0,120}?value[^>]*>([\d,]+)/);
  const totalShownA = statA ? Number(statA[1].replace(/,/g, '')) : -1;
  check('Total customers = 5 (sirf assigned)', totalShownA === 5, String(totalShownA));

  check('apne 5 customers dikhein', namesA.every((u) => pageA.text.includes(u)));
  check('doosre caller ke customers NAHI dikhein', namesB.every((u) => !pageA.text.includes(u)));
  check('bina caller wale bhi NAHI dikhein', !pageA.text.includes('ScFree1'));

  check('assign bar nahi (caller)', !/Poora filter assign karein/.test(pageA.text));
  check('caller filter dropdown nahi', !/name="caller"/.test(pageA.text));
  check('delete buttons nahi', !/Customer data delete/.test(pageA.text));

  /* ---------- 2. search bhi scoped ---------- */
  const searchB = await req('/customers?q=ScB');
  check('doosre ka customer search se bhi nahi', !searchB.text.includes('ScB1'));

  /* ---------- 3. doosre ka customer detail 403 ---------- */
  const other = await db.row("SELECT id, username FROM customers WHERE username='ScB1'");
  const detailB = await req('/customers/ScB1');
  check('doosre ka customer detail block (403)', detailB.status === 403, 'status ' + detailB.status);

  const own = await req('/customers/ScA1');
  check('apna customer detail khulta hai', own.status === 200 && /Deposit history/.test(own.text));
  check('detail par assign card nahi', !/Caller assign/.test(own.text));

  /* ---------- 4. assign/DNC/delete caller ke liye 403 ---------- */
  const tA = csrf(pageA.text);
  const tryAssign = await post('/customers/assign', { username: ['ScFree1'], caller_id: String(cA) }, tA);
  check('caller assign nahi kar sakta (403)', tryAssign.status === 403, 'status ' + tryAssign.status);

  const tryDnc = await post(`/customers/${other.id}/flags`, { do_not_contact: '1' }, tA);
  check('caller DNC nahi laga sakta (403)', tryDnc.status === 403, 'status ' + tryDnc.status);

  const tryDel = await post(`/customers/${other.id}/delete`, {}, tA);
  check('caller delete nahi kar sakta (403)', tryDel.status === 403, 'status ' + tryDel.status);

  const trySync = await post('/customers/sync', {}, tA);
  check('caller sync nahi kar sakta (403)', trySync.status === 403, 'status ' + trySync.status);

  /* ---------- 5. Calling List bhi scoped ---------- */
  const clA = await req('/calling?p=P2');
  check('Calling List me apne customers', namesA.every((u) => clA.text.includes(u)), 'P2 list');
  check('Calling List me doosre ka nahi', !clA.text.includes('ScB1'));
  check('Calling List par assign bar nahi', !/Chune hue customers ko/.test(clA.text));

  /* ---------- 6. Super Admin ko sab dikhe ---------- */
  await login('admin', 'admin123');
  const pageAdmin = await req('/customers');
  check('admin ko sab dikhein', ['ScA1', 'ScB1', 'ScFree1'].every((u) => pageAdmin.text.includes(u)));
  check('admin ko assign bar dikhe', /Poora filter assign karein/.test(pageAdmin.text));
  check('admin ko caller filter dikhe', /name="caller"/.test(pageAdmin.text));
  check('admin ko delete card dikhe', /Customer data delete/.test(pageAdmin.text));

  const detailAdmin = await req('/customers/ScB1');
  check('admin koi bhi customer khole', detailAdmin.status === 200);

  /* ---------- cleanup ---------- */
  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [all]);
  await db.query('DELETE FROM customers WHERE username = ANY($1::text[])', [all]);
  await db.query('DELETE FROM followups WHERE username = ANY($1::text[])', [all]);
  await db.query("DELETE FROM users WHERE login_id IN ('sc_a','sc_b')");

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

