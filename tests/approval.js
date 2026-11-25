'use strict';

/* v3.9 — admin-approved login, 10-hour session, download block.
   Run: DATABASE_URL=... node tests/approval.js */

process.env.PORT = process.env.PORT || '3280';
require('dotenv').config();

const BASE = `http://127.0.0.1:${process.env.PORT}`;

/* ------------------------- two independent browser sessions ------------------------- */
function newBrowser() {
  const jar = new Map();
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
    return {
      status: res.status,
      text: buf.toString('utf8'),
      location: res.headers.get('location'),
      type: res.headers.get('content-type'),
    };
  }
  const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];
  async function post(path, fields, token) {
    const p = new URLSearchParams();
    if (token) p.append('csrf_token', token);
    for (const [k, v] of Object.entries(fields || {})) p.append(k, v);
    return req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() });
  }
  return { req, post, csrf, jar };
}

async function loginAs(browser, id, pw) {
  const lp = await browser.req('/login');
  return browser.post('/login', { login_id: id, password: pw }, browser.csrf(lp.text));
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2700));
  const db = require('../src/db');
  const bcrypt = require('bcryptjs');
  const auth = require('../src/auth');

  /* ----------------------------- fixtures ----------------------------- */
  await db.query("DELETE FROM users WHERE login_id IN ('ap_call','ap_trust','ap_rep')");
  await db.query('DELETE FROM login_requests');
  const pass = await bcrypt.hash('ap1234', 10);
  const mk = async (name, login, access, requireApproval) => {
    const r = await db.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
       VALUES ($1,$2,$3,'admin',$4,$5) RETURNING id`,
      [name, login, pass, access, requireApproval]
    );
    return r.rows[0].id;
  };
  const callId = await mk('Approval Test', 'ap_call', ['mycalls', 'customers', 'priority', 'reports'], true);
  await mk('Trusted Test', 'ap_trust', ['mycalls', 'customers'], false);
  await mk('Report Test', 'ap_rep', ['reports', 'level_report'], false);
  check('3 test users bane', callId > 0);

  const user = newBrowser();
  const admin = newBrowser();

  /* ---------------------- 1. user → waiting ---------------------- */
  const l1 = await loginAs(user, 'ap_call', 'ap1234');
  check('login → /login/waiting', l1.location === '/login/waiting', 'loc=' + l1.location);

  const wait = await user.req('/login/waiting');
  check('waiting page dikhta hai', wait.status === 200 && /intezaar/i.test(wait.text));

  const st1 = await user.req('/login/status');
  check('status = pending', /"status":"pending"/.test(st1.text), st1.text.slice(0, 42));

  const blocked = await user.req('/customers');
  check('approve se pehle page nahi khulta', blocked.status === 302 && blocked.location === '/login',
    'loc=' + blocked.location);

  const blockData = await user.req('/reports/export?type=level');
  check('approve se pehle export bhi band', blockData.status === 302, 'status ' + blockData.status);

  /* ---------------------- 2. admin ko request ---------------------- */
  await loginAs(admin, 'admin', 'admin123');
  const ap = await admin.req('/approvals');
  check('admin ko /approvals khulta hai', ap.status === 200 && /Pending requests/.test(ap.text));
  check('pending me ap_call dikhta hai', ap.text.includes('ap_call'));
  check('pending counter 1', /id="pendingCount">1</.test(ap.text));

  const reqRow = await db.row("SELECT id FROM login_requests WHERE login_id='ap_call' AND status='pending'");
  check('DB me pending request', !!reqRow);

  /* ---------------------- 3. approve → user ka login ---------------------- */
  const tA = admin.csrf(ap.text);
  const appr = await admin.post(`/approvals/${reqRow.id}/approve`, {}, tA);
  check('approve POST', appr.status === 302);
  check('status = approved', (await db.row('SELECT status FROM login_requests WHERE id=$1', [reqRow.id])).status === 'approved');

  // wahi USER browser — usi session me
  const st2 = await user.req('/login/status');
  check('user ko approved dikha', /"status":"approved"/.test(st2.text), st2.text.slice(0, 42));

  const w2 = await user.req('/login/waiting');
  check('waiting → /login/complete', w2.status === 302 && w2.location === '/login/complete',
    'loc=' + w2.location);

  const done = await user.post('/login/complete', {}, user.csrf(wait.text));
  check('complete → session bana', done.status === 302 && done.location !== '/login', 'loc=' + done.location);

  const home = await user.req('/customers');
  check('ab Customers page khulta hai', home.status === 200, 'status ' + home.status);

  /* ---------------------- 4. session 10 ghante ---------------------- */
  // browser ke apne cookie se exact sid nikaalo
  const rawCookie = user.jar.get('connect.sid') || '';
  const sid = decodeURIComponent(rawCookie).replace(/^s:/, '').split('.')[0];
  const row = await db.row('SELECT sid, sess FROM session WHERE sid = $1', [sid]);
  let userSess = null;
  if (row) {
    const o = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
    userSess = { sid: row.sid, obj: o };
  }
  check('browser ka session DB me mila', !!userSess, sid.slice(0, 10) + '…');
  check('session me wahi user hai', !!userSess && userSess.obj.user && userSess.obj.user.login_id === 'ap_call');
  const hours = userSess ? Math.round((Number(userSess.obj.expiresAt) - Date.now()) / 3600000) : -1;
  check('session ~10 ghante ka', hours >= 9 && hours <= 10, hours + 'h');

  const cookieMaxAge = 10 * 60 * 60 * 1000;
  check('auth.sessionMs() = 10h', auth.sessionMs() === cookieMaxAge, String(auth.sessionMs()));

  /* ---------------------- 5. 10 ghante baad → logout ---------------------- */
  // (a) session store se row hat gayi (10 ghante poore) → koi page nahi khulta
  await db.query('DELETE FROM session WHERE sid = $1', [userSess.sid]);
  const afterExpiry = await user.req('/customers');
  check('10 ghante baad refresh → login par logout',
    afterExpiry.status === 302 && afterExpiry.location === '/login',
    'loc=' + afterExpiry.location);

  // (b) cookie zinda hai par andar ka clock khatam → /login?expired=1
  const fakeExpired = { session: { user: { id: 1 }, expiresAt: Date.now() - 1000 } };
  const fakeLive = { session: { user: { id: 1 }, expiresAt: Date.now() + 60000 } };
  check('sessionExpired() khatam par true', auth.sessionExpired(fakeExpired) === true);
  check('sessionExpired() chalu par false', auth.sessionExpired(fakeLive) === false);
  check('bina loginAt/expiresAt wale session par false', auth.sessionExpired({ session: { user: { id: 1 } } }) === false);

  // expired banner wala login page
  const loginPage = await newBrowser().req('/login?expired=1');
  check('login page par "Session khatam" message', /Session khatam ho gaya/.test(loginPage.text));

  // dobara login → phir se approval
  await db.query("DELETE FROM login_requests WHERE login_id = 'ap_call'");
  const again = await loginAs(user, 'ap_call', 'ap1234');
  check('expiry ke baad dobara approval chahiye', again.location === '/login/waiting', 'loc=' + again.location);

  /* ---------------------- 6. reject ---------------------- */
  await db.query("DELETE FROM login_requests WHERE login_id = 'ap_call'");
  const l3 = await loginAs(user, 'ap_call', 'ap1234');
  check('reject test: login → waiting', l3.location === '/login/waiting', 'loc=' + l3.location);
  const newReq = await db.row("SELECT id FROM login_requests WHERE status='pending' ORDER BY id DESC LIMIT 1");
  check('reject test ke liye pending request', !!newReq);

  const ap2 = await admin.req('/approvals');
  const rej = await admin.post(`/approvals/${newReq.id}/reject`, { reason: 'test' }, admin.csrf(ap2.text));
  check('reject POST', rej.status === 302);
  check('status = rejected',
    (await db.row('SELECT status FROM login_requests WHERE id=$1', [newReq.id])).status === 'rejected');

  const stR = await user.req('/login/status');
  check('user ko rejected dikha', /"status":"rejected"/.test(stR.text), stR.text.slice(0, 42));

  // rejected ke baad bhi koi page nahi
  const afterReject = await user.req('/customers');
  check('reject ke baad page band', afterReject.status === 302, 'status ' + afterReject.status);

  /* ---------------------- 7. trusted + super admin bypass ---------------------- */
  const lTrust = await loginAs(newBrowser(), 'ap_trust', 'ap1234');
  check('require_approval=false → seedha login', lTrust.location !== '/login/waiting', 'loc=' + lTrust.location);

  const lAdmin = await loginAs(newBrowser(), 'admin', 'admin123');
  check('super_admin ko approval nahi', lAdmin.location !== '/login/waiting', 'loc=' + lAdmin.location);

  /* ---------------------- 8. download block ---------------------- */
  const reporter = newBrowser();
  const lRep = await loginAs(reporter, 'ap_rep', 'ap1234');
  check('report user login', lRep.location !== '/login/waiting');

  const repPage = await reporter.req('/reports/level');
  check('reports page khulta hai', repPage.status === 200, 'status ' + repPage.status);
  check('par CSV chip nahi dikhta', !/reports\/export/.test(repPage.text));
  check('Print button nahi dikhta', !/data-print/.test(repPage.text));

  for (const p2 of ['/reports/export?type=client', '/reports/export?type=level', '/reports/export?type=weekly', '/backup/export/deposits', '/backup/export/clients']) {
    const r = await reporter.req(p2);
    check(`block: ${p2} → 403`, r.status === 403, 'status ' + r.status);
  }

  check('non-admin /approvals → 403', (await reporter.req('/approvals')).status === 403);
  check('non-admin /approvals/pending.json → 403', (await reporter.req('/approvals/pending.json')).status === 403);

  /* ---------------------- 9. admin ko download milta hai ---------------------- */
  const adminExp = await admin.req('/reports/export?type=level');
  check('admin ko CSV milti hai', adminExp.status === 200 && /text\/csv/.test(adminExp.type || ''),
    adminExp.status + ' ' + (adminExp.type || ''));

  const adminRep = await admin.req('/reports/level');
  check('admin ko CSV chip dikhti hai', /reports\/export/.test(adminRep.text));

  /* ---------------------- 10. pending user ka koi data access nahi ---------------------- */
  const pend = newBrowser();
  await loginAs(pend, 'ap_call', 'ap1234');
  for (const p3 of ['/', '/customers', '/calling/my', '/reports/level', '/upload', '/calls', '/users']) {
    const r = await pend.req(p3);
    check(`pending user ${p3} → login`, r.status === 302 && r.location === '/login', 'loc=' + r.location);
  }

  /* ---------------------- cleanup ---------------------- */
  await db.query("DELETE FROM users WHERE login_id IN ('ap_call','ap_trust','ap_rep')");
  await db.query('DELETE FROM login_requests');

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

