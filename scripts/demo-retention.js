'use strict';

/* Demo data — retention CRM v3 (status / VIP / priority test ke liye).
   Production me NA chalayein.  FORCE_DEMO=1 node scripts/demo-retention.js */

require('dotenv').config();

const { pool } = require('../src/db');

const today = new Date();
function isoDaysAgo(n) {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// profile: {username, mobile, deposits, lastAgo, amount}
const PROFILES = [
  // VIP inactive → P1
  { username: 'KKK74DP', mobile: '9427040914', deposits: 839, lastAgo: 12, amount: 5600 },
  { username: 'SaurabhDP17', mobile: '7388383081', deposits: 155, lastAgo: 42, amount: 4000 },
  { username: 'DP339RAJA', mobile: '9993999339', deposits: 62, lastAgo: 9, amount: 2500 },
  { username: 'RohitVip01', mobile: '9812345670', deposits: 28, lastAgo: 20, amount: 900 },
  // recently inactive normal → P1
  { username: 'AadilP79', mobile: '8240123109', deposits: 6, lastAgo: 10, amount: 500 },
  { username: 'AalamS57', mobile: '7431873338', deposits: 4, lastAgo: 8, amount: 500 },
  // long inactive normal → P2
  { username: 'AarushS52', mobile: '7651961497', deposits: 9, lastAgo: 35, amount: 500 },
  { username: 'AAbhiP08', mobile: '7982112279', deposits: 12, lastAgo: 60, amount: 700 },
  // new customers (1 deposit) → P2
  { username: 'NewGuy01', mobile: '9000011111', deposits: 1, lastAgo: 2, amount: 300 },
  { username: 'NewGuy02', mobile: '9000011112', deposits: 1, lastAgo: 5, amount: 1000 },
  { username: 'NewGuy03', mobile: '9000011113', deposits: 1, lastAgo: 1, amount: 200 },
  // active → P4
  { username: 'ActiveOne', mobile: '9000022221', deposits: 20, lastAgo: 1, amount: 800 },
  { username: 'ActiveTwo', mobile: '9000022222', deposits: 35, lastAgo: 0, amount: 1500 },
  { username: 'PriyaS78', mobile: '9000022223', deposits: 14, lastAgo: 3, amount: 600 },
  // high value VIP active
  { username: 'HighRoller', mobile: '9000033331', deposits: 210, lastAgo: 0, amount: 9000 },
];

async function main() {
  const existing = Number((await pool.query('SELECT COUNT(*)::int c FROM deposits')).rows[0].c);
  if (existing > 0 && !process.env.FORCE_DEMO) {
    console.log(`✗ deposits me ${existing} rows hain. FORCE_DEMO=1 ke saath chalayein.`);
    process.exit(1);
  }
  if (process.env.FORCE_DEMO) {
    await pool.query('TRUNCATE deposits, followups, calls RESTART IDENTITY');
    await pool.query('DELETE FROM customers');
  }

  const users = (await pool.query("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1")).rows;
  const adminId = users[0] ? users[0].id : null;

  // do callers banao (agar nahi hain)
  const callers = [];
  for (const [name, login] of [['Ravi (Caller)', 'ravi'], ['Sonia (Caller)', 'sonia']]) {
    const found = await pool.query('SELECT id FROM users WHERE login_id = $1', [login]);
    if (found.rowCount) { callers.push(found.rows[0].id); continue; }
    const bcrypt = require('bcryptjs');
    const r = await pool.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access)
       VALUES ($1,$2,$3,'admin',$4) RETURNING id`,
      [name, login, await bcrypt.hash('caller123', 10), ['mycalls', 'customers', 'priority']]
    );
    callers.push(r.rows[0].id);
  }

  let txnSeq = 100000;
  let rows = 0;

  for (const p of PROFILES) {
    // deposits ko lastAgo se peeche tak phailao
    for (let i = 0; i < p.deposits; i++) {
      // har deposit alag din par (takaraav na ho)
      const date = isoDaysAgo(Math.min(p.lastAgo + i, 800));
      const status = i === 3 && p.deposits > 10 ? 'failed' : 'successful';
      await pool.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, txn_id, status, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'demo',$7)`,
        [date, p.username, p.mobile, p.amount + rand(-100, 400), 'TXN' + (txnSeq++), status, adminId]
      );
      rows++;
    }
  }

  // customers master sync
  const C = require('../src/lib/customers');
  const sync = await C.syncCustomers();

  // assignment: aadhe Ravi ko, aadhe Sonia ko
  const all = (await pool.query('SELECT id, username FROM customers ORDER BY username')).rows;
  for (let i = 0; i < all.length; i++) {
    const caller = callers[i % callers.length];
    await pool.query('UPDATE customers SET assigned_to = $2 WHERE id = $1', [all[i].id, caller]);
  }

  // kuch remarks
  const remarks = [
    ['KKK74DP', 'No Answer', 'phone nahi utha'],
    ['AadilP79', 'Will Deposit', 'kal shaam tak deposit karega'],
    ['NewGuy02', 'Interested', 'bonus ke baare me baat hui'],
    ['AarushS52', 'Not Interested', 'ab nahi khelna chahta'],
  ];
  for (const [u, a, note] of remarks) {
    const R = require('../src/lib/remarks');
    await pool.query(
      `INSERT INTO followups (username, action_type, action_date, response, next_action, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [u, a, isoDaysAgo(rand(0, 3)), note, R.nextActionFor(a), adminId]
    );
  }

  // kuch call log
  for (const [u, daysAgo] of [['KKK74DP', 0], ['AadilP79', 0], ['NewGuy02', 1], ['ActiveOne', 2]]) {
    const c = (await pool.query('SELECT id FROM customers WHERE username = $1', [u])).rows[0];
    if (!c) continue;
    await pool.query(
      `INSERT INTO calls (customer_id, username, caller_id, provider, status, duration_sec, note, called_at)
       VALUES ($1,$2,$3,'manual','completed',$4,'demo call', NOW() - ($5 || ' days')::interval)`,
      [c.id, u, callers[0], rand(20, 180), daysAgo]
    );
  }

  console.log(`✓ demo ready: ${rows} deposits, ${sync.total} customers`);
  const board = await pool.query(
    `SELECT status, vip_category, priority, COUNT(*)::int c
       FROM customer_board GROUP BY 1,2,3 ORDER BY priority, vip_category`
  );
  console.table(board.rows);
  await pool.end();
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

