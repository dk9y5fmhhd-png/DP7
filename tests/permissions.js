'use strict';

/* Page-access test: ek limited Admin banata hai aur check karta hai ki wo sirf
   apne pages khol paaye. Run: node tests/permissions.js */

process.env.PORT = process.env.PORT || '3997';
require('dotenv').config();

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
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
  if (jar.size) headers.cookie = cookieHeader();
  const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  absorb(res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}
const csrf = (html) => (html.match(/name="csrf_token" value="([^"]+)"/) || [])[1];
async function post(path, fields, token) {
  const params = new URLSearchParams();
  params.append('csrf_token', token);
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else params.append(k, v);
  }
  return req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}
async function login(loginId, password) {
  jar = new Map();
  const page = await req('/login');
  const token = csrf(page.text);
  return post('/login', { login_id: loginId, password }, token);
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 1200));
  const db = require('../src/db');

  await db.query("DELETE FROM users WHERE login_id IN ('limited_test','super_test')");

  // super admin login
  const superLogin = await login(process.env.SMOKE_LOGIN || 'admin', process.env.SMOKE_PASSWORD || 'admin123');
  check('super admin login', superLogin.status === 302);
  const home = await req('/');
  const token = csrf(home.text);

  // limited admin: sirf reports + followups
  const create = await post('/users/create', {
    name: 'Limited Tester',
    login_id: 'limited_test',
    password: 'test1234',
    role: 'admin',
    page_access: ['reports', 'followups'],
  }, token);
  check('limited admin create', create.status === 302);

  const row = await db.row("SELECT id, role, page_access FROM users WHERE login_id='limited_test'");
  check('role aur access save hue', row && row.role === 'admin' && row.page_access.includes('reports'));
  check('access me sirf granted pages', row && !row.page_access.includes('users'));

  // limited user login
  const limLogin = await login('limited_test', 'test1234');
  check('limited admin login', limLogin.status === 302);

  const allowed = await req('/reports');
  check('allowed page khulti hai (/reports)', allowed.status === 200);

  const denied = await req('/users');
  check('denied page block (/users)', denied.status === 403);
  const deniedSettings = await req('/settings');
  check('denied page block (/settings)', deniedSettings.status === 403);
  const deniedBackup = await req('/backup/export/deposits');
  check('denied export block', deniedBackup.status === 403);

  const navCheck = await req('/');
  check('dashboard access na ho to redirect', navCheck.status === 302 && navCheck.location === '/reports', 'status ' + navCheck.status);

  // role change → super_admin gets everything
  jar = new Map();
  await login(process.env.SMOKE_LOGIN || 'admin', process.env.SMOKE_PASSWORD || 'admin123');
  const home2 = await req('/');
  const token2 = csrf(home2.text);
  const upd = await post(`/users/${row.id}/update`, {
    name: 'Limited Tester',
    role: 'super_admin',
  }, token2);
  check('role upgrade', upd.status === 302);

  jar = new Map();
  await login('limited_test', 'test1234');
  const nowAllowed = await req('/users');
  check('super admin ab sab kuch khol sakta hai', nowAllowed.status === 200);

  // cleanup
  await db.query("DELETE FROM users WHERE login_id IN ('limited_test','super_test')");
  check('cleanup', true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await db.pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('✗ crashed:', e);
  process.exit(2);
});



