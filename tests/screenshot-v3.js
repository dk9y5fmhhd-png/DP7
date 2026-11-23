'use strict';

/* Dev-only: naye retention pages ke screenshots. node tests/screenshot-v3.js */

process.env.PORT = process.env.PORT || '3213';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const OUT = process.env.SHOT_DIR || '/tmp/.scratch/dp7shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2200));
  const db = require('../src/db');

  const cust = await db.row('SELECT username FROM customers ORDER BY deposit_count DESC LIMIT 1');

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[name="login_id"]', 'admin');
  await page.type('input[name="password"]', 'admin123');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);

  const shots = [
    ['dashboard', '/'],
    ['customers', '/customers'],
    ['customer-detail', '/customers/' + encodeURIComponent(cust.username)],
    ['calling', '/calling'],
    ['my-calls', '/calling/my'],
    ['call-log', '/calls'],
    ['upload', '/upload'],
    ['settings-retention', '/settings?tab=retention'],
    ['settings-telecmi', '/settings?tab=telecmi'],
  ];

  for (const [name, url] of shots) {
    await page.goto(BASE + url, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('✓', name);
  }

  await page.setViewport({ width: 420, height: 900, isMobile: true });
  await page.goto(BASE + '/my-calls'.replace('my-calls', 'calling/my'), { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, 'mobile-mycalls.png') });
  console.log('✓ mobile');

  await browser.close();
  await db.pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

