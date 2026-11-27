'use strict';

/* Excel / CSV import.
   Client ka file jaisa bhi ho — headers ho ya na ho, columns ka order badla ho,
   ya ek hi file me kai dates ho — sab handle karta hai. */

const ExcelJS = require('exceljs');

/* ----------------------------- column detection ----------------------------- */

// Naam ke tukde jo header me mil sakte hain (lowercase).
const FIELDS = {
  date: ['date', 'play date', 'playdate', 'day', 'din', 'tarikh'],
  username: [
    'username', 'user name', 'user', 'userid', 'user id', 'client', 'clientname',
    'client name', 'name', 'player', 'player name', 'id', 'member', 'account',
  ],
  mobile: [
    'mobile', 'mobile number', 'mob', 'mob no', 'phone', 'phone number', 'contact',
    'contact number', 'number', 'no', 'whatsapp', 'cell',
  ],
  amount: [
    'amount', 'amt', 'deposit', 'deposits', 'deposit amount', 'value', 'rs',
    'rupees', 'paisa', 'money', 'total', 'balance', 'credit',
  ],
};

function scoreHeader(cell) {
  const raw = String(cell || '').trim().toLowerCase();
  if (!raw) return null;
  // exact match pehle, phir chhota header containing
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

// Header row dhoondo — pehli 5 rows me se jisme kam se kam 2 fields pehchane jayein
function detectHeader(rows) {
  const limit = Math.min(rows.length, 6);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i] || [];
    const map = {};
    let hits = 0;
    cells.forEach((cell, idx) => {
      const field = scoreHeader(cell);
      if (field && map[field] === undefined) {
        map[field] = idx;
        hits++;
      }
    });
    if (hits >= 2) return { index: i, map };
  }
  return null;
}

/* ------------------------------- cell normalising ------------------------------- */

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

// 98765 43210 / +91-98765-43210 / 09876543210 → 9876543210
function normaliseMobile(raw) {
  let s = String(cellText(raw) || '').trim();
  if (!s) return '';
  // Excel number cell → "9.87654321E9" jaisa aa sakta hai, usko poora number banao
  if (/^\d+(\.\d+)?e\+\d+$/i.test(s)) s = Number(s).toFixed(0);
  s = s.replace(/[^\d]/g, '');
  if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return s;
}

function normaliseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const text = String(cellText(raw) || '')
    .replace(/[₹,\s]/g, '')
    .replace(/^(rs\.?|inr)/i, '');
  if (text === '') return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toISO(y, m, d) {
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  const date = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

// Excel serial (days since 1899-12-30) → YYYY-MM-DD
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
    // exceljs Date ko UTC ki tarah treat karta hai jab cell date-type ho
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
  }
  const s = String(v).trim();
  if (!s) return null;

  // 2026-11-20 / 2026/11/20
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return toISO(m[1], m[2], m[3]);

  // 20-11-2026 / 20/11/2026 / 20.11.26
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // pehla hissa 12 se bada hai to pakka dd-mm-yyyy; warna din-pehle assume karo
    if (a > 12) return toISO(m[3], b, a);
    if (b > 12) return toISO(m[3], a, b);
    return toISO(m[3], b, a); // dd-mm-yyyy (India ka default)
  }

  // 20 Nov 2026 / 20-Nov-2026
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = s.match(/^(\d{1,2})[\s\-/]*([A-Za-z]{3,9})[\s\-/]*(\d{2,4})$/);
  if (m) {
    const mi = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return toISO(m[3], mi + 1, m[1]);
  }

  // Excel serial number
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 60000) return serialToISO(n);
  }

  return null;
}

const cleanUser = (v) =>
  String(cellText(v) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

/* ---------------------------------- CSV ---------------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\ufeff/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',' || c === ';' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------- main entry ------------------------------- */

/**
 * @param {Buffer} buffer  file contents
 * @param {string} filename  original name (extension dekhta hai)
 * @param {string} fallbackDate  agar file me date column na ho
 * @returns {Promise<{sheet:string, sheets:string[], rows:Array, errors:Array, headerMap:Object|null, usedDateColumn:boolean}>}
 */
async function parseFile(buffer, filename, fallbackDate) {
  const ext = String(filename || '').toLowerCase().split('.').pop();

  let matrix = [];
  let sheetName = '';
  let sheets = [];

  if (ext === 'csv' || ext === 'txt') {
    matrix = parseCsv(buffer.toString('utf8'));
    sheetName = filename;
  } else {
    if (ext === 'xls') {
      throw new Error('Old .xls format is not supported — in Excel use File → Save As → .xlsx and upload that:');
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    sheets = workbook.worksheets.map((w) => w.name);
    // pehli aisi sheet chuno jisme data ho
    const sheet =
      workbook.worksheets.find((w) => w.rowCount > 1) || workbook.worksheets[0];
    if (!sheet) throw new Error('No sheet found in the Excel file.');
    sheetName = sheet.name;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cell.value;
      });
      matrix.push(cells);
    });
  }

  // khaali rows hatao
  matrix = matrix.filter((r) => Array.isArray(r) && r.some((c) => String(cellText(c) || '').trim() !== ''));
  if (!matrix.length) {
    return { sheet: sheetName, sheets, rows: [], errors: [], headerMap: null, usedDateColumn: false };
  }

  const header = detectHeader(matrix);
  const headerMap = header ? header.map : null;
  const startRow = header ? header.index + 1 : 0;

  const usedDateColumn = !!(headerMap && headerMap.date !== undefined);
  const col = (row, field) => {
    if (headerMap && headerMap[field] !== undefined) return row[headerMap[field]];
    // header nahi mila → positional fallback
    const pos = { date: 0, username: usedDateColumn ? 1 : 0, mobile: usedDateColumn ? 2 : 1, amount: usedDateColumn ? 3 : 2 };
    return row[pos[field]];
  };

  const rows = [];
  const errors = [];

  for (let i = startRow; i < matrix.length; i++) {
    const r = matrix[i];
    const lineNo = i + 1; // Excel/paste line number (1-based)

    // row khaali
    if (!r || !r.length) continue;

    // beech me dobara header aa gaya (merged cells / do tables)
    const firstText = String(cellText(r[0]) || '').trim().toLowerCase();
    if (headerMap && (firstText === 'username' || firstText === 'user' || firstText === 'name')) continue;

    const username = cleanUser(col(r, 'username'));
    const mobile = normaliseMobile(col(r, 'mobile'));
    const amount = normaliseAmount(col(r, 'amount'));
    const rowDate = usedDateColumn ? normaliseDate(col(r, 'date')) : null;

    if (!username) {
      errors.push({ line: lineNo, text: r.map((c) => String(cellText(c) || '')).join(' | ').slice(0, 90), reason: 'Username khaali hai' });
      continue;
    }
    // sirf number wala username (jaise total row) skip
    if (/^\d+$/.test(username) && !mobile) {
      errors.push({ line: lineNo, text: username, reason: 'Username is only digits — skipped' });
      continue;
    }
    if (!mobile || mobile.length < 10) {
      errors.push({ line: lineNo, text: `${username} | ${mobile || '(khaali)'}`, reason: 'Mobile number galat ya missing' });
      continue;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push({ line: lineNo, text: `${username} | ${String(cellText(col(r, 'amount')) || '')}`, reason: 'Amount galat hai' });
      continue;
    }
    if (usedDateColumn && !rowDate) {
      errors.push({ line: lineNo, text: `${username} | ${String(cellText(col(r, 'date')) || '(khaali)')}`, reason: 'Date samajh nahi aayi' });
      continue;
    }

    rows.push({
      line: lineNo,
      date: rowDate || fallbackDate,
      username,
      mobile,
      amount,
    });
  }

  return { sheet: sheetName, sheets, rows, errors, headerMap, usedDateColumn };
}

/* ------------------------------- template ------------------------------- */

async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DP7';
  const ws = wb.addWorksheet('Deposits');

  ws.columns = [
    { header: 'date', key: 'date', width: 14 },
    { header: 'username', key: 'username', width: 22 },
    { header: 'mobile', key: 'mobile', width: 16 },
    { header: 'amount', key: 'amount', width: 12 },
  ];

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D5EFC' } };
  head.height = 22;
  head.alignment = { vertical: 'middle' };

  const today = new Date().toISOString().slice(0, 10);
  const samples = [
    [today, 'rahul123', '9876543210', 500],
    [today, 'priya_s', '9123456780', 1200],
    [today, 'amit99', '9988776655', 0],
  ];
  samples.forEach((r) => ws.addRow(r));

  ws.getColumn('mobile').numFmt = '@';
  ws.getColumn('amount').numFmt = '#,##0';
  ws.eachRow((row, i) => {
    if (i > 1) row.font = { color: { argb: 'FF888888' } };
  });

  const note = ws.addRow([]);
  const help = ws.addRow(['Note:']);
  help.font = { bold: true };
  [
    'One client per line. Column order can change as long as the header names stay.',
    'The date column is optional — if missing, the "Play date" chosen in the form is used.',
    'The same username twice on one date — the second is skipped.',
    'Leave amount blank and it counts as 0.',
  ].forEach((t) => {
    const r = ws.addRow([t]);
    r.font = { size: 10, color: { argb: 'FF666666' } };
  });
  void note;

  return wb.xlsx.writeBuffer();
}

module.exports = { parseFile, buildTemplate, parseCsv, normaliseMobile, normaliseDate };

