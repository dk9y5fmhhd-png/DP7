'use strict';

/* v3.9 screenshots — waiting page + approvals page.
   node tests/shot-v39.js */

process.env.PORT = process.env.PORT || '3290';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const puppeteer = require('puppeteer-core');

const OUT = process.env.SHOT_DIR || '/tmp/.scratch/dp7shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2700));
  const db = require('../src/db');

  await db.query("DELETE FROM users WHERE login_id = 'shotap'");
  await db.query('DELETE FROM login_requests');
  await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
     VALUES ('kamal','shotap',$1,'admin',$2,TRUE)`,
    [await bcrypt.hash('shot1234', 10), ['mycalls', 'customers', 'priority']]
  );

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });

  /* ---------- 1. user ka waiting screen ---------- */
  const userCtx = await browser.createBrowserContext();
  const user = await userCtx.newPage();
  await user.setViewport({ width: 1200, height: 900 });
  await user.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await user.type('input[name="login_id"]', 'shotap');
  await user.type('input[name="password"]', 'shot1234');
  await Promise.all([user.waitForNavigation({ waitUntil: 'networkidle0' }), user.click('button[type="submit"]')]);
  await new Promise((r) => setTimeout(r, 600));
  await user.screenshot({ path: path.join(OUT, 'v39-waiting.png') });
  console.log('✓ v39-waiting');

  /* ---------- 2. admin ke paas do pending requests ---------- */
  // ek aur pending banao
  await db.query(
    `INSERT INTO login_requests (user_id, login_id, name, role, ip, user_agent)
     SELECT id, login_id, name, role, '103.21.44.18', 'Chrome/Windows'
       FROM users WHERE login_id = 'shotap'`
  );

  const adminCtx = await browser.createBrowserContext();
  const admin = await adminCtx.newPage();
  await admin.setViewport({ width: 1500, height: 1100 });
  await admin.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await admin.type('input[name="login_id"]', 'admin');
  await admin.type('input[name="password"]', 'admin123');
  await Promise.all([admin.waitForNavigation({ waitUntil: 'networkidle0' }), admin.click('button[type="submit"]')]);
  await admin.goto(BASE + '/approvals', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
  await admin.screenshot({ path: path.join(OUT, 'v39-approvals.png') });
  console.log('✓ v39-approvals');

  /* ---------- 3. reports page — CSV button gayab (non-admin) ---------- */
  await db.query("DELETE FROM users WHERE login_id = 'shotrep'");
  await db.query(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
     VALUES ('arun','shotrep',$1,'admin',$2,FALSE)`,
    [await bcrypt.hash('shot1234', 10), ['reports', 'level_report', 'mycalls']]
  );
  const repCtx = await browser.createBrowserContext();
  const rep = await repCtx.newPage();
  await rep.setViewport({ width: 1500, height: 900 });
  await rep.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await rep.type('input[name="login_id"]', 'shotrep');
  await rep.type('input[name="password"]', 'shot1234');
  await Promise.all([rep.waitForNavigation({ waitUntil: 'networkidle0' }), rep.click('button[type="submit"]')]);
  await rep.goto(BASE + '/reports/level', { waitUntil: 'networkidle0' });
  await rep.screenshot({ path: path.join(OUT, 'v39-no-download.png') });
  console.log('✓ v39-no-download');

  await browser.close();
  await db.query("DELETE FROM users WHERE login_id IN ('shotap','shotrep')");
  await db.query('DELETE FROM login_requests');
  await db.pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

