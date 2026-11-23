'use strict';

/* v3.5 test — purane unique index wali DB par bhi upload poora chale.
   Run: DATABASE_URL=... node tests/legacy-index.js <xlsx> */

process.env.PORT = process.env.PORT || '3228';
require('dotenv').config();

const fs = require('fs');
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
  return { status: res.status, text: buf.toString('utf8') };
}
const csrf = (h) => (h.match(/name="csrf_token" value="([^"]+)"/) || [])[1];

async function upload(token, buffer, name, dry) {
  const fd = new FormData();
  fd.append('csrf_token', token);
  fd.append('dry', dry ? '1' : '0');
  fd.append('play_date', '2026-11-23');
  fd.append('file', new Blob([buffer]), name);
  const res = await fetch(`${BASE}/upload/deposits`, { method: 'POST', headers: { cookie: ch() }, body: fd, redirect: 'manual' });
  absorb(res);
  return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString('utf8') };
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  const file = process.argv[2] || '/tmp/.inputs/user-upload.xlsx';
  const buffer = fs.readFileSync(file);

  const db = require('../src/db');

  // ---- purani DB jaisi halat: (play_date, username) par UNIQUE index ----
  // index banane ke liye duplicate rows hatao (ye test DB hai)
  await db.query('DELETE FROM deposits');
  await db.query('DELETE FROM customers');
  await db.query("DELETE FROM followups WHERE username LIKE '%'");
  await db.query('DROP INDEX IF EXISTS deposits_manual_day_uniq');
  await db.query('DROP INDEX IF EXISTS deposits_day_client_uniq');
  await db.query(
    'CREATE UNIQUE INDEX deposits_day_client_uniq ON deposits (play_date, LOWER(username))'
  );
  const before = await db.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='deposits' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%play_date%'`
  );
  check('purana unique index bana diya (live jaisa)', before.rowCount === 1,
    before.rows.map((r) => r.indexname).join(','));

  // ---- server start (bootstrap chalega) ----
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2600));

  // ---- index hat gaya? ----
  const after = await db.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename='deposits' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%play_date%'`
  );
  const leftover = after.rows.filter((r) => !r.indexdef.includes("source = 'manual'"));
  check('purana index bootstrap ne hata diya', leftover.length === 0,
    leftover.map((r) => r.indexname).join(',') || 'clean');

  // ---- login ----
  const lp = await req('/login');
  await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf_token: csrf(lp.text), login_id: 'admin', password: 'admin123' }).toString(),
  });
  const up = await req('/upload');
  const token = csrf(up.text);
  check('upload page + version tag', up.status === 200 && /v3\.5/.test(up.text), 'v3.5 tag');

  const health = await req('/health');
  check('health me version', health.status === 200 && /"version":"3\.5\.0"/.test(health.text), health.text.slice(0, 60));

  // ---- saaf shuruaat ----
  await db.query("DELETE FROM deposits WHERE source='excel'");
  await db.query('DELETE FROM customers');
  await require('../src/lib/customers').syncCustomers();

  // ---- asli file upload ----
  const real = await upload(token, buffer, 'user-upload.xlsx', false);
  check('upload save hua', real.status === 200 && /rows save/.test(real.text));

  const total = Number(await db.value("SELECT COUNT(*)::int FROM deposits WHERE source='excel'"));
  check('saari 1003 rows insert hui', total === 1003, String(total));

  const v = await db.row("SELECT * FROM customers WHERE LOWER(username)='vijayst1'");
  check('Vijayst1 count 53', v && v.deposit_count === 53, v ? String(v.deposit_count) : 'none');
  check('Vijayst1 total ₹10,94,905', v && Number(v.deposit_amount) === 1094905, v ? String(v.deposit_amount) : 'none');
  check('Vijayst1 Premium VIP', v && v.vip_category === 'premium_vip', v ? v.vip_category : 'none');

  const stats = await db.row('SELECT COUNT(*)::int u, SUM(deposit_count)::int c FROM customers');
  check('94 customers / 1003 count', stats.u === 94 && stats.c === 1003, `${stats.u}/${stats.c}`);

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

