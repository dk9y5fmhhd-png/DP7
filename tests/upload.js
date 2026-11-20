'use strict';

/* Excel / CSV upload test — asli .xlsx banata hai aur upload karta hai.
   Run: node tests/upload.js */

process.env.PORT = process.env.PORT || '3996';
require('dotenv').config();

const ExcelJS = require('exceljs');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let jar = new Map();

const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
  if (jar.size) headers.cookie = cookieHeader();
  const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  absorb(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), buf, location: res.headers.get('location'), type: res.headers.get('content-type') };
}
const csrf = (html) => (html.match(/name="csrf_token" value="([^"]+)"/) || [])[1];

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function makeXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['Date', 'Username', 'Mobile', 'Amount']); // headers, capital case
  ws.addRow(['2026-11-15', 'xl_test_a', '+91 90000 00001', '₹1,500']);
  ws.addRow(['2026-11-15', 'xl_test_b', '9000000002', 250.5]);
  ws.addRow(['2026-11-16', 'xl_test_a', '9000000001', 300]); // dusra din
  ws.addRow(['16/11/2026', 'xl_test_c', '9000000003', '']); // dd/mm/yyyy + blank amount
  ws.addRow(['2026-11-16', '', '9000000004', 100]); // error: no username
  ws.addRow(['2026-11-16', 'xl_test_d', '123', 100]); // error: mobile too short
  ws.addRow([]); // khaali row
  ws.addRow(['2026-11-17', 'xl_test_e', 9000000005, 99.99]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function makeCsv() {
  return Buffer.from(
    'username,mobile,amount\ncsv_test_a,9111100001,100\ncsv_test_b,9111100002,200\nbadline\n',
    'utf8'
  );
}

async function upload(fields, file) {
  const fd = new FormData();
  fd.append('csrf_token', fields.token);
  fd.append('play_date', fields.playDate);
  fd.append('dry', fields.dry);
  if (file) fd.append('file', new Blob([file.buffer]), file.name);
  const res = await fetch(BASE + '/add-data', {
    method: 'POST',
    headers: { cookie: cookieHeader() },
    body: fd,
    redirect: 'manual',
  });
  absorb(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location') };
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 1200));
  const db = require('../src/db');

  // login
  const lp = await req('/login');
  const body = new URLSearchParams({
    csrf_token: csrf(lp.text),
    login_id: process.env.SMOKE_LOGIN || 'admin',
    password: process.env.SMOKE_PASSWORD || 'admin123',
  });
  await req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });

  const page = await req('/add-data');
  const token = csrf(page.text);
  check('Add Data page khulti hai', page.status === 200);
  check('Excel upload form page par hai', /type="file"/.test(page.text) && /enctype="multipart\/form-data"/.test(page.text));

  // template
  const tpl = await req('/add-data/template');
  check('Template download (.xlsx)', tpl.status === 200 && tpl.buf.length > 2000 && /spreadsheetml/.test(tpl.type || ''), `${tpl.buf.length} bytes`);
  const tplBook = new ExcelJS.Workbook();
  await tplBook.xlsx.load(tpl.buf);
  const tplSheet = tplBook.worksheets[0];
  check('Template me 4 columns', tplSheet.getRow(1).values.slice(1, 5).join(',') === 'date,username,mobile,amount');

  // cleanup old
  await db.query("DELETE FROM deposits WHERE username LIKE 'xl\\_test\\_%' OR username LIKE 'csv\\_test\\_%'");

  // dry run
  const xlsx = await makeXlsx();
  const dry = await upload({ token, playDate: '2026-11-20', dry: '1' }, { buffer: xlsx, name: 'data.xlsx' });
  check('XLSX dry run', dry.status === 200 && /Preview/.test(dry.text));
  const afterDry = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE username LIKE 'xl\\_test\\_%'"));
  check('Dry run me kuch insert nahi hua', afterDry === 0, afterDry + ' rows');

  // real upload
  const real = await upload({ token, playDate: '2026-11-20', dry: '0' }, { buffer: xlsx, name: 'data.xlsx' });
  check('XLSX upload save', real.status === 200 && /save ho gaye/.test(real.text));
  check('Headers pehchane gaye', /Username → column|Date → column/.test(real.text));

  const rows = await db.rows(
    `SELECT username, play_date::text AS d, mobile, amount::float8 AS amount
       FROM deposits WHERE username LIKE 'xl\\_test\\_%' ORDER BY username, play_date`
  );
  check('5 valid rows insert hue', rows.length === 5, rows.length + ' rows');
  check('Date column se dates li gayi (form date nahi)',
    rows.some((r) => r.d === '2026-11-15') && rows.some((r) => r.d === '2026-11-16') && rows.some((r) => r.d === '2026-11-17'),
    rows.map((r) => r.d).join(','));

  const a15 = rows.find((r) => r.username === 'xl_test_a' && r.d === '2026-11-15');
  check('+91 aur spaces wala mobile saaf hua', a15 && a15.mobile === '9000000001', a15 ? a15.mobile : 'missing');
  check('₹1,500 → 1500 parse hua', a15 && a15.amount === 1500, a15 ? String(a15.amount) : 'missing');
  check('Fractional amount (250.5) save hua', rows.some((r) => r.amount === 250.5));

  const c = rows.find((r) => r.username === 'xl_test_c');
  check('dd/mm/yyyy date parse hui', c && c.d === '2026-11-16', c ? c.d : 'missing');
  check('Blank amount = 0', c && c.amount === 0, c ? String(c.amount) : 'missing');

  check('Galat rows skip hui (no username / short mobile)', !rows.some((r) => r.username === 'xl_test_d'));
  check('Error list page par dikhi', /Mobile number galat ya missing/.test(real.text));

  // duplicate re-upload → skip
  const again = await upload({ token, playDate: '2026-11-20', dry: '0' }, { buffer: xlsx, name: 'data.xlsx' });
  const afterAgain = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE username LIKE 'xl\\_test\\_%'"));
  check('Dobara upload = duplicate skip', afterAgain === 5 && /skip hue/.test(again.text), afterAgain + ' rows');

  // CSV upload (no date column → form date use ho)
  const csv = await makeCsv();
  const csvRes = await upload({ token, playDate: '2026-11-19', dry: '0' }, { buffer: csv, name: 'data.csv' });
  check('CSV upload save', csvRes.status === 200 && /save ho gaye/.test(csvRes.text));
  const csvRows = await db.rows("SELECT play_date::text AS d, username FROM deposits WHERE username LIKE 'csv\\_test\\_%'");
  check('CSV rows form date par gayi', csvRows.length === 2 && csvRows.every((r) => r.d === '2026-11-19'), JSON.stringify(csvRows));

  // na file na text → helpful message
  const empty = await upload({ token, playDate: '2026-11-19', dry: '1' }, null);
  check('Khaali submit par saaf message', empty.status === 400 || /Koi valid line nahi/.test(empty.text));

  // galat extension block
  const bad = await upload({ token, playDate: '2026-11-19', dry: '0' }, { buffer: Buffer.from('hello'), name: 'photo.jpg' });
  check('Galat file type reject', bad.status === 302 || /Sirf \.xlsx/.test(bad.text), 'status ' + bad.status);

  // .xls ko saaf message
  const xls = await upload({ token, playDate: '2026-11-19', dry: '0' }, { buffer: Buffer.from('fakxls'), name: 'old.xls' });
  check('.xls par "Save As .xlsx" message', xls.status === 302 || /Save As/i.test(xls.text), 'status ' + xls.status);

  // reports me naya data dikhta hai
  const rep = await req('/reports/export?type=level');
  check('Naya data Level Report (CSV) me aa gaya', /xl_test_a/.test(rep.text));

  // cleanup
  await db.query("DELETE FROM deposits WHERE username LIKE 'xl\\_test\\_%' OR username LIKE 'csv\\_test\\_%'");

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


