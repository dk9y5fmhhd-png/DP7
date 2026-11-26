'use strict';

process.env.PORT = process.env.PORT || '3410';
require('dotenv').config();

const puppeteer = require('puppeteer-core');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const path = require('path');

const OUT = '/tmp/.scratch/dp7shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const D = require('../src/lib/dates');
const iso = (n) => D.addDays(D.todayISO(), -n);

require('../src/server');

setTimeout(async () => {
  const db = require('../src/db');

  await db.query("DELETE FROM users WHERE login_id LIKE 'ashot_%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'AsS%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'AsS%'");
  await db.query('DELETE FROM assign_imports');

  const pass = await bcrypt.hash('as1234', 10);
  const mk = async (name, login, team) => (await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval, daily_target, team)
     VALUES ($1,$2,$3,'admin',$4,FALSE,150,$5) RETURNING id`,
    [name, login, pass, ['mycalls', 'customers'], team]
  )).rows[0].id;

  await mk('arun', 'ashot_arun', 'retention');
  await mk('kamal', 'ashot_kamal', 'retention');
  await mk('Diksha', 'ashot_diksha', 'retention');
  await mk('nidhi', 'ashot_nidhi', 'retention');

  // 38 naye clients (aaj/kal), kuch purane
  let n = 0;
  const add = async (count, daysAgo) => {
    for (let i = 0; i < count; i++) {
      n++;
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,$4,'successful','test')`,
        [iso(daysAgo), 'AsS' + String(n).padStart(3, '0'), '9' + String(100000000 + n), 500 + (n % 12) * 400]
      );
    }
  };
  await add(18, 0);
  await add(14, 1);
  await add(6, 2);
  await add(12, 50);

  await require('../src/lib/customers').syncCustomers();

  /* ---------- ek Excel file banao jaisi user bhejta hai ---------- */
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Assign');
  ws.addRow(['username', 'caller']);
  const fresh = await db.rows(
    `SELECT username FROM customers WHERE username LIKE 'AsS%' AND assigned_to IS NULL
      ORDER BY first_deposit DESC LIMIT 12`
  );
  const names = [['arun', 'ashot_arun'], ['kamal', 'ashot_kamal'], ['Diksha', 'ashot_diksha'], ['nidhi', 'ashot_nidhi']];
  fresh.forEach((r, i) => ws.addRow([r.username, names[i % 4][1]]));
  ws.addRow(['AsS999', 'ashot_arun']);      // nahi milega
  ws.addRow(['AsS001', 'galat_nama']);      // caller galat
  const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());

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

  /* ---------- 1. Assignment page ---------- */
  await page.goto(BASE + '/assign?days=7', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, 'v44-assign.png') });
  console.log('✓ assign page');

  /* ---------- 2. Excel import → preview ---------- */
  const input = await page.$('input[type="file"]');
  await input.uploadFile('/tmp/.scratch/asS-demo-assign.xlsx');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.evaluate(() => document.querySelector('form[action="/assign/import"]').submit()),
  ]);
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, 'v44-preview.png') });
  console.log('✓ preview');

  /* ---------- 3. apply karke queue khaali dikhao ---------- */
  await page.evaluate(() => document.querySelector('form[action="/assign/apply"]').submit());
  await new Promise((r) => setTimeout(r, 1200));
  await page.goto(BASE + '/assign?days=7', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, 'v44-after.png') });
  console.log('✓ after apply');

  // mobile
  await page.setViewport({ width: 430, height: 1000, isMobile: true });
  await page.goto(BASE + '/assign?days=7', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, 'v44-mobile.png') });
  console.log('✓ mobile');

  await browser.close();

  await db.query("DELETE FROM deposits WHERE username LIKE 'AsS%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'AsS%'");
  await db.query("DELETE FROM users WHERE login_id LIKE 'ashot_%'");
  await db.query('DELETE FROM assign_imports');
  await db.pool.end();
  process.exit(0);
}, 2900);

