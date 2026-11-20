'use strict';

/* Dev-only: upload flow ka visual check — file chunne ke baad ka page
   aur result page ka screenshot. node tests/upload-shot.js */

process.env.PORT = process.env.PORT || '3995';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer-core');

const OUT = process.env.SHOT_DIR || '/tmp/.scratch/shots';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function buildXlsx() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DP7';
  const ws = wb.addWorksheet('Deposits');
  ws.columns = [
    { header: 'date', width: 14 },
    { header: 'username', width: 22 },
    { header: 'mobile', width: 16 },
    { header: 'amount', width: 12 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D5EFC' } };
  ws.addRow(['2026-11-15', 'shot_test_a', '9000011111', 1500]);
  ws.addRow(['2026-11-15', 'shot_test_b', '9000011112', 250]);
  ws.addRow(['2026-11-16', 'shot_test_a', '9000011111', 300]);
  ws.addRow(['2026-11-16', 'shot_test_c', '9000011113', '']);
  ws.addRow(['2026-11-16', 'shot_test_d', '123', 100]);
  const file = path.join('/tmp/.scratch', 'sample-upload.xlsx');
  await wb.xlsx.writeFile(file);
  return file;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const db = require('../src/db');
  await db.query("DELETE FROM deposits WHERE username LIKE 'shot\\_test\\_%'");
  const file = await buildXlsx();

  require('../src/server');
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1050 });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[name="login_id"]', process.env.SMOKE_LOGIN || 'admin');
  await page.type('input[name="password"]', process.env.SMOKE_PASSWORD || 'admin123');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);

  await page.goto(BASE + '/add-data', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(OUT, 'add-data.png') });
  console.log('✓ add-data');

  const input = await page.$('#fileInput');
  await input.uploadFile(file);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, 'add-data-picked.png') });
  console.log('✓ add-data-picked');

  // Preview only
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.evaluate(() => {
      const btn = [...document.querySelectorAll('#uploadForm button[type="submit"]')].find(
        (b) => b.getAttribute('value') === '1'
      );
      btn.click();
    }),
  ]);
  await page.screenshot({ path: path.join(OUT, 'add-data-preview.png') });
  console.log('✓ add-data-preview');

  // ab save karo
  const input2 = await page.$('#fileInput');
  await input2.uploadFile(file);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.evaluate(() => {
      const btn = [...document.querySelectorAll('#uploadForm button[type="submit"]')].find(
        (b) => b.getAttribute('value') === '0'
      );
      btn.click();
    }),
  ]);
  await page.screenshot({ path: path.join(OUT, 'add-data-saved.png') });
  console.log('✓ add-data-saved');

  await browser.close();
  await db.query("DELETE FROM deposits WHERE username LIKE 'shot\\_test\\_%'");
  await db.pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

