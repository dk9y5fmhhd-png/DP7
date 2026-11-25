'use strict';

/* Dev-only: har page ka screenshot leta hai taaki layout aankhon se check ho sake.
   node tests/screenshot.js   →  /tmp/.scratch/shots/*.png */

process.env.PORT = process.env.PORT || '3998';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const OUT = process.env.SHOT_DIR || '/tmp/.scratch/shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  require('../src/server');
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });

  // login
  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[name="login_id"]', process.env.SMOKE_LOGIN || 'admin');
  await page.type('input[name="password"]', process.env.SMOKE_PASSWORD || 'admin123');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);

  const shots = [
    ['dashboard', '/'],
    ['add-data', '/add-data'],
    ['reports', '/reports'],
    ['level-report', '/reports/level'],
    ['daily', '/reports/daily'],
    ['weekly', '/reports/weekly'],
    ['biweekly', '/reports/biweekly'],
    ['monthly', '/reports/monthly'],
    ['followups', '/followups'],
    ['users', '/users'],
    ['settings', '/settings'],
    ['security', '/security'],
    ['backup', '/backup'],
  ];

  for (const [name, url] of shots) {
    await page.goto(BASE + url, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
    console.log('✓', name);
  }

  // mobile view of the reports page
  await page.setViewport({ width: 420, height: 900, isMobile: true });
  await page.goto(BASE + '/reports', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, 'mobile-reports.png') });
  console.log('✓ mobile-reports');

  // login screen
  const fresh = await browser.newPage();
  await fresh.setViewport({ width: 1200, height: 800 });
  await fresh.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await fresh.screenshot({ path: path.join(OUT, 'login.png') });
  console.log('✓ login');

  await browser.close();
  await require('../src/db').pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ screenshot failed:', err.message);
  process.exit(1);
});

