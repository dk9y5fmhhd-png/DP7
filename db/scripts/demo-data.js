'use strict';

/* Demo data — sirf local testing ke liye. Production par kabhi na chalayein.
   Usage: DATABASE_URL=... node scripts/demo-data.js [clients=500] [days=70] */

require('dotenv').config();

const { pool, tx } = require('../src/db');

const CLIENTS = Number(process.argv[2] || 500);
const DAYS = Number(process.argv[3] || 70);

const FIRST = ['rahul', 'priya', 'amit', 'sneha', 'vikas', 'pooja', 'arjun', 'neha', 'rohit', 'kavya', 'sanjay', 'meena', 'deepak', 'anjali', 'suresh', 'ritu', 'manoj', 'divya', 'kiran', 'farhan'];
const LAST = ['dp', 'kumar', 'sharma', 'verma', 'patel', 'reddy', 'singh', 'gupta', 'nair', 'das', 'roy', 'mehta', 'jain', 'yadav', 'pillai'];

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const chance = (p) => Math.random() < p;

function isoDaysAgo(n) {
  const d = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const existing = Number((await pool.query('SELECT COUNT(*)::int AS c FROM deposits')).rows[0].c);
  if (existing > 0 && !process.env.FORCE_DEMO) {
    console.log(`✗ deposits table me pehle se ${existing} rows hain.`);
    console.log('  Demo data daalna hai to FORCE_DEMO=1 ke saath chalayein (purana data delete hoga).');
    process.exit(1);
  }

  if (process.env.FORCE_DEMO) await pool.query('TRUNCATE deposits, followups RESTART IDENTITY');

  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    // habit: days per week — a few very regular, most middle, long tail of rare
    const roll = Math.random();
    const perWeek =
      roll < 0.12 ? 5.5 + Math.random() * 1.4 :
      roll < 0.4 ? rand(20, 60) / 10 :
      roll < 0.75 ? rand(8, 19) / 10 :
      rand(1, 7) / 10;

    const username = `${pick(FIRST)}${pick(LAST)}${rand(1, 99)}`;
    const mobile = Math.random() < 0.03
      ? null // filled from another client later — creates duplicate numbers
      : `9${rand(100000000, 899999999)}`;

    clients.push({ username, mobile, perWeek });
  }

  // ~4% clients share a mobile number with someone else
  const withMobile = clients.filter((c) => c.mobile);
  for (const c of clients) {
    if (!c.mobile && withMobile.length) c.mobile = pick(withMobile).mobile;
  }

  const depositRows = [];
  for (const c of clients) {
    const p = Math.min(0.97, c.perWeek / 7);
    for (let d = DAYS; d >= 0; d--) {
      // skip today for most clients so "gone quiet" lists are non-empty
      if (d === 0 && chance(0.85)) continue;
      if (chance(p)) {
        depositRows.push([isoDaysAgo(d), c.username, c.mobile, rand(100, 9000)]);
      }
    }
  }

  console.log(`→ inserting ${depositRows.length} deposit rows for ${CLIENTS} clients…`);

  const users = (await pool.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows;
  const adminId = users[0] ? users[0].id : null;

  await tx(async (client) => {
    const CHUNK = 500;
    for (let i = 0; i < depositRows.length; i += CHUNK) {
      const chunk = depositRows.slice(i, i + CHUNK);
      const cols = chunk.map((_, j) => `($${j * 5 + 1},$${j * 5 + 2},$${j * 5 + 3},$${j * 5 + 4},$${j * 5 + 5})`).join(',');
      const params = [];
      for (const r of chunk) params.push(r[0], r[1], r[2], r[3], adminId);
      await client.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, created_by)
         VALUES ${cols} ON CONFLICT DO NOTHING`,
        params
      );
    }
  });

  // follow-ups on a sample of clients
  const actions = ['Play Later', 'Busy', 'Deposited', 'Call Tomorrow', 'Not Reachable', 'Switch Off', 'Message Done', 'Call Done', 'Call Again'];
  const notes = ['no answer', 'kal deposit karega', 'busy tha', 'call again after 5pm', 'playing', 'switched off', 'message sent', 'deposit done'];
  const fuRows = [];
  for (let i = 0; i < Math.min(400, clients.length); i++) {
    const c = pick(clients);
    fuRows.push([c.username, pick(actions), isoDaysAgo(rand(0, 25)), pick(notes), adminId]);
  }
  await tx(async (client) => {
    for (const r of fuRows) {
      await client.query(
        'INSERT INTO followups (username, action_type, action_date, response, created_by) VALUES ($1,$2,$3,$4,$5)',
        r
      );
    }
  });

  console.log(`✓ demo data ready: ${depositRows.length} deposits, ${fuRows.length} follow-ups`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('✗ demo data failed:', err.message);
  process.exit(1);
});

