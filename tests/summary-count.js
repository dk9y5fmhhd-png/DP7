'use strict';

/* v3.2 — summary row + deposit count column ka test.
   Run: DATABASE_URL=... node tests/summary-count.js */

process.env.PORT = process.env.PORT || '3218';
require('dotenv').config();

const ExcelJS = require('exceljs');
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
  return { status: res.status, text: buf.toString('utf8') };
}
const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];

async function uploadRows(token, rows, dry) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Deposits');
  rows.forEach((r) => ws.addRow(r));
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const fd = new FormData();
  fd.append('csrf_token', token);
  fd.append('dry', dry ? '1' : '0');
  fd.append('file', new Blob([buf]), 'deposits.xlsx');
  const res = await fetch(`${BASE}/upload/deposits`, { method: 'POST', headers: { cookie: ch() }, body: fd, redirect: 'manual' });
  absorb(res);
  return { status: res.status, text: await res.text() };
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
  const page = await req('/upload');
  const token = csrf(page.text);
  check('upload page', page.status === 200 && !!token);

  await db.query("DELETE FROM deposits WHERE username LIKE 'SumTest%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'SumTest%'");

  /* ---- 1. summary row with count = 25 → VIP ---- */
  const r1 = await uploadRows(token, [
    ['username', 'transaction id', 'deposit date', 'amount', 'status', 'deposit count'],
    ['SumTest01', '', '2026-04-30', 30000, 'successful', 25],
  ], false);
  check('summary upload', r1.status === 200 && /rows save/.test(r1.text));

  const c1 = await db.row("SELECT * FROM customers WHERE username='SumTest01'");
  check('summary row se count 25', c1 && c1.deposit_count === 25, c1 ? String(c1.deposit_count) : 'none');
  check('total amount 30000', c1 && Number(c1.deposit_amount) === 30000, c1 ? String(c1.deposit_amount) : 'none');
  check('25 → VIP', c1 && c1.vip_category === 'vip', c1 ? c1.vip_category : 'none');

  const raw = await db.row("SELECT txn_count FROM deposits WHERE username='SumTest01'");
  check('txn_count DB me 25', raw && raw.txn_count === 25, raw ? String(raw.txn_count) : 'none');

  /* ---- 2. count 1 hi ho to normal (amount bada hone se VIP nahi) ---- */
  await uploadRows(token, [
    ['username', 'transaction id', 'deposit date', 'amount', 'status'],
    ['SumTest02', '', '2026-04-30', 50000, 'successful'],
  ], false);
  const c2 = await db.row("SELECT * FROM customers WHERE username='SumTest02'");
  check('count khaali = 1', c2 && c2.deposit_count === 1, c2 ? String(c2.deposit_count) : 'none');
  check('₹50,000 par bhi normal (amount se VIP nahi)', c2 && c2.vip_category === 'normal', c2 ? c2.vip_category : 'none');

  /* ---- 3. 101 → high value vip ---- */
  await uploadRows(token, [
    ['username', 'transaction id', 'deposit date', 'amount', 'status', 'count'],
    ['SumTest03', '', '2026-04-30', 12000, 'successful', 101],
  ], false);
  const c3 = await db.row("SELECT * FROM customers WHERE username='SumTest03'");
  check('101 → high_value_vip', c3 && c3.vip_category === 'high_value_vip', c3 ? c3.vip_category : 'none');

  /* ---- 4. transaction-wise + summary mix ---- */
  await uploadRows(token, [
    ['username', 'transaction id', 'deposit date', 'amount', 'status', 'deposit count'],
    ['SumTest04', 'S4001', '2026-11-01', 500, 'successful', ''],
    ['SumTest04', 'S4002', '2026-11-05', 700, 'successful', ''],
    ['SumTest04', '', '2026-04-30', 20000, 'successful', 23],
  ], false);
  const c4 = await db.row("SELECT * FROM customers WHERE username='SumTest04'");
  check('mix: 2 rows + 23 = 25 → VIP', c4 && c4.deposit_count === 25 && c4.vip_category === 'vip',
    c4 ? `${c4.deposit_count} / ${c4.vip_category}` : 'none');
  check('mix total = 21200', c4 && Number(c4.deposit_amount) === 21200, c4 ? String(c4.deposit_amount) : 'none');

  /* ---- 5. Level Report ka count bhi txn_count se ---- */
  const lvl = await req('/reports/export?type=level');
  check('level report CSV me count 25', /SumTest01/.test(lvl.text));
  const stats = await db.value("SELECT deposit_count FROM client_stats WHERE username='SumTest01'");
  check('client_stats view count 25', Number(stats) === 25, String(stats));

  /* ---- 6. failed row count me nahi ---- */
  await uploadRows(token, [
    ['username', 'transaction id', 'deposit date', 'amount', 'status', 'deposit count'],
    ['SumTest05', '', '2026-04-30', 9999, 'failed', 50],
  ], false);
  const c5 = await db.row("SELECT * FROM customers WHERE username='SumTest05'");
  check('failed summary row ginа nahi', !c5 || c5.deposit_count === 0, c5 ? String(c5.deposit_count) : 'no record');

  /* ---- 7. duplicate: wahi summary row dobara → skip ---- */
  const dup = await uploadRows(token, [
    ['username', 'transaction id', 'deposit date', 'amount', 'status', 'deposit count'],
    ['SumTest01', '', '2026-04-30', 30000, 'successful', 25],
  ], false);
  check('wahi summary row duplicate → skip', /pehle se hai|skip/i.test(dup.text));
  const cntAfter = await db.value("SELECT COUNT(*)::int FROM deposits WHERE username='SumTest01'");
  check('rows 1 hi rahi', cntAfter === 1, String(cntAfter));

  /* ---- cleanup ---- */
  await db.query("DELETE FROM deposits WHERE username LIKE 'SumTest%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'SumTest%'");

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

