'use strict';

/* v4.3.1 — bulk assign ka WHERE bug + unassign button.
   Run: DATABASE_URL=... node tests/bulkassign.js */

process.env.PORT = process.env.PORT || '3390';
require('dotenv').config();

const BASE = `http://127.0.0.1:${process.env.PORT}`;

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
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];
  async function post(path, fields, token) {
    const p = new URLSearchParams();
    if (token) p.append('csrf_token', token);
    for (const [k, v] of Object.entries(fields || {})) {
      if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
      else p.append(k, v);
    }
    return req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() });
  }
  return { req, post, csrf };
}
async function loginAs(b, id, pw) {
  const lp = await b.req('/login');
  return b.post('/login', { login_id: id, password: pw }, b.csrf(lp.text));
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const D = require('../src/lib/dates');
const iso = (n) => D.addDays(D.todayISO(), -n);

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2800));
  const db = require('../src/db');
  const bcrypt = require('bcryptjs');

  /* ---------------- fixtures ---------------- */
  await db.query("DELETE FROM users WHERE login_id LIKE 'ba_%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'BaT%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'BaT%'");

  const pass = await bcrypt.hash('ba1234', 10);
  const mk = async (name, login) => (await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval, daily_target)
     VALUES ($1,$2,$3,'admin',$4,FALSE,150) RETURNING id`,
    [name, login, pass, ['mycalls', 'customers']]
  )).rows[0].id;

  const arun = await mk('arun', 'ba_arun');
  const kamal = await mk('kamal', 'ba_kamal');

  // 300 customers: 100 P1-ish (inactive 10 din), 200 P2 (inactive 40 din)
  let n = 0;
  for (let i = 0; i < 300; i++) {
    n++;
    const u = 'BaT' + String(n).padStart(4, '0');
    await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
       VALUES ($1,$2,$3,500,'successful','test')`,
      [iso(i < 100 ? 10 : 40), u, '9' + String(100000000 + n)]
    );
  }
  await require('../src/lib/customers').syncCustomers();

  const all = Number(await db.value("SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%'"));
  check('300 test customers', all === 300, String(all));

  // sab arun ko de do (purani haalat)
  await db.query(
    `UPDATE customers SET assigned_to = $1 WHERE username LIKE 'BaT%'`, [arun]
  );
  check('sab arun ke paas', Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%' AND assigned_to = $1", [arun]
  )) === 300);

  const admin = newBrowser();
  await loginAs(admin, 'admin', 'admin123');

  /* ---------------- 1. filter ke bina bulk assign → block ---------------- */
  const page0 = await admin.req('/customers');
  const t0 = admin.csrf(page0.text);

  const noFilter = await admin.post('/customers/assign', {
    caller_id: String(kamal), assign_filter: '1',
    f_status: '', f_vip: '', f_priority: '', f_caller: '', f_q: '',
  }, t0);
  check('filter khali → block (302)', noFilter.status === 302);

  const afterNoFilter = Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%' AND assigned_to = $1", [kamal]
  ));
  check('SAARE customers kamal ko NAHI gaye', afterNoFilter === 0, String(afterNoFilter));

  /* ---------------- 2. caller chune bina assign → error ---------------- */
  const noCaller = await admin.post('/customers/assign', {
    caller_id: '', assign_filter: '1', f_caller: String(arun),
  }, t0);
  check('caller khali → assign nahi hota', noCaller.status === 302);
  check('kuch bhi unassign nahi hua', Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%' AND assigned_to IS NULL"
  )) === 0);

  /* ---------------- 3. asli filter (caller=arun) → sirf wahi ---------------- */
  const r3 = await admin.post('/customers/assign', {
    caller_id: String(kamal), assign_filter: '1',
    f_caller: String(arun), f_status: '', f_vip: '', f_priority: '', f_q: '',
  }, t0);
  check('filter caller=arun par assign', r3.status === 302);

  const kamalCount = Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%' AND assigned_to = $1", [kamal]
  ));
  check('300 customers kamal ko', kamalCount === 300, String(kamalCount));

  /* ---------------- 4. priority filter ko respect kare ---------------- */
  // sab wapas arun ko
  await db.query("UPDATE customers SET assigned_to = $1 WHERE username LIKE 'BaT%'", [arun]);
  const p1Count = Number(await db.value(
    "SELECT COUNT(*)::int FROM customer_board WHERE username LIKE 'BaT%' AND priority = 'P1'"
  ));

  await admin.post('/customers/assign', {
    caller_id: String(kamal), assign_filter: '1',
    f_caller: String(arun), f_priority: 'P1', f_status: '', f_vip: '', f_q: '',
  }, t0);

  const movedP1 = Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%' AND assigned_to = $1", [kamal]
  ));
  check('priority=P1 filter respect hua (sirf P1 gaye)', movedP1 === p1Count,
    `${movedP1} vs P1=${p1Count}`);
  check('P1 sirf ek hissa hai (sab nahi)', movedP1 < 300 && movedP1 > 0, String(movedP1));

  /* ---------------- 5. search filter (q) bhi respect ho ---------------- */
  await db.query("UPDATE customers SET assigned_to = $1 WHERE username LIKE 'BaT%'", [arun]);
  await admin.post('/customers/assign', {
    caller_id: String(kamal), assign_filter: '1',
    f_caller: String(arun), f_q: 'BaT01', f_status: '', f_vip: '', f_priority: '',
  }, t0);
  const movedQ = Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%' AND assigned_to = $1", [kamal]
  ));
  check('q search respect hua (BaT01xx = 100)', movedQ === 100, String(movedQ));

  /* ---------------- 6. "Bina caller karein" — unassign ---------------- */
  await db.query("UPDATE customers SET assigned_to = $1 WHERE username LIKE 'BaT%'", [arun]);
  const r6 = await admin.post('/customers/assign', {
    unassign: '1', f_caller: String(arun), f_status: '', f_vip: '', f_priority: '', f_q: '',
  }, t0);
  check('unassign POST', r6.status === 302);

  const unassigned = Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%' AND assigned_to IS NULL"
  ));
  check('300 customers bina caller', unassigned === 300, String(unassigned));

  /* ---------------- 7. unassign se data delete na ho ---------------- */
  const stillThere = Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username LIKE 'BaT%'"
  ));
  check('customers delete nahi hue', stillThere === 300, String(stillThere));

  /* ---------------- 8. remark/call history safe ---------------- */
  await db.query(
    `INSERT INTO followups (username, action_type, action_date, response, next_action, follow_up_on)
     VALUES ('BaT0001','No Answer',$1,'before unassign','Retry queue',$2)`,
    [D.todayISO(), D.addDays(D.todayISO(), 1)]
  );
  await admin.post('/customers/assign', {
    unassign: '1', f_caller: '', f_status: '', f_vip: '', f_priority: '', f_q: 'BaT0001',
  }, t0);
  const fu = Number(await db.value(
    "SELECT COUNT(*)::int FROM followups WHERE username = 'BaT0001'"
  ));
  check('unassign ke baad remark safe', fu >= 1, String(fu));

  /* ---------------- 9. page par naye controls ---------------- */
  const page = await admin.req('/customers');
  check('"Bina caller karein" button', /Bina caller karein/.test(page.text));
  check('hidden filter fields', /name="f_priority"/.test(page.text) && /name="f_caller"/.test(page.text));
  check('filter badge', /filter laga hua|koi filter nahi/.test(page.text));
  check('"caller chunein" (hatao nahi)', /caller chunein/.test(page.text));

  /* ---------------- 10. select se selected customers (purana raasta) ---------------- */
  await db.query("UPDATE customers SET assigned_to = NULL WHERE username LIKE 'BaT%'");
  const usernames = ['BaT0001', 'BaT0002', 'BaT0003'];
  await admin.post('/customers/assign', {
    caller_id: String(arun), username: usernames,
  }, t0);
  const picked = Number(await db.value(
    "SELECT COUNT(*)::int FROM customers WHERE username = ANY($1::text[]) AND assigned_to = $2",
    [usernames, arun]
  ));
  check('chune hue 3 assign hue', picked === 3, String(picked));

  /* ---------------- cleanup ---------------- */
  await db.query("DELETE FROM deposits WHERE username LIKE 'BaT%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'BaT%'");
  await db.query("DELETE FROM followups WHERE username LIKE 'BaT%'");
  await db.query("DELETE FROM users WHERE login_id LIKE 'ba_%'");

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

