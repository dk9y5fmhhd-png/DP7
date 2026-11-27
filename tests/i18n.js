'use strict';

/* Languages: every phrase has Hindi, placeholders match, and the switch works.
   Run on an EMPTY test database: DATABASE_URL=... npm run test:i18n */

process.env.PORT = process.env.PORT || '3651';
process.env.SEED_ADMIN_PASSWORD = 'admin123';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const i18n = require('../src/lib/i18n');
const hi = require('../src/locales/hi.json');

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? (e.name === 'views' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
const files = [...walk(path.join(__dirname, '..', 'views')), ...walk(path.join(__dirname, '..', 'src'))]
  .filter((f) => /\.(ejs|js)$/.test(f));
const used = new Set();
for (const f of files) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:\b_t|\b_th|\b_js|i18n\.t)\(\s*'((?:\\.|[^'\\])*)'/g)) {
    used.add(m[1].replace(/\\(['\\])/g, '$1'));
  }
}
const letters = (k) => /[A-Za-z]{2,}/.test(k.replace(/\{\w+\}|<[^>]+>|&\w+;/g, ''));
const missing = [...used].filter((k) => letters(k) && !(k in hi));
check(`every screen phrase has Hindi (${used.size} checked)`, !missing.length, missing.slice(0, 8).join(' | '));

const shape = (s) => JSON.stringify([s.match(/\{\w+\}/g)?.sort(), s.match(/<\/?[a-z]+/g)?.sort()]);
const broken = Object.keys(hi).filter((k) => shape(k) !== shape(hi[k]));
check('placeholders and tags match in every entry', !broken.length, broken.slice(0, 5).join(' | '));

const { PAGES } = require('../src/auth');
const { ALL_ACTIONS } = require('../src/lib/remarks');
const labels = [...PAGES.map((p) => p.label), ...ALL_ACTIONS].filter((k) => !(k in hi));
check('menu and remark names have Hindi', !labels.length, labels.join(' | '));

check('finished message matched by pattern',
  i18n.tm('12 customers assigned.', 'hi') === hi['{a} customers assigned.'].replace('{a}', '12'));
check('unknown message left as it is', i18n.tm('Something typed by a person', 'hi') === 'Something typed by a person');
check('typed values are escaped inside markup', !i18n.th('<strong>{n}</strong> rows', { n: '<script>' }, 'hi').includes('<script>'));

(async () => {
  const BASE = `http://127.0.0.1:${process.env.PORT}`;
  const db = require('../src/db');
  require('../src/server');
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await db.value("SELECT 1 FROM users WHERE login_id = 'admin' AND language IS NULL").catch(() => 0)) break;
  }
  await new Promise((r) => setTimeout(r, 800));

  const client = () => {
    const jar = new Map();
    const c = {
      async req(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const r = await fetch(BASE + p, { ...o, headers, redirect: 'manual' });
        for (const s of r.headers.getSetCookie()) { const [a] = s.split(';'); const i = a.indexOf('='); jar.set(a.slice(0, i), a.slice(i + 1)); }
        return { status: r.status, text: await r.text(), location: r.headers.get('location') };
      },
      token: async (p) => ((await c.req(p)).text.match(/name="csrf_token" value="([^"]+)"/) || [])[1],
      post: (p, body, headers = {}) => c.req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() }),
    };
    return c;
  };

  const a = client();
  check('sign-in page is English by default', (await a.req('/login')).text.includes('Sign in'));
  let t = await a.token('/login');
  const sw = await a.post('/language', { csrf_token: t, lang: 'hi' }, { referer: 'https://evil.example/x' });
  check('switch never redirects to another site', sw.location === '/');
  const login = (await a.req('/login')).text;
  check('sign-in page in Hindi', login.includes(hi['Sign in']) && login.includes('lang="hi"'));
  await a.post('/login', { csrf_token: await a.token('/login'), login_id: 'admin', password: 'admin123' });
  const home = (await a.req('/')).text;
  check('choice kept after sign-in', home.includes(hi.Dashboard));
  check('choice saved on the account', (await db.value("SELECT language FROM users WHERE login_id = 'admin'")) === 'hi');

  t = await a.token('/security');
  await a.post('/security/password', { csrf_token: t, current: 'x', current_password: 'x', new_password: '1', confirm_password: '2' });
  const flashed = (await a.req('/security')).text.match(/class="flash flash-error">[\s\S]*?<span>([^<]*)/);
  check('server message shown in Hindi', flashed && /[\u0900-\u097F]/.test(flashed[1]), flashed?.[1]);

  const pages = ['/', '/customers', '/new-clients', '/calling', '/calling/my', '/calling/due', '/calls', '/upload', '/add-data',
    '/reports', '/reports/level', '/reports/daily', '/reports/weekly', '/reports/biweekly', '/reports/monthly', '/followups',
    '/cadence', '/assign', '/callers', '/approvals', '/backup', '/users', '/settings', '/settings?tab=retention',
    '/settings?tab=levels', '/settings?tab=cohorts', '/settings/calling', '/security', '/whatsapp', '/whatsapp/history',
    '/whatsapp/numbers', '/whatsapp/templates'];
  for (const lang of ['hi', 'en']) {
    await a.post('/language', { csrf_token: await a.token('/security'), lang });
    const bad = [];
    for (const p of pages) {
      const r = await a.req(p);
      if (r.status !== 200 || !r.text.includes(`<html lang="${lang}">`)) bad.push(`${p} ${r.status}`);
    }
    check(`all ${pages.length} pages open in ${lang}`, !bad.length, bad.join(', '));
  }
  check('English again after switching back', (await a.req('/')).text.includes('>Dashboard<'));

  await a.post('/settings/general', { csrf_token: await a.token('/settings'), default_language: 'hi', site_name: 'DP7', active_window_days: '7', retention_lookback_weeks: '7', cohort_daily_min: '6', cohort_byweekly_min: '2', cohort_weekly_min: '0.75', delete_pin: '969696' });
  await new Promise((r) => setTimeout(r, 200));
  check('system default applies to new visitors', (await client().req('/login')).text.includes('lang="hi"'));

  const fail = results.filter((r) => !r).length;
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
