'use strict';

// Excel se assignment — username + caller ki do column wali file.
//
// Design:
//   parse()   → file padho, har row ko validate karo (username mila? caller sahi?)
//   preview   → session me rakho, user ko dikhao
//   apply()   → sirf sahi rows DB me likho, ek transaction me
//
// Caller "login_id" se match hota hai, naam se nahi — kyunki login_id unique hai
// (jaise Diksha ka login_id `dikshadp7` hai).

const db = require('../db');

// Header ke mumkin naam — Excel me koi bhi chale
const USER_KEYS = ['username', 'user', 'user name', 'customer', 'customer name', 'client', 'id'];
const CALLER_KEYS = ['caller', 'caller name', 'assign to', 'assigned to', 'agent', 'team member', 'login id', 'login_id', 'login'];

function norm(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

/** Kaunsi column username hai aur kaunsi caller — header se pata karo. */
function detectColumns(headerRow) {
  const cells = (headerRow || []).map(norm);
  let u = -1;
  let c = -1;

  for (let i = 0; i < cells.length; i++) {
    const h = cells[i];
    if (!h) continue;
    if (u === -1 && USER_KEYS.includes(h)) u = i;
    else if (c === -1 && CALLER_KEYS.includes(h)) c = i;
  }

  // Header na mile to pehle do column maan lo
  if (u === -1 || c === -1) {
    if (u === -1) u = 0;
    if (c === -1) c = 1;
  }
  return { userCol: u, callerCol: c, detected: cells };
}

/**
 * File ko rows me todo aur validate karo.
 * @returns {{rows: Array, errors: Array, callers: Map, stats: Object}}
 */
async function parse(rowsMatrix) {
  const clean = (rowsMatrix || []).filter(
    (r) => Array.isArray(r) && r.some((cell) => String(cell === null || cell === undefined ? '' : cell).trim() !== '')
  );
  if (!clean.length) {
    return { rows: [], errors: ['File khaali hai.'], callers: new Map(), stats: { total: 0 } };
  }

  const { userCol, callerCol, detected } = detectColumns(clean[0]);
  const startIdx = USER_KEYS.includes(norm(detected[userCol])) || CALLER_KEYS.includes(norm(detected[callerCol])) ? 1 : 0;

  // Callers — login_id aur naam dono se match karo (case-insensitive)
  const users = await db.rows(
    `SELECT id, name, login_id, team, daily_target FROM users WHERE role <> 'super_admin'`
  );
  const byKey = new Map();
  for (const u of users) {
    byKey.set(norm(u.login_id), u);
    byKey.set(norm(u.name), u);
  }

  // Customers — ek hi query me
  const usernames = [];
  for (let i = startIdx; i < clean.length; i++) {
    const raw = clean[i][userCol];
    const s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (s) usernames.push(s.toLowerCase());
  }
  const unique = [...new Set(usernames)];

  const found = new Map();
  const CHUNK = 1000;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const got = await db.rows(
      `SELECT id, username, assigned_to, status, vip_category, deposit_count
         FROM customers WHERE LOWER(username) = ANY($1::text[])`,
      [slice]
    );
    for (const c of got) found.set(norm(c.username), c);
  }

  const seen = new Set();
  const rows = [];
  const errors = [];
  let unmatched = 0;
  let badCaller = 0;
  let duplicates = 0;

  for (let i = startIdx; i < clean.length; i++) {
    const lineNo = i + 1;
    const r = clean[i];
    const uName = String(r[userCol] === null || r[userCol] === undefined ? '' : r[userCol]).trim();
    const cName = String(r[callerCol] === null || r[callerCol] === undefined ? '' : r[callerCol]).trim();

    if (!uName) {
      errors.push({ line: lineNo, type: 'no_username', message: `Line ${lineNo}: username khaali hai.` });
      continue;
    }
    if (!cName) {
      errors.push({ line: lineNo, type: 'no_caller', message: `Line ${lineNo}: ${uName} — caller khaali hai.` });
      continue;
    }

    const key = norm(uName);
    if (seen.has(key)) {
      duplicates++;
      errors.push({ line: lineNo, type: 'duplicate', message: `Line ${lineNo}: ${uName} file me do baar hai — sirf pehli line lagegi.` });
      continue;
    }
    seen.add(key);

    const cust = found.get(key);
    if (!cust) {
      unmatched++;
      errors.push({ line: lineNo, type: 'unmatched', message: `Line ${lineNo}: "${uName}" database me nahi mila.` });
      continue;
    }

    const caller = byKey.get(norm(cName));
    if (!caller) {
      badCaller++;
      errors.push({ line: lineNo, type: 'bad_caller', message: `Line ${lineNo}: "${cName}" naam ka koi caller nahi.` });
      continue;
    }

    rows.push({
      line: lineNo,
      id: cust.id,
      username: cust.username,
      callerId: caller.id,
      callerName: caller.name,
      callerLogin: caller.login_id,
      wasAssignedTo: cust.assigned_to,
      status: cust.status,
      vip: cust.vip_category,
      deposits: cust.deposit_count,
    });
  }

  // Kaun kaun kitne le raha hai — preview me dikhane ke liye
  const perCaller = new Map();
  for (const r of rows) {
    const k = r.callerLogin;
    if (!perCaller.has(k)) perCaller.set(k, { login_id: k, name: r.callerName, count: 0 });
    perCaller.get(k).count++;
  }

  return {
    rows,
    errors,
    callers: perCaller,
    columns: { userCol, callerCol, header: detected },
    stats: {
      total: clean.length - startIdx,
      valid: rows.length,
      unmatched,
      badCaller,
      duplicates,
      changes: rows.filter((r) => r.wasAssignedTo !== r.callerId).length,
    },
  };
}

/** Preview ko DB me lagao — ek transaction. */
async function apply(rows, meta = {}) {
  if (!rows.length) return { applied: 0 };

  let applied = 0;
  await db.tx(async (client) => {
    const CHUNK = 400;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const ids = slice.map((r) => r.id);
      const callerId = slice[0].callerId;

      // Ek chunk me alag-alag callers ho sakte hain — caller ke hisaab se group karo
      const groups = new Map();
      for (const r of slice) {
        if (!groups.has(r.callerId)) groups.set(r.callerId, []);
        groups.get(r.callerId).push(r.id);
      }
      for (const [cid, idList] of groups) {
        const out = await client.query(
          `UPDATE customers SET assigned_to = $1 WHERE id = ANY($2::int[])`,
          [cid, idList]
        );
        applied += out.rowCount;
      }
      void ids;
      void callerId;
    }

    await client.query(
      `INSERT INTO assign_imports (file_name, uploaded_by, total_rows, applied, unmatched, bad_caller, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        meta.fileName || '',
        meta.uploadedBy || null,
        meta.total || 0,
        applied,
        meta.unmatched || 0,
        meta.badCaller || 0,
        JSON.stringify(meta.perCaller || {}),
      ]
    );
  });

  return { applied };
}

/** Excel template — dono column ke saath, aur current callers ki list. */
async function buildTemplate() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DP7';

  const ws = wb.addWorksheet('Assign');
  ws.columns = [
    { header: 'username', width: 26 },
    { header: 'caller', width: 22 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };

  const users = await db.rows(
    `SELECT name, login_id FROM users WHERE role <> 'super_admin' ORDER BY name`
  );

  // Do sample rows — asli callers ke saath
  const a = users[0] ? users[0].login_id : 'arun';
  const b = users[1] ? users[1].login_id : 'kamal';
  const sample = await db.rows(
    `SELECT username FROM customers WHERE assigned_to IS NULL ORDER BY id LIMIT 2`
  );
  ws.addRow([sample[0] ? sample[0].username : 'rahul123', a]);
  ws.addRow([sample[1] ? sample[1].username : 'priya_s', b]);

  ws.addRow([]);
  ws.addRow(['Caller ke login_id (yahi file me daalein):']).font = { bold: true };
  for (const u of users) {
    ws.addRow([`  ${u.login_id}`, u.name]).font = { size: 10, color: { argb: 'FF666666' } };
  }

  ws.addRow([]);
  ws.addRow(['Note:']).font = { bold: true };
  [
    'Sirf do column chahiye: username aur caller.',
    'caller me login_id likhein (naam nahi) — jaise dikshadp7, arun, kamal.',
    'Jo username database me nahi milega wo skip ho jayega — preview me dikh jayega.',
    'Ek file me 5,000 rows tak chalti hai.',
    'Upload karne par pehle PREVIEW aayega — tab tak kuch nahi badalta.',
  ].forEach((t) => {
    ws.addRow([t]).font = { size: 10, color: { argb: 'FF666666' } };
  });

  // Doosri sheet — saare callers
  const ws2 = wb.addWorksheet('Callers');
  ws2.columns = [
    { header: 'login_id', width: 20 },
    { header: 'name', width: 24 },
  ];
  const h2 = ws2.getRow(1);
  h2.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  users.forEach((u) => ws2.addRow([u.login_id, u.name]));

  return wb.xlsx.writeBuffer();
}

/** Abhi ka assignment state — username + caller ki CSV/Excel. */
async function buildExport({ unassignedOnly = false } = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DP7';

  const rows = await db.rows(
    `SELECT b.username, b.caller_name, u.login_id AS caller_login,
            b.status, b.vip_category, b.deposit_count, b.first_deposit::text AS first_deposit
       FROM customer_board b
       LEFT JOIN users u ON u.id = b.assigned_to
      ${unassignedOnly ? 'WHERE b.assigned_to IS NULL' : ''}
      ORDER BY b.username`
  );

  const ws = wb.addWorksheet(unassignedOnly ? 'Unassigned' : 'Assignment');
  ws.columns = [
    { header: 'username', width: 26 },
    { header: 'caller', width: 20 },
    { header: 'caller name', width: 22 },
    { header: 'status', width: 14 },
    { header: 'vip', width: 16 },
    { header: 'deposits', width: 12 },
    { header: 'first deposit', width: 16 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };

  for (const r of rows) {
    ws.addRow([
      r.username,
      r.caller_login || '',
      r.caller_name || '',
      r.status,
      r.vip_category,
      r.deposit_count,
      r.first_deposit || '',
    ]);
  }

  return { buffer: await wb.xlsx.writeBuffer(), count: rows.length };
}

module.exports = { parse, apply, buildTemplate, buildExport, detectColumns };

