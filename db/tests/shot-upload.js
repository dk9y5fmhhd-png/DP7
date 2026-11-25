'use strict';

/* Asli file upload ke baad ka page screenshot.
   node tests/shot-upload.js <xlsx> */

process.env.PORT = process.env.PORT || '3226';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const OUT = process.env.SHOT_DIR || '/tmp/.scratch/dp7shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const FILE = process.argv[2] || '/tmp/.inputs/user-upload.xlsx';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  require('../src/server');
  await new Promise((r) => setTimeout(r, 2400));
  const db = require('../src/db');

  await db.query("DELETE FROM deposits WHERE source='excel'");
  await db.query('DELETE FROM customers');
  await require('../src/lib/customers').syncCustomers();

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1400 });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[name="login_id"]', 'admin');
  await page.type('input[name="password"]', 'admin123');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);

  await page.goto(BASE + '/upload', { waitUntil: 'networkidle0' });

  // deposits card ka file input = doosra file input
  const inputs = await page.$$('input[type="file"]');
  await inputs[1].uploadFile(FILE);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 120000 }),
    page.evaluate(() => {
      const forms = [...document.querySelectorAll('form')];
      const f = forms.find((x) => x.action.endsWith('/upload/deposits'));
      const btn = [...f.querySelectorAll('button')].find((b) => b.value === '0');
      btn.click();
    }),
  ]);
  await page.screenshot({ path: path.join(OUT, 'upload-result.png') });
  console.log('✓ upload-result');

  await page.goto(BASE + '/customers', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, 'customers-after.png') });
  console.log('✓ customers-after');

  await page.goto(BASE + '/reports/level', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, 'level-after.png') });
  console.log('✓ level-after');

  await browser.close();
  await db.pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

