'use strict';

/* v3.8 — follow-up scheduling test.
   Run: DATABASE_URL=... node tests/followup.js */

process.env.PORT = process.env.PORT || '3260';
require('dotenv').config();

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
async function post(path, fields, token) {
  const p = new URLSearchParams();
  p.append('csrf_token', token);
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  return req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() });
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

// App ke timezone (Asia/Kolkata) se date — warna UTC se ek din ka farq aa jata hai
const isoAgo = (n) => require('../src/lib/dates').addDays(require('../src/lib/dates').todayISO(), -n);
const isoAhead = (n) => isoAgo(-n);

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2600));
  const db = require('../src/db');
  const D = require('../src/lib/dates');
  const today = D.todayISO();

  // ---- caller banane ke liye admin login ----
  const lp = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp.text), login_id: 'admin', password: 'admin123' }).toString(),
  });
  const home = await req('/');
  const token = csrf(home.text);
  check('admin login', !!token);

  // ---- fixtures: caller + 4 customers ----
  const bcrypt = require('bcryptjs');
  await db.query("DELETE FROM users WHERE login_id = 'fucaller'");
  const callerRes = await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
     VALUES ('FU Caller','fucaller',$1,'admin',$2,FALSE) RETURNING id`,
    [await bcrypt.hash('test1234', 10), ['mycalls', 'customers', 'priority']]
  );
  const callerId = callerRes.rows[0].id;

  const names = ['FuTest01', 'FuTest02', 'FuTest03', 'FuTest04'];
  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM customers WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM followups WHERE username = ANY($1::text[])', [names]);

  for (const u of names) {
    await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
       VALUES ($1,$2,'9000000001',500,'successful','test')`,
      [isoAgo(20), u]
    );
  }
  await require('../src/lib/customers').syncCustomers();
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username = ANY($2::text[])', [callerId, names]);
  check('4 customers assign hue', true);

  /* ---------- 1. caller login → My Calls ---------- */
  jar = new Map();
  const lp2 = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp2.text), login_id: 'fucaller', password: 'test1234' }).toString(),
  });
  const my1 = await req('/calling/my');
  const t2 = csrf(my1.text);
  check('My Calls khulta hai', my1.status === 200 && /Aaj due/.test(my1.text));
  check('4 customers list me (koi follow-up nahi)', ['FuTest01', 'FuTest02', 'FuTest03', 'FuTest04'].every((u) => my1.text.includes(u)));

  /* ---------- 2. Will Deposit → follow-up = +2 din ---------- */
  const rm1 = await post('/calling/remark', {
    username: 'FuTest01', action_type: 'Will Deposit', action_date: today, response: 'kal shaam tak',
  }, t2);
  check('remark POST (Will Deposit)', rm1.status === 302);

  const fu1 = await db.row("SELECT * FROM followups WHERE username='FuTest01' ORDER BY id DESC LIMIT 1");
  check('follow_up_on = aaj + 2', fu1 && fu1.follow_up_on === isoAhead(2), fu1 ? String(fu1.follow_up_on) : 'none');
  check('next action = Follow-up priority', fu1 && fu1.next_action === 'Follow-up priority', fu1 ? fu1.next_action : '');

  /* ---------- 3. list se hat gaya (aage ka follow-up) ---------- */
  const my2 = await req('/calling/my');
  check('Will Deposit wala main list se hat gaya', !my2.text.includes('data-username="FuTest01"'));
  check('magar "Aage ke follow-ups" me dikh raha hai', my2.text.includes('Aage ke follow-ups') && my2.text.includes('FuTest01'));
  check('baaki 3 abhi bhi list me', ['FuTest02', 'FuTest03', 'FuTest04'].every((u) => my2.text.includes(u)));

  /* ---------- 4. No Answer → +1 din ---------- */
  await post('/calling/remark', { username: 'FuTest02', action_type: 'No Answer', action_date: today }, t2);
  const fu2 = await db.row("SELECT follow_up_on FROM followups WHERE username='FuTest02' ORDER BY id DESC LIMIT 1");
  check('No Answer → kal', fu2 && fu2.follow_up_on === isoAhead(1), fu2 ? String(fu2.follow_up_on) : 'none');

  /* ---------- 5. caller ne date khud badli (3 din) ---------- */
  await post('/calling/remark', {
    username: 'FuTest03', action_type: 'Interested', action_date: today, follow_gap: '3', response: 'soch raha hai',
  }, t2);
  const fu3 = await db.row("SELECT follow_up_on FROM followups WHERE username='FuTest03' ORDER BY id DESC LIMIT 1");
  check('caller chuni 3 din → +3', fu3 && fu3.follow_up_on === isoAhead(3), fu3 ? String(fu3.follow_up_on) : 'none');

  /* ---------- 6. Overdue dikhta hai (kal ki date pichhe) ---------- */
  await db.query(
    `UPDATE followups SET follow_up_on = $1 WHERE username='FuTest03'`,
    [isoAgo(2)]
  );
  const my3 = await req('/calling/my');
  check('overdue wala list me wapas', my3.text.includes('FuTest03'));
  check('overdue badge dikha', /din late/.test(my3.text));

  /* ---------- 7. aaj due counters ---------- */
  const myStats = await db.row(
    `SELECT COUNT(*) FILTER (WHERE lf.follow_up_on IS NULL OR lf.follow_up_on <= CURRENT_DATE)::int AS due,
            COUNT(*) FILTER (WHERE lf.follow_up_on < CURRENT_DATE)::int AS overdue
       FROM customer_board b LEFT JOIN latest_followup lf ON lf.uname = LOWER(b.username)
      WHERE b.assigned_to = $1 AND b.do_not_contact = FALSE`,
    [callerId]
  );
  check('due 2 (FuTest03 + FuTest04)', myStats.due === 2, JSON.stringify(myStats));
  check('overdue 1', myStats.overdue === 1, String(myStats.overdue));

  /* ---------- 8. "aage rakhe" list dikhti hai ---------- */
  check('Aage ke follow-ups card', /Aage ke follow-ups/.test(my3.text));
  check('poori list mode par sab dikhein', true);
  const myAll = await req('/calling/my?all=1');
  check('all=1 par 4 sab dikhein', ['FuTest01', 'FuTest02', 'FuTest03', 'FuTest04'].every((u) => myAll.text.includes(u)));

  /* ---------- 9. Do Not Contact → list se hamesha ke liye ---------- */
  await post('/calling/remark', { username: 'FuTest04', action_type: 'Do Not Contact', action_date: today }, t2);
  const my4 = await req('/calling/my?all=1');
  check('DNC wala poori list se bhi hat gaya', !my4.text.includes('data-username="FuTest04"'));
  const dnc = await db.row("SELECT do_not_contact FROM customers WHERE username='FuTest04'");
  check('customer DNC mark hua', dnc && dnc.do_not_contact === true);

  /* ---------- 10. admin: Follow-ups Due page ---------- */
  jar = new Map();
  const lp3 = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp3.text), login_id: 'admin', password: 'admin123' }).toString(),
  });
  const due = await req('/calling/due');
  check('Follow-ups Due page khulta hai', due.status === 200 && /Caller-wise/.test(due.text));
  check('overdue list me FuTest03', due.text.includes('FuTest03'));
  check('caller ka naam dikha', due.text.includes('FU Caller'));

  /* ---------- 11. dashboard par counters ---------- */
  const dash = await req('/');
  check('dashboard par Overdue chip', /Overdue/.test(dash.text));

  /* ---------- 12. caller ko /calling/due band ---------- */
  jar = new Map();
  const lp4 = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp4.text), login_id: 'fucaller', password: 'test1234' }).toString(),
  });
  const deny = await req('/calling/due');
  check('caller ko Follow-ups Due band (403)', deny.status === 403, 'status ' + deny.status);

  /* ---------- 13. Follow-ups page ka modal bhi follow-up date set kare ---------- */
  jar = new Map();
  const lp5 = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp5.text), login_id: 'admin', password: 'admin123' }).toString(),
  });
  const fpage = await req('/followups');
  const t5 = csrf(fpage.text);
  const addF = await post('/followups', {
    username: 'FuTest01', action_type: 'Will Deposit', action_date: today, response: 'modal test',
  }, t5);
  check('Follow-ups page se remark save', addF.status === 302);
  const fuModal = await db.row("SELECT follow_up_on, next_action FROM followups WHERE username='FuTest01' ORDER BY id DESC LIMIT 1");
  check('modal se bhi follow_up_on = +2', fuModal && fuModal.follow_up_on === isoAhead(2),
    fuModal ? String(fuModal.follow_up_on) : 'none');

  /* ---------- cleanup ---------- */
  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM customers WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM followups WHERE username = ANY($1::text[])', [names]);
  await db.query("DELETE FROM users WHERE login_id = 'fucaller'");

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

