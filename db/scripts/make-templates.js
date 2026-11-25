'use strict';

/* Upload templates banata hai (DP7 retention CRM) + round-trip verify.
   node scripts/make-templates.js <outDir> */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const out = process.argv[2] || '/tmp/.scratch/templates';

function styleHeader(ws, headers) {
  ws.columns = headers.map((h) => ({ header: h.name, key: h.name, width: h.width }));
  const head = ws.getRow(1);
  head.height = 26;
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  head.alignment = { vertical: 'middle', horizontal: 'left' };
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    c.border = {
      bottom: { style: 'thin', color: { argb: 'FF0F3E8C' } },
      right: { style: 'thin', color: { argb: 'FF2B62C9' } },
    };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

async function customers() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DP7';
  const ws = wb.addWorksheet('Customers', {
    properties: { defaultRowHeight: 20 },
  });
  styleHeader(ws, [
    { name: 'username', width: 24 },
    { name: 'mobile', width: 18 },
    { name: 'registration date', width: 20 },
  ]);
  // mobile ko text rakho — warna Excel lamba number scientific notation me badal deta hai
  ws.getColumn('mobile').numFmt = '@';
  ws.getColumn('registration date').numFmt = 'yyyy-mm-dd';
  // 300 khaali formatted rows, taaki type karte waqt table jaisa lage
  for (let i = 2; i <= 301; i++) {
    const r = ws.getRow(i);
    r.getCell(2).numFmt = '@';
    r.getCell(3).numFmt = 'yyyy-mm-dd';
  }
  const buf = await wb.xlsx.writeBuffer();
  fs.writeFileSync(path.join(out, 'DP7-customers-upload.xlsx'), buf);
  return buf;
}

async function deposits() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DP7';
  const ws = wb.addWorksheet('Deposits', { properties: { defaultRowHeight: 20 } });
  styleHeader(ws, [
    { name: 'username', width: 24 },
    { name: 'transaction id', width: 20 },
    { name: 'deposit date', width: 16 },
    { name: 'amount', width: 14 },
    { name: 'status', width: 14 },
    { name: 'deposit count', width: 15 },
  ]);
  ws.getColumn('transaction id').numFmt = '@';
  ws.getColumn('deposit date').numFmt = 'yyyy-mm-dd';
  ws.getColumn('amount').numFmt = '#,##0.00';

  // status ki dropdown (data validation) — successful / failed / pending / reversed
  for (let i = 2; i <= 1001; i++) {
    const r = ws.getRow(i);
    r.getCell(2).numFmt = '@';
    r.getCell(3).numFmt = 'yyyy-mm-dd';
    r.getCell(4).numFmt = '#,##0.00';
    r.getCell(5).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"successful,failed,pending,reversed"'],
      showErrorMessage: true,
      errorTitle: 'Status galat',
      error: 'successful / failed / pending / reversed me se chunein.',
    };
  }
  const buf = await wb.xlsx.writeBuffer();
  fs.writeFileSync(path.join(out, 'DP7-deposits-upload.xlsx'), buf);
  return buf;
}

async function filled(kind) {
  // test ke liye ek bhara hua sample
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(kind === 'customers' ? 'Customers' : 'Deposits');
  if (kind === 'customers') {
    styleHeader(ws, [
      { name: 'username', width: 24 }, { name: 'mobile', width: 18 }, { name: 'registration date', width: 20 },
    ]);
    ws.addRow(['rahul123', '9876543210', new Date(Date.UTC(2026, 10, 1))]);
    ws.addRow(['priya_s', '9123456780', new Date(Date.UTC(2026, 10, 5))]);
  } else {
    styleHeader(ws, [
      { name: 'username', width: 24 }, { name: 'transaction id', width: 20 },
      { name: 'deposit date', width: 16 }, { name: 'amount', width: 14 }, { name: 'status', width: 14 },
      { name: 'deposit count', width: 15 },
    ]);
    ws.addRow(['rahul123', 'TXN10001', new Date(Date.UTC(2026, 10, 20)), 500, 'successful', '']);
    ws.addRow(['rahul123', 'TXN10002', new Date(Date.UTC(2026, 10, 22)), 300, 'successful', '']);
    ws.addRow(['priya_s', 'TXN10003', new Date(Date.UTC(2026, 10, 21)), 1200, 'successful', '']);
    ws.addRow(['priya_s', 'TXN10004', new Date(Date.UTC(2026, 10, 21)), 200, 'failed', '']);
    ws.addRow(['vijayst1', '', new Date(Date.UTC(2026, 3, 30)), 30000, 'successful', 25]);
  }
  return wb.xlsx.writeBuffer();
}

async function verify() {
  const sheet = require('../src/lib/sheet');
  const results = [];

  const cBuf = await filled('customers');
  const cParsed = await sheet.parseSheet(cBuf, 'customers.xlsx', {
    required: ['username'], positional: ['username', 'mobile', 'date'],
  });
  results.push(['customers template parse', cParsed.rows.length === 2 && cParsed.headerMap.username === 0,
    `${cParsed.rows.length} rows, headers=${JSON.stringify(cParsed.headerMap)}`]);
  results.push(['customers mobile text', cParsed.rows[0] && cParsed.rows[0].mobile === '9876543210',
    cParsed.rows[0] ? cParsed.rows[0].mobile : 'none']);
  results.push(['customers date', cParsed.rows[0] && cParsed.rows[0].date === '2026-11-01',
    cParsed.rows[0] ? cParsed.rows[0].date : 'none']);

  const dBuf = await filled('deposits');
  const dParsed = await sheet.parseSheet(dBuf, 'deposits.xlsx', {
    required: ['username', 'qty'], positional: ['username', 'txn_id', 'date', 'qty', 'status'],
  });
  results.push(['deposits template parse', dParsed.rows.length === 5, `${dParsed.rows.length} rows`]);
  results.push(['deposit txn id', dParsed.rows[0] && dParsed.rows[0].txn_id === 'TXN10001',
    dParsed.rows[0] ? dParsed.rows[0].txn_id : 'none']);
  results.push(['deposit amount', dParsed.rows[0] && dParsed.rows[0].qty === 500,
    dParsed.rows[0] ? String(dParsed.rows[0].qty) : 'none']);
  results.push(['deposit status', dParsed.rows[0] && dParsed.rows[0].status === 'successful',
    dParsed.rows[0] ? dParsed.rows[0].status : 'none']);
  results.push(['deposit date', dParsed.rows[0] && dParsed.rows[0].date === '2026-11-20',
    dParsed.rows[0] ? dParsed.rows[0].date : 'none']);

  const summary = dParsed.rows.find((r) => r.username === 'vijayst1');
  results.push(['summary row ka count padha', summary && Number(summary.count) === 25,
    summary ? String(summary.count) : 'none']);
  results.push(['normal row ka count khaali', dParsed.rows[0] && dParsed.rows[0].count === null,
    dParsed.rows[0] ? String(dParsed.rows[0].count) : 'none']);

  // blank files bhi load hon (rowCount 1)
  const blankC = await sheet.parseSheet(fs.readFileSync(path.join(out, 'DP7-customers-upload.xlsx')), 'blank.xlsx', { required: ['username'] });
  results.push(['blank customers file load hoti hai', Array.isArray(blankC.rows) && blankC.rows.length === 0, `${blankC.rows.length} rows`]);

  const blankD = await sheet.parseSheet(fs.readFileSync(path.join(out, 'DP7-deposits-upload.xlsx')), 'blank2.xlsx', { required: ['username'] });
  results.push(['blank deposits file load hoti hai', Array.isArray(blankD.rows) && blankD.rows.length === 0, `${blankD.rows.length} rows`]);

  let failed = 0;
  for (const [name, ok, extra] of results) {
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await customers();
  await deposits();
  console.log('→ templates bane:', out);
  const failed = await verify();
  process.exit(failed ? 1 : 0);
})();

