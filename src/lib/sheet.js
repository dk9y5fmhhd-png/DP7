'use strict';

// Excel / CSV padhne ka engine — retention CRM ke do upload types:
//   customers : username, mobile, registration date
//   deposits  : username, transaction id, deposit date, amount, status

const ExcelJS = require('exceljs');

const FIELDS = {
  // caller pehle — warna "login id" username me chala jata hai
  caller: ['caller', 'caller name', 'caller id', 'assign to', 'assigned to', 'assigned caller',
           'agent', 'team member', 'login id', 'login_id', 'created by'],
  username: ['username', 'user name', 'user', 'client', 'name', 'player', 'userid', 'user id', 'login', 'customer'],
  mobile: ['mobile', 'mobile number', 'mob', 'phone', 'contact', 'number', 'whatsapp', 'no'],
  date: ['date', 'deposit date', 'registration date', 'reg date', 'play date', 'date of deposit', 'tarikh', 'day'],
  txn_id: ['transaction id', 'txn id', 'txnid', 'transaction', 'utr', 'reference', 'ref no', 'order id', 'id'],
  count: ['count', 'deposit count', 'deposits', 'no of deposits', 'number of deposits',
          'total deposits', 'txn count', 'times', 'deposit times', 'no of txn', 'transactions'],
  amount: ['amount', 'amt', 'deposit', 'value', 'rs', 'inr', 'sum', 'total'],
  status: ['status', 'state', 'result', 'txn status', 'transaction status'],
};

function scoreHeader(cell) {
  const raw = String(cell || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;
  for (const [field, words] of Object.entries(FIELDS)) {
    if (words.includes(raw)) return field;
  }
  for (const [field, words] of Object.entries(FIELDS)) {
    for (const w of words) {
      if (w.length >= 3 && raw.includes(w)) return field;
    }
  }
  return null;
}

function detectHeader(rows) {
  const limit = Math.min(rows.length, 6);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i] || [];
    const map = {};
    let hits = 0;
    cells.forEach((cell, idx) => {
      const f = scoreHeader(cell);
      if (f && map[f] === undefined) { map[f] = idx; hits++; }
    });
    if (hits >= 2) return { index: i, map };
  }
  return null;
}

function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell;
  if (typeof cell === 'object') {
    if (cell.text !== undefined) return String(cell.text);
    if (cell.result !== undefined) return cell.result;
    if (cell.richText) return cell.richText.map((r) => r.text).join('');
    if (cell.hyperlink) return cell.text || cell.hyperlink;
    if (cell.error) return '';
  }
  return cell;
}

const pad2 = (n) => String(n).padStart(2, '0');

function toISO(y, m, d) {
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  const dt = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function serialToISO(n) {
  const ms = Math.round((Number(n) - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function normaliseDate(raw) {
  const v = cellText(raw);
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return toISO(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a > 12) return toISO(m[3], b, a);
    if (b > 12) return toISO(m[3], a, b);
    return toISO(m[3], b, a);
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = s.match(/^(\d{1,2})[\s\-/]*([A-Za-z]{3,9})[\s\-/]*(\d{2,4})$/);
  if (m) {
    const mi = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return toISO(m[3], mi + 1, m[1]);
  }
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 60000) return serialToISO(n);
  }
  return null;
}

function normaliseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = String(cellText(raw) || '').replace(/[₹,\s]/g, '').replace(/^(rs\.?|inr)/i, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const str = (v) => String(cellText(v) || '').replace(/\s+/g, ' ').trim();

function parseCsv(text) {
  const rows = [];
  let row = []; let field = ''; let q = false;
  const src = String(text || '').replace(/^\ufeff/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readMatrix(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return { matrix: parseCsv(buffer.toString('utf8')), sheet: filename };
  if (ext === 'xls') throw new Error('Purana .xls format support nahi hai — Excel me File → Save As → .xlsx split it:');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((w) => w.rowCount > 1) || wb.worksheets[0];
  if (!ws) throw new Error('No sheet found in the file.');
  const matrix = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cell.value; });
    matrix.push(cells);
  });
  return { matrix, sheet: ws.name };
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {Object} opts { required: [...], positional: [...] }
 */
async function parseSheet(buffer, filename, opts) {
  const { matrix, sheet } = await readMatrix(buffer, filename);
  const clean = matrix.filter((r) => Array.isArray(r) && r.some((c) => str(c) !== ''));
  if (!clean.length) return { rows: [], errors: [], sheet, headerMap: null };

  const header = detectHeader(clean);
  const headerMap = header ? header.map : null;
  const start = header ? header.index + 1 : 0;
  const rows = [];
  const errors = [];

  for (let i = start; i < clean.length; i++) {
    const r = clean[i];
    const lineNo = i + 1;
    if (!r || !r.length) continue;

    const get = (field) => {
      if (headerMap && headerMap[field] !== undefined) return r[headerMap[field]];
      const pos = (opts.positional || []).indexOf(field);
      return pos >= 0 ? r[pos] : undefined;
    };

    const rec = {
      line: lineNo,
      username: str(get('username')),
      mobile: String(cellText(get('mobile')) || '').replace(/[^\d]/g, ''),
      date: normaliseDate(get('date')),
      txn_id: str(get('txn_id')),
      count: normaliseNumber(get('count')),
      qty: normaliseNumber(get('amount')),
      status: str(get('status')),
      caller: str(get('caller')),
    };

    // kuch bhi nahi mila to row khaali hai
    if (!rec.username && rec.qty === null && !rec.txn_id) continue;

    // "transaction id" column na ho to mobile wale number ko txn na samjhein
    if (headerMap && headerMap.txn_id === undefined) rec.txn_id = '';

    let ok = true;
    for (const field of opts.required || []) {
      const v = field === 'qty' ? rec.qty : rec[field];
      if (v === null || v === undefined || v === '') {
        errors.push({ line: lineNo, text: r.map((c) => str(c)).join(' | ').slice(0, 80), reason: `${field} missing` });
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    rows.push(rec);
  }

  return { rows, errors, sheet, headerMap };
}

async function buildTemplate(kind) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DP7';

  if (kind === 'customers') {
    const ws = wb.addWorksheet('Customers');
    ws.columns = [
      { header: 'username', width: 22 },
      { header: 'mobile', width: 16 },
      { header: 'registration date', width: 18 },
      { header: 'caller', width: 18 },
    ];
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D5EFC' } };
    ws.addRow(['rahul123', '9876543210', '2026-11-01', 'arun']);
    ws.addRow(['priya_s', '+91 91234 56780', '05/11/2026', 'kamal']);
    ws.getColumn(2).numFmt = '@';
    ws.addRow([]);
    ws.addRow(['Note:']).font = { bold: true };
    ws.addRow(['Usernames are unique — a repeat only updates mobile/date.']).font = { size: 10, color: { argb: 'FF666666' } };
    ws.addRow(['Leave caller blank and the customer is not assigned — it only joins the follow-up queue.']).font = { size: 10, color: { argb: 'FF666666' } };
    ws.addRow(['In caller put the login_id (not the name) — e.g. dikshadp7, indianteam.']).font = { size: 10, color: { argb: 'FF666666' } };
  } else {
    const ws = wb.addWorksheet('Deposits');
    ws.columns = [
      { header: 'username', width: 22 },
      { header: 'transaction id', width: 20 },
      { header: 'deposit date', width: 16 },
      { header: 'amount', width: 12 },
      { header: 'status', width: 12 },
      { header: 'deposit count', width: 15 },
    ];
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D5EFC' } };
    // transaction-wise (count khaali = 1)
    ws.addRow(['rahul123', 'TXN10001', '2026-11-20', 500, 'successful', '']);
    ws.addRow(['rahul123', 'TXN10002', '2026-11-22', 300, 'successful', '']);
    ws.addRow(['priya_s', 'TXN10003', '2026-11-21', 1200, 'successful', '']);
    ws.addRow(['amit99', 'TXN10004', '2026-11-21', 200, 'failed', '']);
    // summary row — ek row me 25 deposits
    ws.addRow(['vijayst1', '', '2026-04-30', 30000, 'successful', 25]);
    ws.addRow([]);
    ws.addRow(['Note:']).font = { bold: true };
    [
      'Blank deposit count = 1 (transaction-wise row). On a summary row write how many deposits it holds.',
      'Only status = successful deposits count toward the customer.',
      'A duplicate transaction id rejects that row.',
      'Multiple genuine deposits for one username are allowed.',
      'status khaali chhod dein to "successful" maana jayega.',
    ].forEach((t) => ws.addRow([t]).font = { size: 10, color: { argb: 'FF666666' } });
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { parseSheet, buildTemplate, readMatrix, normaliseDate, normaliseNumber, str };

