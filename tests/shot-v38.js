'use strict';

/* v3.8 screenshots — My Calls (due + overdue), Follow-ups Due, dashboard.
   node tests/shot-v38.js */

process.env.PORT = process.env.PORT || '3262';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const puppeteer = require('puppeteer-core');

const OUT = process.env.SHOT_DIR || '/tmp/.scratch/dp7shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const iso = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2600));
  const db = require('../src/db');

  // ---- caller + data ----
  await db.query("DELETE FROM users WHERE login_id = 'shotcaller'");
  const cr = await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access)
     VALUES ('kamal','shotcaller',$1,'admin',$2) RETURNING id`,
    [await bcrypt.hash('shot1234', 10), ['mycalls', 'customers', 'priority']]
  );
  const callerId = cr.rows[0].id;

  const names = ['Ramesh99', 'Sunita22', 'Vikas_44', 'Pooja77', 'Aman01', 'Rekha88', 'Nitin05', 'Sapna31'];
  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM customers WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM followups WHERE username = ANY($1::text[])', [names]);

  for (const u of names) {
    await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
       VALUES ($1,$2,'98' || floor(random()*90000000+10000000)::text,500,'successful','test')`,
      [iso(25), u]
    );
  }
  await require('../src/lib/customers').syncCustomers();
  await db.query('UPDATE customers SET assigned_to = $1 WHERE username = ANY($2::text[])', [callerId, names]);

  // remarks: kuch overdue, kuch aaj, kuch aage
  const fu = [
    ['Ramesh99', 'Will Deposit', iso(4), iso(2), 'kal shaam tak'],
    ['Sunita22', 'No Answer', iso(2), iso(1), 'hangup'],
    ['Vikas_44', 'Interested', iso(1), iso(1), 'ID send'],
    ['Pooja77', 'Will Deposit', iso(1), iso(1), '2 din me'],
    ['Aman01', 'No Answer', iso(0), iso(1), 'switch off'],
    ['Rekha88', 'Call Tomorrow', iso(0), iso(1), 'callback'],
    ['Nitin05', 'Will Deposit', iso(0), iso(2), 'paise bhejega'],
    ['Sapna31', 'Interested', iso(0), iso(3), 'soch rahi hai'],
  ];
  for (const [u, a, date, fuOn, note] of fu) {
    await db.query(
      `INSERT INTO followups (username, action_type, action_date, response, next_action, follow_up_on, caller_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [u, a, date, note, 'Follow-up', fuOn, callerId]
    );
  }

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1150 });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[name="login_id"]', 'shotcaller');
  await page.type('input[name="password"]', 'shot1234');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);

  await page.goto(BASE + '/calling/my', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, 'v38-mycalls.png') });
  console.log('✓ v38-mycalls');

  // remark dialog khula hua
  await page.evaluate(() => {
    const b = document.querySelector('[data-username="Sunita22"]');
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(() => {
    const sel = document.getElementById('rm_action');
    sel.value = 'Will Deposit';
    sel.dispatchEvent(new Event('change'));
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(OUT, 'v38-remark-dialog.png') });
  console.log('✓ v38-remark-dialog');

  // admin views — alag context (caller ka session chhod do)
  const ctx = await browser.createBrowserContext();
  const admin = await ctx.newPage();
  await admin.setViewport({ width: 1500, height: 1150 });
  await admin.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await admin.type('input[name="login_id"]', 'admin');
  await admin.type('input[name="password"]', 'admin123');
  await Promise.all([admin.waitForNavigation({ waitUntil: 'networkidle0' }), admin.click('button[type="submit"]')]);

  await admin.goto(BASE + '/calling/due', { waitUntil: 'networkidle0' });
  await admin.screenshot({ path: path.join(OUT, 'v38-due.png') });
  console.log('✓ v38-due');

  await admin.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await admin.screenshot({ path: path.join(OUT, 'v38-dashboard.png') });
  console.log('✓ v38-dashboard');

  // cleanup
  await db.query('DELETE FROM deposits WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM customers WHERE username = ANY($1::text[])', [names]);
  await db.query('DELETE FROM followups WHERE username = ANY($1::text[])', [names]);
  await db.query("DELETE FROM users WHERE login_id = 'shotcaller'");

  await browser.close();
  await db.pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

