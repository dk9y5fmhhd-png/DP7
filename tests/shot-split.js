'use strict';

process.env.PORT = process.env.PORT || '3350';
require('dotenv').config();

const puppeteer = require('puppeteer-core');
const bcrypt = require('bcryptjs');
const path = require('path');

const OUT = '/tmp/.scratch/dp7shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

require('../src/server');

const D = require('../src/lib/dates');
const iso = (n) => D.addDays(D.todayISO(), -n);

setTimeout(async () => {
  const db = require('../src/db');

  /* ---------- demo data: 6 callers, uneven load, 900 unassigned ---------- */
  await db.query("DELETE FROM users WHERE login_id LIKE 'shot_%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'ShotL%'");
  await db.query("DELETE FROM deposits WHERE username LIKE 'ShotL%'");
  await db.query('DELETE FROM split_runs');

  const pass = await bcrypt.hash('shot1234', 10);
  const mk = async (name, login, team, target) => {
    const r = await db.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval, daily_target, team)
       VALUES ($1,$2,$3,'admin',$4,FALSE,$5,$6) RETURNING id`,
      [name, login, pass, ['mycalls', 'customers', 'priority'], target, team]
    );
    return r.rows[0].id;
  };
  const arun = await mk('arun', 'shot_arun', 'retention', 150);
  const kamal = await mk('kamal', 'shot_kamal', 'retention', 150);
  const diksha = await mk('Diksha', 'shot_diksha', 'retention', 150);
  await mk('samira', 'shot_samira', 'acquisition', 150);
  await mk('soheb', 'shot_soheb', 'acquisition', 150);
  await mk('soni', 'shot_soni', 'acquisition', 150);

  let n = 0;
  // 900 customers: 120 P1, 280 P2, 500 P4
  const make = async (count, ago, repeat) => {
    for (let i = 0; i < count; i++) {
      n++;
      const u = 'ShotL' + String(n).padStart(4, '0');
      await db.query(
        `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
         VALUES ($1,$2,$3,$4,'successful','test')`,
        [iso(ago), u, '9' + String(100000000 + n), 500 + (n % 20) * 100]
      );
      if (repeat) {
        await db.query(
          `INSERT INTO deposits (play_date, username, mobile, amount, status, source)
           VALUES ($1,$2,$3,$4,'successful','test')`,
          [iso(Math.max(0, ago - 2)), u, '9' + String(100000000 + n), 500]
        );
      }
    }
  };
  await make(120, 10, false);   // P1
  await make(280, 40, false);   // P2
  await make(500, 1, true);     // P4

  await require('../src/lib/customers').syncCustomers();

  // uneven load — arun bhara, kamal theek, diksha khaali
  const all = (await db.rows(
    "SELECT id FROM customers WHERE username LIKE 'ShotL%' ORDER BY id"
  )).map((r) => r.id);
  await db.query('UPDATE customers SET assigned_to = $1 WHERE id = ANY($2::int[])', [arun, all.slice(0, 380)]);
  await db.query('UPDATE customers SET assigned_to = $1 WHERE id = ANY($2::int[])', [kamal, all.slice(380, 620)]);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1560, height: 1250 });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[name="login_id"]', 'admin');
  await page.type('input[name="password"]', 'admin123');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);

  await page.goto(BASE + '/callers', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(OUT, 'v42-load.png') });
  console.log('✓ load');

  /* ---------- preview ---------- */
  const ids = await db.rows(
    "SELECT id FROM users WHERE login_id LIKE 'shot_%' ORDER BY login_id"
  );
  await page.evaluate((callerIds) => {
    document.querySelectorAll('input[name="caller_id"]').forEach((cb) => {
      cb.checked = callerIds.includes(Number(cb.value));
    });
    document.querySelector('form[action="/callers/preview"]').submit();
  }, ids.map((r) => r.id));
  await page.waitForNavigation({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, 'v42-preview.png') });
  console.log('✓ preview');

  await browser.close();
  await db.query("DELETE FROM deposits WHERE username LIKE 'ShotL%'");
  await db.query("DELETE FROM customers WHERE username LIKE 'ShotL%'");
  await db.query("DELETE FROM users WHERE login_id LIKE 'shot_%'");
  await db.query('DELETE FROM split_runs');
  await db.pool.end();
  process.exit(0);
}, 2800);

