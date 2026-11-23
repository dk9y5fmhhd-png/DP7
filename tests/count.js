'use strict';

/* Deposit count test — ek hi din ki kai deposits, VIP by count, manual dedupe.
   Run: DATABASE_URL=... node tests/count.js */

process.env.PORT = process.env.PORT || '3216';
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
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}
const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];

async function uploadDeposits(token, rows, dry) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Deposits');
  ws.addRow(['username', 'transaction id', 'deposit date', 'amount', 'status']);
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

const D = '2026-11-20';
const D2 = '2026-11-21';

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
  check('upload page khulta hai', page.status === 200 && !!token);

  await db.query("DELETE FROM deposits WHERE username LIKE 'CntTest%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'CntTest%'");

  /* ---- 1. ek hi din me 3 deposits → count 3 ---- */
  const r1 = await uploadDeposits(token, [
    ['CntTest01', 'CNT001', D, 500, 'successful'],
    ['CntTest01', 'CNT002', D, 700, 'successful'],
    ['CntTest01', 'CNT003', D, 300, 'successful'],
  ], false);
  check('upload chala', r1.status === 200 && /rows save/.test(r1.text));

  const rows = await db.value("SELECT COUNT(*)::int FROM deposits WHERE username='CntTest01'");
  check('ek hi din ki 3 deposits = 3 rows', rows === 3, String(rows));

  const cust = await db.row("SELECT * FROM customers WHERE username='CntTest01'");
  check('deposit_count = 3', cust && cust.deposit_count === 3, cust ? String(cust.deposit_count) : 'none');
  check('total = 1500', cust && Number(cust.deposit_amount) === 1500, cust ? String(cust.deposit_amount) : 'none');

  /* ---- 2. same file dobara → txn duplicate reject (count wahi rahe) ---- */
  const r2 = await uploadDeposits(token, [
    ['CntTest01', 'CNT001', D, 500, 'successful'],
  ], false);
  check('duplicate txn reject', /Duplicate transaction ID/.test(r2.text));
  const rows2 = await db.value("SELECT COUNT(*)::int FROM deposits WHERE username='CntTest01'");
  check('count 3 hi raha', rows2 === 3, String(rows2));

  /* ---- 3. 25 deposits se VIP ---- */
  const many = [];
  for (let i = 0; i < 22; i++) {
    many.push(['CntTest02', 'VIP' + String(i).padStart(3, '0'), i % 2 ? D : D2, 100, 'successful']);
  }
  await uploadDeposits(token, many, false);
  const vipCust = await db.row("SELECT * FROM customers WHERE username='CntTest02'");
  check('22 rows se count 22', vipCust && vipCust.deposit_count === 22, vipCust ? String(vipCust.deposit_count) : 'none');
  check('22 par VIP nahi', vipCust && vipCust.vip_category === 'normal', vipCust ? vipCust.vip_category : 'none');

  // 3 aur add → 25 → VIP
  await uploadDeposits(token, [
    ['CntTest02', 'VIP100', D, 100, 'successful'],
    ['CntTest02', 'VIP101', D2, 100, 'successful'],
    ['CntTest02', 'VIP102', D, 100, 'successful'],
  ], false);
  const vip25 = await db.row("SELECT * FROM customers WHERE username='CntTest02'");
  check('25 deposits → VIP', vip25 && vip25.vip_category === 'vip', vip25 ? `${vip25.deposit_count} / ${vip25.vip_category}` : 'none');

  /* ---- 4. failed deposit count me nahi ---- */
  await uploadDeposits(token, [
    ['CntTest03', 'FS001', D, 500, 'successful'],
    ['CntTest03', 'FS002', D, 900, 'failed'],
  ], false);
  const c3 = await db.row("SELECT * FROM customers WHERE username='CntTest03'");
  check('failed row count me nahi (1 raha)', c3 && c3.deposit_count === 1, c3 ? String(c3.deposit_count) : 'none');
  check('total me bhi failed nahi (500)', c3 && Number(c3.deposit_amount) === 500, c3 ? String(c3.deposit_amount) : 'none');

  /* ---- 5. manual Add Data me phir bhi ek din ek entry ---- */
  const add = await req('/add-data', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf_token: token, play_date: D, dry: '0',
      rows: 'CntTest09 9000099999 400',
    }).toString(),
  });
  check('manual entry chali', add.status === 200);
  const addAgain = await req('/add-data', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf_token: token, play_date: D, dry: '0',
      rows: 'CntTest09 9000099999 400',
    }).toString(),
  });
  const manualRows = await db.value("SELECT COUNT(*)::int FROM deposits WHERE username='CntTest09'");
  check('manual re-upload skip (1 hi row)', manualRows === 1, String(manualRows));
  check('skip message dikha', /pehle se the|skip/i.test(addAgain.text));

  /* ---- 6. clear button ---- */
  const badClear = await req('/upload/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: token, scope: 'excel', confirm: 'haan' }).toString(),
  });
  const stillThere = await db.value("SELECT COUNT(*)::int FROM deposits WHERE username LIKE 'CntTest%'");
  check('galat confirm par kuch delete nahi', stillThere >= 3, String(stillThere));

  const goodClear = await req('/upload/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: token, scope: 'excel', confirm: 'DELETE' }).toString(),
  });
  check('DELETE likhne par clear chala', goodClear.status === 302);
  const excelRows = await db.value("SELECT COUNT(*)::int FROM deposits WHERE source = 'excel'");
  check('excel data saaf ho gaya', excelRows === 0, String(excelRows));
  const manualLeft = await db.value("SELECT COUNT(*)::int FROM deposits WHERE username='CntTest09'");
  check('manual data bacha raha', manualLeft === 1, String(manualLeft));

  /* ---- cleanup ---- */
  await db.query("DELETE FROM deposits WHERE username LIKE 'CntTest%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'CntTest%'");

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

