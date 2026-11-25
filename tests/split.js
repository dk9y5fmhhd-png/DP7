'use strict';

/* v4.2 — even auto-split + caller load + scope fixes.
   Run: DATABASE_URL=... node tests/split.js */

process.env.PORT = process.env.PORT || '3340';
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
  const split = require('../src/lib/split');

  /* ================= fixtures ================= */
  await db.query("DELETE FROM users WHERE login_id LIKE 'sp_%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'SpT%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'SpT%'");
  await db.query('DELETE FROM split_runs');

  const pass = await bcrypt.hash('sp1234', 10);
  const mkCaller = async (name, login, team = 'retention') => {
    const r = await db.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval, daily_target, team)
       VALUES ($1,$2,$3,'admin',$4,FALSE,150,$5) RETURNING id`,
      [name, login, pass, ['mycalls', 'customers', 'priority', 'calls', 'newclients'], team]
    );
    return r.rows[0].id;
  };

  const callers = [];
  for (let i = 1; i <= 4; i++) callers.push(await mkCaller('Split C' + i, 'sp_c' + i));

  // 400 customers: 100 P1 (VIP inactive), 150 P2, 150 P4 (active)
  let n = 0;
  const makeCustomer = async (count, opts) => {
    for (let i = 0; i < count; i++) {
      n++;
      const u = 'SpT' + String(n).padStart(4, '0');
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,$4,'successful','test')`,
        [iso(opts.ago), u, '9' + String(100000000 + n), opts.amount]
      );
      // repeat = doosra deposit (7 din ke andar) → status 'active' → P4
      if (opts.repeat) {
        await db.query(
          `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
           VALUES ($1,$2,$3,$4,'successful','test')`,
          [iso(Math.max(0, opts.ago - 2)), u, '9' + String(100000000 + n), opts.amount]
        );
      }
    }
  };
  // P1 = inactive + VIP (25+ deposits) — ek hi deposit se nahi banega, to
  // deposit_count se VIP nahi banayenge; P1 = inactive + <=14 din (recent)
  await makeCustomer(80, { ago: 10, amount: 500 });   // P1 — inactive + 14 din ke andar
  await makeCustomer(120, { ago: 40, amount: 500 });  // P2 — long inactive
  await makeCustomer(200, { ago: 1, amount: 500, repeat: true }); // P4 — active (2 deposits)

  await require('../src/lib/customers').syncCustomers();

  const tot = await db.row(
    `SELECT COUNT(*)::int AS all_c,
            COUNT(*) FILTER (WHERE assigned_to IS NULL)::int AS unassigned
       FROM customers WHERE username LIKE 'SpT%'`
  );
  check('400 test customers bane', tot.all_c === 400, JSON.stringify(tot));

  const prio = await db.rows(
    `SELECT priority, COUNT(*)::int AS c FROM customer_board
      WHERE username LIKE 'SpT%' GROUP BY priority ORDER BY priority`
  );
  console.log('   priority mix:', prio.map((p) => `${p.priority}=${p.c}`).join(' '));

  /* ================= 1. buildPlan — barabar baant ================= */
  const plan = await split.buildPlan({ callerIds: callers, scope: 'unassigned' });
  check('plan total 400', plan.total === 400, String(plan.total));
  const counts = callers.map((id) => plan.counts[id].count);
  check('4 callers me 100-100', counts.every((c) => c === 100), counts.join(','));

  /* ================= 2. priority mix har caller me ================= */
  const p1PerCaller = callers.map((id) => plan.counts[id].P1);
  check('P1 sab callers me bant gaya (koi 0 nahi)', p1PerCaller.every((c) => c > 0), p1PerCaller.join(','));
  const spread = Math.max(...p1PerCaller) - Math.min(...p1PerCaller);
  check('P1 ka farq 2 se kam', spread <= 2, 'spread=' + spread);

  const p4PerCaller = callers.map((id) => plan.counts[id].P4);
  check('P4 bhi sab me bant gaya', p4PerCaller.every((c) => c > 0), p4PerCaller.join(','));

  /* ================= 3. P0 kabhi assign nahi ================= */
  const dnc = await db.row("SELECT username FROM customers WHERE username LIKE 'SpT%' LIMIT 1");
  await db.query('UPDATE customers SET do_not_contact = TRUE WHERE username = $1', [dnc.username]);
  const plan2 = await split.buildPlan({ callerIds: callers, scope: 'unassigned' });
  const allNames = [...plan2.plan.values()].flat();
  check('P0 (Do Not Contact) assign nahi hua', !allNames.includes(dnc.username));
  check('ab total 399', plan2.total === 399, String(plan2.total));
  await db.query('UPDATE customers SET do_not_contact = FALSE WHERE username = $1', [dnc.username]);

  /* ================= 4. per_caller cap ================= */
  const capPlan = await split.buildPlan({ callerIds: callers, scope: 'unassigned', perCaller: 50 });
  check('per_caller 50 → har caller 50', callers.every((id) => capPlan.counts[id].count === 50),
    callers.map((id) => capPlan.counts[id].count).join(','));
  check('cap par total 200', capPlan.total === 200, String(capPlan.total));

  /* ================= 5. take limit ================= */
  const takePlan = await split.buildPlan({ callerIds: callers, scope: 'unassigned', take: 60 });
  check('take 60 → total 60', takePlan.total === 60, String(takePlan.total));
  check('take 60 → 15-15', callers.every((id) => takePlan.counts[id].count === 15),
    callers.map((id) => takePlan.counts[id].count).join(','));

  /* ================= 6. priority filter ================= */
  const p2Plan = await split.buildPlan({ callerIds: callers, scope: 'unassigned', priority: 'P2' });
  const allP2 = [...p2Plan.plan.values()].flat();
  const checkP2 = await db.rows(
    `SELECT priority FROM customer_board WHERE username = ANY($1::text[])`, [allP2]
  );
  check('priority=P2 filter kaam karta hai', checkP2.every((r) => r.priority === 'P2'),
    checkP2.length + ' rows');

  /* ================= 7. applyPlan — DB me likha ================= */
  const realPlan = await split.buildPlan({ callerIds: callers, scope: 'unassigned' });
  const applied = await split.applyPlan({
    plan: realPlan.plan, runBy: null, scope: 'unassigned',
    callers: callers.length, perCaller: realPlan.perCaller, total: realPlan.total,
  });
  check('applyPlan ne 400 rows likhe', applied === 400, String(applied));

  const afterApply = await db.row(
    `SELECT COUNT(*) FILTER (WHERE assigned_to IS NULL)::int AS un,
            COUNT(DISTINCT assigned_to)::int AS callers
       FROM customers WHERE username LIKE 'SpT%'`
  );
  check('ab koi unassigned nahi', afterApply.un === 0, JSON.stringify(afterApply));
  check('4 callers me bant gaye', afterApply.callers === 4, String(afterApply.callers));

  const perCallerDb = await db.rows(
    `SELECT assigned_to, COUNT(*)::int AS c FROM customers
      WHERE username LIKE 'SpT%' GROUP BY assigned_to ORDER BY c`
  );
  check('DB me bhi 100-100', perCallerDb.every((r) => r.c === 100), perCallerDb.map((r) => r.c).join(','));

  const runRow = await db.row('SELECT * FROM split_runs ORDER BY id DESC LIMIT 1');
  check('split_runs me record', runRow && runRow.total === 400, runRow ? String(runRow.total) : 'none');

  /* ================= 8. Caller Load page ================= */
  const admin = newBrowser();
  await loginAs(admin, 'admin', 'admin123');

  const loadPage = await admin.req('/callers');
  check('GET /callers', loadPage.status === 200 && /Caller Load/.test(loadPage.text));
  check('Split C1 table me', /Split C1/.test(loadPage.text));
  check('load health badge', /theek|halka|bhaari|zyada|khaali/.test(loadPage.text));
  check('auto-split form hai', /Barabar auto-split/.test(loadPage.text));
  check('caller checkboxes', /name="caller_id"/.test(loadPage.text));
  check('bina caller counter', /Bina caller/.test(loadPage.text));

  /* ================= 9. preview → apply (HTTP) ================= */
  // thode customers unassign karke dobara split karo
  await db.query(
    `UPDATE customers SET assigned_to = NULL
      WHERE id IN (SELECT id FROM customers WHERE username LIKE 'SpT%' ORDER BY id LIMIT 120)`
  );
  const t1 = admin.csrf((await admin.req('/callers')).text);
  const prev = await admin.post('/callers/preview', {
    scope: 'unassigned', priority: '', per_caller: '', take: '',
    caller_id: callers.slice(0, 2).map(String),
  }, t1);
  check('preview POST redirect', prev.status === 302, 'loc=' + prev.location);

  const prevPage = await admin.req('/callers');
  check('preview page par dikhta hai', /Preview — kuch save nahi hua/.test(prevPage.text));
  check('preview me 120 total', /badge badge-warn"[^>]*>120 customers/.test(prevPage.text), '120');

  const beforeApply = Number(await db.value(
    `SELECT COUNT(*)::int FROM customers WHERE username LIKE 'SpT%' AND assigned_to IS NULL`
  ));
  check('apply se pehle 120 unassigned', beforeApply === 120, String(beforeApply));

  const t2 = admin.csrf(prevPage.text);
  const app = await admin.post('/callers/apply', {}, t2);
  check('apply POST', app.status === 302);

  const afterApply2 = Number(await db.value(
    `SELECT COUNT(*)::int FROM customers WHERE username LIKE 'SpT%' AND assigned_to IS NULL`
  ));
  check('apply ke baad 0 unassigned', afterApply2 === 0, String(afterApply2));

  const twoCallers = await db.rows(
    `SELECT assigned_to, COUNT(*)::int AS c FROM customers
      WHERE username LIKE 'SpT%' AND assigned_to = ANY($1::int[]) GROUP BY assigned_to ORDER BY assigned_to`,
    [callers.slice(0, 2)]
  );
  // 120 unassigned 2 callers me barabar (60-60) gaye — har caller ka total 60 se badha
  check('120 rows 2 callers me barabar baante', twoCallers.length === 2, String(twoCallers.length));
  const diff = twoCallers.length === 2 ? Math.abs(twoCallers[0].c - twoCallers[1].c) : 99;
  check('dono callers ka total barabar (farq 0-1)', diff <= 1, twoCallers.map((r) => r.c).join(','));

  /* ================= 10. preview expire / cancel ================= */
  await admin.post('/callers/cancel', {}, admin.csrf((await admin.req('/callers')).text));
  const noPrev = await admin.req('/callers');
  check('cancel ke baad preview nahi', !/Preview — kuch save nahi hua/.test(noPrev.text));

  const staleApply = await admin.post('/callers/apply', {}, admin.csrf(noPrev.text));
  check('bina preview apply → error redirect', staleApply.status === 302);

  /* ================= 11. team change ================= */
  const teamPage = await admin.req('/callers');
  const t3 = admin.csrf(teamPage.text);
  const teamRes = await admin.post(`/callers/${callers[3]}/team`, { team: 'acquisition' }, t3);
  check('team change POST', teamRes.status === 302);
  check('DB me acquisition', (await db.value('SELECT team FROM users WHERE id=$1', [callers[3]])) === 'acquisition');
  check('Caller Load me Acq dikha', /acquisition|Acq/.test((await admin.req('/callers')).text));

  /* ================= 12. /calls scope ================= */
  await db.query(
    `INSERT INTO calls (customer_id, username, caller_id, provider, status, duration_sec)
     VALUES (NULL, 'SpT0001', $1, 'manual', 'completed', 40)`,
    [callers[0]]
  );
  await db.query(
    `INSERT INTO calls (customer_id, username, caller_id, provider, status, duration_sec)
     VALUES (NULL, 'SpT0002', $1, 'manual', 'completed', 40)`,
    [callers[1]]
  );

  const adminCalls = await admin.req('/calls');
  check('admin ko sab calls dikhein', /name="caller"/.test(adminCalls.text));

  const c1 = newBrowser();
  await loginAs(c1, 'sp_c1', 'sp1234');
  const c1Calls = await c1.req('/calls');
  check('caller ko /calls khulta hai', c1Calls.status === 200);
  check('caller ka caller-filter nahi', !/name="caller"/.test(c1Calls.text));
  check('caller ko sirf apni call', /SpT0001/.test(c1Calls.text) && !/SpT0002/.test(c1Calls.text));

  /* ================= 13. /new-clients scope ================= */
  const c1New = await c1.req('/new-clients');
  check('caller ko /new-clients khulta hai', c1New.status === 200);
  check('caller ko CSV chip nahi', !/new-clients\/export/.test(c1New.text));

  const adminNew = await admin.req('/new-clients');
  const adminTotal = Number((adminNew.text.match(/Is mahine naye clients[\s\S]{0,200}?value[^>]*>([\d,]+)/) || [])[1]?.replace(/,/g, '') || 0);
  const c1Total = Number((c1New.text.match(/Is mahine naye clients[\s\S]{0,200}?value[^>]*>([\d,]+)/) || [])[1]?.replace(/,/g, '') || 0);
  check('caller ka count admin se kam', c1Total < adminTotal, `admin=${adminTotal} caller=${c1Total}`);

  /* ================= 14. non-admin /callers 403 ================= */
  check('caller ko /callers 403', (await c1.req('/callers')).status === 403);

  /* ================= cleanup ================= */
  await db.query("DELETE FROM deposits WHERE username LIKE 'SpT%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'SpT%'");
  await db.query("DELETE FROM calls WHERE username LIKE 'SpT%'");
  await db.query("DELETE FROM users WHERE login_id LIKE 'sp_c%'");
  await db.query('DELETE FROM split_runs');

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

