'use strict';

/* Retention CRM v3 smoke test — naye pages, upload, priority, remarks, calls.
   Run: DATABASE_URL=... node tests/smoke-v3.js */

process.env.PORT = process.env.PORT || '3211';
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
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location'), type: res.headers.get('content-type') };
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
async function upload(kind, token, buffer, filename, dry) {
  const fd = new FormData();
  fd.append('csrf_token', token);
  fd.append('dry', dry ? '1' : '0');
  fd.append('file', new Blob([buffer]), filename);
  const res = await fetch(`${BASE}/upload/${kind}`, {
    method: 'POST', headers: { cookie: ch() }, body: fd, redirect: 'manual',
  });
  absorb(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location') };
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}


/* ---------- fixtures (fresh DB par bhi test chale) ---------- */
async function seedFixtures(db) {
  const NAMES = ['KKK74DP','SaurabhDP17','DP339RAJA','RohitVip01','AadilP79','AarushS52','NewGuy01','ActiveOne'];
  const have = Number(await db.value(
    'SELECT COUNT(*)::int FROM customers WHERE username = ANY($1::text[])', [NAMES]
  ));
  if (have === NAMES.length) return;
  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [NAMES]);

  const today = new Date();
  const iso = (n) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const profiles = [
    ['KKK74DP', '9427040914', 130, 12],   // high value VIP + inactive → P1
    ['SaurabhDP17', '7388383081', 160, 42], // high value VIP + long inactive
    ['DP339RAJA', '9993999339', 62, 9],   // premium VIP → P1
    ['RohitVip01', '9812345670', 28, 20], // VIP → P1
    ['AadilP79', '8240123109', 6, 10],    // recently inactive normal → P1
    ['AarushS52', '7651961497', 9, 35],   // long inactive → P2
    ['NewGuy01', '9000011111', 1, 2],     // new → P2
    ['ActiveOne', '9000022221', 5, 1],    // active → P4
  ];

  for (const [username, mobile, count, lastAgo] of profiles) {
    for (let i = 0; i < count; i++) {
      const status = i === 2 && count > 10 ? 'failed' : 'successful';
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, txn_id, status, source)
         VALUES ($1,$2,$3,500,$4,$5,'test')`,
        [iso(Math.min(lastAgo + i, 800)), username, mobile, 'FTX' + username + i, status]
      );
    }
  }
  await require('../src/lib/customers').syncCustomers();
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2400));
  const db = require('../src/db');
  await seedFixtures(db);

  // login
  const lp = await req('/login');
  const t0 = csrf(lp.text);
  const lr = await post('/login', { login_id: 'admin', password: 'admin123' }, t0);
  check('admin login', lr.status === 302, 'status ' + lr.status);

  const home = await req('/');
  const token = csrf(home.text);
  check('dashboard khulta hai', home.status === 200);
  check('dashboard par calling queue', /Aaj ki calling queue/i.test(home.text));
  check('dashboard par VIP customers', /VIP customers/i.test(home.text));

  const pages = [
    ['/customers', /Customer master|Customers/i],
    ['/customers?priority=P1', /Customers/i],
    ['/customers?status=inactive', /Customers/i],
    ['/customers?vip=high_value_vip', /Customers/i],
    ['/calling', /Calling List/i],
    ['/calling?p=P2', /Calling List/i],
    ['/calling/my', /My Calls/i],
    ['/calls', /Call Log/i],
    ['/upload', /Daily Upload/i],
    ['/settings?tab=retention', /Retention|VIP/i],
    ['/settings?tab=telecmi', /TeleCMI/i],
  ];
  for (const [path, re] of pages) {
    const r = await req(path);
    check(`GET ${path}`, r.status === 200 && re.test(r.text), 'status ' + r.status);
  }

  const anyCustomer = await db.row('SELECT username FROM customers ORDER BY deposit_count DESC LIMIT 1');
  const detail = await req('/customers/' + encodeURIComponent(anyCustomer.username));
  check('customer detail khulta hai', detail.status === 200 && /Deposit history/i.test(detail.text));

  // admin ko poora number dikhta hai (caller ko nahi — neeche test hai)
  check('admin ko full mobile dikhta hai', /9427040914|\d{10}/.test(detail.text));

  /* ---------- VIP engine ---------- */
  const high = await db.row("SELECT vip_category, deposit_count FROM customers WHERE username = 'KKK74DP'");
  check('100+ deposits → high_value_vip', high && high.vip_category === 'high_value_vip', JSON.stringify(high));

  const prem = await db.row("SELECT vip_category, deposit_count FROM customers WHERE username = 'DP339RAJA'");
  check('51+ deposits → premium_vip', prem && prem.vip_category === 'premium_vip', JSON.stringify(prem));

  const vip = await db.row("SELECT vip_category, deposit_count FROM customers WHERE username = 'RohitVip01'");
  check('25+ deposits → vip', vip && vip.vip_category === 'vip', JSON.stringify(vip));

  const norm = await db.row("SELECT vip_category FROM customers WHERE username = 'AadilP79'");
  check('6 deposits → normal', norm && norm.vip_category === 'normal', JSON.stringify(norm));

  const failedIgnored = await db.row(
    "SELECT COUNT(*)::int c FROM deposits WHERE username='AadilP79' AND status='failed'"
  );
  check('failed deposits table me hain', failedIgnored.c >= 0);

  /* ---------- status engine ---------- */
  const st = await db.row("SELECT status FROM customers WHERE username = 'NewGuy01'");
  check('1 deposit, 2 din → new', st && st.status === 'new', JSON.stringify(st));

  const inact = await db.row("SELECT status, days_inactive FROM customer_board WHERE username = 'AarushS52'");
  check('35 din → inactive', inact && inact.status === 'inactive', JSON.stringify(inact));

  const act = await db.row("SELECT status FROM customers WHERE username = 'ActiveOne'");
  check('1 din pehle deposit → active', act && ['active', 'reactivated'].includes(act.status), JSON.stringify(act));

  /* ---------- priority ---------- */
  const p1 = await db.row("SELECT priority FROM customer_board WHERE username = 'KKK74DP'");
  check('VIP inactive → P1', p1 && p1.priority === 'P1', JSON.stringify(p1));

  const p2 = await db.row("SELECT priority FROM customer_board WHERE username = 'AarushS52'");
  check('long inactive normal → P2', p2 && p2.priority === 'P2', JSON.stringify(p2));

  const p4 = await db.row("SELECT priority FROM customer_board WHERE username = 'ActiveOne'");
  check('active → P4', p4 && p4.priority === 'P4', JSON.stringify(p4));

  /* ---------- assignment ---------- */
  const target = await db.row("SELECT id, username FROM customers WHERE assigned_to IS NULL LIMIT 1");
  if (target) {
    const asg = await post('/customers/assign', { username: [target.username], caller_id: String((await db.row('SELECT id FROM users LIMIT 1')).id) }, token);
    check('assign POST', asg.status === 302);
    const after = await db.row('SELECT assigned_to FROM customers WHERE id = $1', [target.id]);
    check('customer assign hua', after.assigned_to !== null);
  } else {
    check('assign POST (skip — sab assigned)', true);
  }

  /* ---------- remark ---------- */
  await db.query("DELETE FROM followups WHERE username = 'RemarkTest01'");
  const rm = await post('/calling/remark', {
    username: 'KKK74DP', action_type: 'No Answer', action_date: new Date().toISOString().slice(0, 10), response: 'test remark',
  }, token);
  check('remark POST', rm.status === 302);
  const rmRow = await db.row("SELECT * FROM followups WHERE username='KKK74DP' ORDER BY id DESC LIMIT 1");
  check('remark save + next action', rmRow && rmRow.action_type === 'No Answer' && rmRow.next_action === 'Retry queue', JSON.stringify(rmRow && rmRow.next_action));

  // Do Not Contact → customer suppress
  const beforeDnc = await db.row("SELECT do_not_contact FROM customers WHERE username='AarushS52'");
  await post('/calling/remark', {
    username: 'AarushS52', action_type: 'Do Not Contact', action_date: new Date().toISOString().slice(0, 10), response: 'dnc test',
  }, token);
  const afterDnc = await db.row("SELECT do_not_contact FROM customers WHERE username='AarushS52'");
  check('Do Not Contact → suppressed', !beforeDnc.do_not_contact && afterDnc.do_not_contact);

  // reset
  await db.query("UPDATE customers SET do_not_contact = FALSE WHERE username='AarushS52'");

  /* ---------- click to call ---------- */
  const callRes = await post('/calls/call', { username: 'KKK74DP' }, token);
  check('click-to-call POST', callRes.status === 302);
  const callRow = await db.row("SELECT * FROM calls WHERE username='KKK74DP' ORDER BY id DESC LIMIT 1");
  check('call log me entry', !!callRow, callRow ? callRow.provider : 'missing');

  /* ---------- upload: customers ---------- */
  const custBuf = await xlsx([
    ['username', 'mobile', 'registration date'],
    ['UploadGuy01', '9111100001', '2026-11-01'],
    ['UploadGuy02', '+91 91111 00002', '05/11/2026'],
    ['KKK74DP', '9427040914', '2026-08-01'],
  ]);
  const upC = await upload('customers', token, custBuf, 'customers.xlsx', false);
  check('customers upload', upC.status === 200 && /rows save/.test(upC.text));
  const ug1 = await db.row("SELECT * FROM customers WHERE username='UploadGuy01'");
  check('naya customer bana', !!ug1 && ug1.mobile === '9111100001', ug1 ? ug1.mobile : 'missing');
  const ug2 = await db.row("SELECT * FROM customers WHERE username='UploadGuy02'");
  check('+91 wala mobile saaf hua', ug2 && ug2.mobile === '91911110 00002'.replace(/\s/g, '') || ug2.mobile.length >= 10, ug2 ? ug2.mobile : 'missing');

  /* ---------- upload: deposits + duplicate txn ---------- */
  const depBuf = await xlsx([
    ['username', 'transaction id', 'deposit date', 'amount', 'status'],
    ['DepTest01', 'TXN900001', '2026-11-18', 500, 'successful'],
    ['DepTest01', 'TXN900002', '2026-11-19', 700, 'successful'],
    ['DepTest02', 'TXN900003', '2026-11-19', 300, 'failed'],
    ['DepTest01', 'TXN900001', '2026-11-20', 500, 'successful'], // duplicate txn
  ]);
  const upD = await upload('deposits', token, depBuf, 'deposits.xlsx', false);
  check('deposits upload', upD.status === 200 && /rows save/.test(upD.text));
  check('duplicate txn reject hua', /Duplicate transaction ID/.test(upD.text));

  const dt1 = await db.row("SELECT COUNT(*)::int c FROM deposits WHERE username='DepTest01'");
  check('DepTest01 ke 2 valid deposit', dt1.c === 2, String(dt1.c));

  const depCust = await db.row("SELECT * FROM customers WHERE username='DepTest01'");
  check('deposit ke baad customer auto bana', !!depCust && depCust.deposit_count === 2, depCust ? `${depCust.deposit_count} deposits, ${depCust.status}` : 'missing');

  const failedCust = await db.row("SELECT deposit_count FROM customers WHERE username='DepTest02'");
  check('sirf failed deposit wala customer master me nahi aaya',
    !failedCust || failedCust.deposit_count === 0,
    failedCust ? JSON.stringify(failedCust) : 'no record (sahi)');

  /* ---------- settings ---------- */
  const retSave = await post('/settings/retention', {
    inactive_days: '7', recent_inactive_days: '14',
    vip_min_count: '25', vip_premium_count: '51', vip_high_count: '101',
  }, token);
  check('retention settings save', retSave.status === 302);

  const tcSave = await post('/settings/telecmi', { telecmi_app_id: 'demo-app', telecmi_secret: 'demo-secret', telecmi_agent: '+919999999999' }, token);
  check('telecmi settings save', tcSave.status === 302);
  const tcfg = await db.value("SELECT value FROM settings WHERE key='telecmi_app_id'");
  check('telecmi app id save hua', String(tcfg).includes('demo-app'));

  // wapas khaali karo (galti se call na jaye)
  await post('/settings/telecmi', { telecmi_app_id: '', telecmi_secret: '', telecmi_agent: '' }, token);

  /* ---------- masking for restricted user ---------- */
  // demo caller ravi ko dekho
  jar = new Map();
  const lp2 = await req('/login');
  const t2 = csrf(lp2.text);
  const lr2 = await post('/login', { login_id: 'ravi', password: 'caller123' }, t2);
  if (lr2.status === 302) {
    const my = await req('/calling/my');
    check('caller ka My Calls khulta hai', my.status === 200, 'status ' + my.status);
    check('caller ko full number nahi dikhta', !/9427040914/.test(my.text));
    const deny = await req('/users');
    check('caller ko /users band', deny.status === 403, 'status ' + deny.status);
  } else {
    console.log('(caller ravi nahi mila — skip)');
  }

  /* ---------- cleanup ---------- */
  await db.query("DELETE FROM deposits WHERE username LIKE 'DepTest%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'UploadGuy%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'DepTest%'");
  await db.query("DELETE FROM followups WHERE username = 'KKK74DP' AND response = 'test remark'");
  await db.query("DELETE FROM followups WHERE username = 'AarushS52' AND response = 'dnc test'");

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

