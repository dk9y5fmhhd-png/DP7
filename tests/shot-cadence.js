'use strict';

process.env.PORT = process.env.PORT || '3370';
require('dotenv').config();

const puppeteer = require('puppeteer-core');
const bcrypt = require('bcryptjs');
const path = require('path');

const OUT = '/tmp/.scratch/dp7shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const D = require('../src/lib/dates');
const iso = (n) => D.addDays(D.todayISO(), -n);

require('../src/server');

setTimeout(async () => {
  const db = require('../src/db');
  const CAD = require('../src/lib/cadence');

  await db.query("DELETE FROM users WHERE login_id LIKE 'cshot_%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'Cs%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'Cs%'");
  await db.query("DELETE FROM followups WHERE username LIKE 'Cs%'");

  const pass = await bcrypt.hash('cs1234', 10);
  const mk = async (name, login, team, target) => (await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval, daily_target, team)
     VALUES ($1,$2,$3,'admin',$4,FALSE,$5,$6) RETURNING id`,
    [name, login, pass, ['mycalls', 'customers', 'priority'], target, team]
  )).rows[0].id;

  const arun = await mk('arun', 'cshot_arun', 'retention', 150);
  const kamal = await mk('kamal', 'cshot_kamal', 'retention', 150);
  const diksha = await mk('Diksha', 'cshot_diksha', 'retention', 150);
  await mk('samira', 'cshot_samira', 'acquisition', 150);

  let n = 0;
  const cust = async (count, ago, repeat, label) => {
    for (let i = 0; i < count; i++) {
      n++;
      const u = 'Cs' + label + String(n).padStart(3, '0');
      const dep = async (daysAgo) => db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,$4,'successful','test')`,
        [iso(daysAgo), u, '9' + String(100000000 + n), 500 + (n % 15) * 300]
      );
      await dep(ago);
      if (repeat) await dep(Math.max(0, ago - 2));
    }
  };

  // tiers: VIP (30 deposits, 40 din) · recent inactive (10 din) · active · dormant (90 din)
  for (let i = 0; i < 40; i++) {
    const u = 'CsVip' + String(i + 1).padStart(3, '0');
    for (let j = 0; j < 30; j++) {
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,800,'successful','test')`,
        [iso(40 + j), u, '9111100' + String(i).padStart(4, '0')]
      );
    }
  }
  await cust(120, 10, false, 'Rec');
  await cust(200, 1, true, 'Act');
  await cust(150, 90, false, 'Dor');

  await require('../src/lib/customers').syncCustomers();
  await CAD.refreshAll();

  // baant do — 3 retention callers, tier ka mix har caller me
  const tri = [arun, kamal, diksha];
  await db.query(
    `UPDATE customers c SET assigned_to = $1
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY cadence_tier, id) AS rn
               FROM customers WHERE username LIKE 'Cs%') x
      WHERE c.id = x.id AND x.rn % 3 = 0`, [tri[0]]);
  await db.query(
    `UPDATE customers c SET assigned_to = $1
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY cadence_tier, id) AS rn
               FROM customers WHERE username LIKE 'Cs%') x
      WHERE c.id = x.id AND x.rn % 3 = 1`, [tri[1]]);
  await db.query(
    `UPDATE customers c SET assigned_to = $1
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY cadence_tier, id) AS rn
               FROM customers WHERE username LIKE 'Cs%') x
      WHERE c.id = x.id AND x.rn % 3 = 2`, [tri[2]]);

  // thodi calls kar do taaki coverage 0 na ho
  const some = (await db.rows(
    `SELECT username FROM customers WHERE username LIKE 'Cs%'
      ORDER BY assigned_to, username LIMIT 90`
  )).map((r) => r.username);
  for (const u of some) {
    await db.query(
      `INSERT INTO followups (username, action_type, action_date, response, next_action, follow_up_on)
       VALUES ($1,'No Answer',$2,'demo','Retry queue',$3)`,
      [u, iso(0), iso(-1)]
    );
  }
  await CAD.refreshAll();

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1400 });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[name="login_id"]', 'admin');
  await page.type('input[name="password"]', 'admin123');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);

  await page.goto(BASE + '/cadence', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(OUT, 'v43-cadence.png') });
  console.log('✓ cadence');

  // caller ka My Calls
  const ctx = await browser.createBrowserContext();
  const c = await ctx.newPage();
  await c.setViewport({ width: 1500, height: 1150 });
  await c.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await c.type('input[name="login_id"]', 'cshot_arun');
  await c.type('input[name="password"]', 'cs1234');
  await Promise.all([c.waitForNavigation({ waitUntil: 'networkidle0' }), c.click('button[type="submit"]')]);
  await c.goto(BASE + '/calling/my', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
  await c.screenshot({ path: path.join(OUT, 'v43-mycalls.png') });
  console.log('✓ mycalls');

  await browser.close();
  await db.query("DELETE FROM deposits WHERE username LIKE 'Cs%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'Cs%'");
  await db.query("DELETE FROM followups WHERE username LIKE 'Cs%'");
  await db.query("DELETE FROM users WHERE login_id LIKE 'cshot_%'");
  await db.pool.end();
  process.exit(0);
}, 2900);

