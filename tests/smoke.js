'use strict';

/* Smoke test — starts the app on a throwaway port and walks every page.
   Run: DATABASE_URL=... node tests/smoke.js */

process.env.PORT = process.env.PORT || '3999';
require('dotenv').config();

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const c of list) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
}

async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (jar.size) headers.cookie = cookieHeader();
  const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  absorb(res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location'), type: res.headers.get('content-type') };
}

function csrfFrom(html) {
  const m = html.match(/name="csrf_token" value="([^"]+)"/);
  return m ? m[1] : null;
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function post(path, fields, token) {
  const body = new URLSearchParams({ csrf_token: token, ...fields });
  return req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

async function main() {
  // server start karo (server.js khud listen karta hai)
  require('../src/server');
  await new Promise((r) => setTimeout(r, 1200));

  const health = await req('/health');
  check('GET /health', health.status === 200);

  const loginPage = await req('/login');
  const token = csrfFrom(loginPage.text);
  check('GET /login', loginPage.status === 200 && !!token);

  const badLogin = await post('/login', { login_id: 'admin', password: 'wrong-pass' }, token);
  check('POST /login (galat password)', badLogin.status === 401, 'status ' + badLogin.status);

  const goodLogin = await post('/login', {
    login_id: process.env.SMOKE_LOGIN || 'admin',
    password: process.env.SMOKE_PASSWORD || 'admin123',
  }, token);
  check('POST /login (sahi password)', goodLogin.status === 302, 'status ' + goodLogin.status);

  const home = await req('/');
  const token2 = csrfFrom(home.text);
  check('GET / dashboard', home.status === 200 && /Total clients/i.test(home.text));
  check('dashboard numbers render', /Active/i.test(home.text) && /Retention by habit group/i.test(home.text));

  const pages = [
    ['/add-data', /Add Data/i],
    ['/reports', /Client Reports/i],
    ['/reports/level', /Level Report/i],
    ['/reports/daily', /Daily Report/i],
    ['/reports/weekly', /Weekly Report/i],
    ['/reports/biweekly', /By Weekly Report/i],
    ['/reports/monthly', /Monthly Report/i],
    ['/followups', /Follow-ups/i],
    ['/users', /Existing users/i],
    ['/settings', /Level bands/i],
    ['/security', /Change password/i],
    ['/backup', /Backup &amp; Export|Backup & Export/i],
  ];
  for (const [path, re] of pages) {
    const r = await req(path);
    check(`GET ${path}`, r.status === 200 && re.test(r.text), 'status ' + r.status);
  }

  // duplicate / filter paths
  const dup = await req('/reports?dups=1');
  check('GET /reports?dups=1', dup.status === 200);
  const lvl = await req('/reports/level?sort=count_desc&dups=1');
  check('GET /reports/level sorted+dups', lvl.status === 200);
  const cohortDup = await req('/reports/weekly?dups=1');
  check('GET /reports/weekly?dups=1', cohortDup.status === 200);

  // exports
  for (const t of ['client', 'level', 'weekly', 'daily', 'monthly']) {
    const r = await req('/reports/export?type=' + t);
    check(`GET /reports/export?type=${t}`, r.status === 200 && /text\/csv/.test(r.type || ''));
  }
  for (const what of ['deposits', 'clients', 'followups', 'settings']) {
    const r = await req('/backup/export/' + what);
    check(`GET /backup/export/${what}`, r.status === 200);
  }

  // add data (dry run then real)
  const today = new Date().toISOString().slice(0, 10);
  const sample = `smoketest_a 9000000001 1500\nsmoketest_b 9000000002 250\nbadline\n`;
  const dry = await post('/add-data', { play_date: today, rows: sample, dry: '1' }, token2);
  check('POST /add-data dry run', dry.status === 200 && /Dry run/i.test(dry.text));

  const save = await post('/add-data', { play_date: today, rows: sample, dry: '0' }, token2);
  check('POST /add-data save', save.status === 200 && /save ho gaye/i.test(save.text));

  const db = require('../src/db');
  const inserted = await db.value(
    "SELECT COUNT(*)::int FROM deposits WHERE username LIKE 'smoketest%'"
  );
  check('deposits table me rows gaye', Number(inserted) >= 2, inserted + ' rows');

  const dupeTry = await post('/add-data', { play_date: today, rows: sample, dry: '0' }, token2);
  check('re-upload same day = skip', dupeTry.status === 200 && /pehle se the/i.test(dupeTry.text));

  // follow-up
  const fu = await post('/followups', {
    username: 'smoketest_a',
    action_type: 'Call Again',
    action_date: today,
    response: 'smoke test note',
  }, token2);
  check('POST /followups', fu.status === 302);
  const fuCount = await db.value("SELECT COUNT(*)::int FROM followups WHERE username='smoketest_a'");
  check('followup save hua', Number(fuCount) === 1);

  // cross-check report numbers against SQL
  const totalClients = Number(await db.value('SELECT COUNT(*)::int FROM client_stats'));
  const dashTotal = await req('/');
  check(
    'dashboard total = SQL count',
    dashTotal.text.includes(totalClients.toLocaleString('en-IN')),
    `db=${totalClients}`
  );

  // 2FA: enable → verify code → disable
  const { authenticator } = require('otplib');
  const start2fa = await post('/security/2fa/start', {}, token2);
  const secretMatch = start2fa.text.match(/Manual entry: <code>([A-Z2-7]+)<\/code>/);
  check('POST /security/2fa/start (QR + secret)', start2fa.status === 200 && !!secretMatch);

  if (secretMatch) {
    const secret = secretMatch[1];
    const bad = await post('/security/2fa/confirm', { token: '000000' }, token2);
    check('2FA galat code reject', bad.status === 302 && !/2FA on ho gaya/.test(bad.text));

    const code = authenticator.generate(secret);
    const confirm = await post('/security/2fa/confirm', { token: code }, token2);
    check('POST /security/2fa/confirm (sahi code)', confirm.status === 302);
    const db2 = require('../src/db');
    const enabled = await db2.value('SELECT totp_enabled FROM users WHERE login_id = $1', [
      process.env.SMOKE_LOGIN || 'admin',
    ]);
    check('2FA db me on hua', enabled === true);

    const disable = await post('/security/2fa/disable', {
      password: process.env.SMOKE_PASSWORD || 'admin123',
    }, token2);
    check('POST /security/2fa/disable', disable.status === 302);
    const enabled2 = await db2.value('SELECT totp_enabled FROM users WHERE login_id = $1', [
      process.env.SMOKE_LOGIN || 'admin',
    ]);
    check('2FA wapas off hua', enabled2 === false);
  }

  // unknown page
  const nf = await req('/no-such-page');
  check('404 page', nf.status === 404 && /nahi mila/i.test(nf.text));

  // logout
  const out = await post('/logout', {}, token2);
  check('POST /logout', out.status === 302);
  const afterLogout = await req('/');
  check('logout ke baad redirect', afterLogout.status === 302 && afterLogout.location === '/login');

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(50));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(' - ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')));
  }
  await db.pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('✗ smoke test crashed:', err);
  process.exit(2);
});


