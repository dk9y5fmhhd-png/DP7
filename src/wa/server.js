'use strict';

// Entry point of the WhatsApp (Baileys) process: `npm run start:wa`. It runs
// apart from the web app so a web deploy does not drop the WhatsApp links.

require('dotenv').config();

const { Client } = require('pg');
const db = require('../db');
const secrets = require('../lib/crypto');
const { WhatsappService } = require('./service');
const { createApp } = require('./app');

// Never PORT: a shared .env sets that for the web app, and this process would
// then take the web app's address on this machine.
const PORT = Number(process.env.WA_PORT || 3100);
// Keep it private. On Railway's private network set WA_BIND_HOST=::
const HOST = process.env.WA_BIND_HOST || '127.0.0.1';
const LOCK_KEY = 'dp7-whatsapp';

if (!secrets.isConfigured()) {
  console.error('✗ CREDENTIALS_ENCRYPTION_KEY is required (32 characters or more).');
  process.exit(1);
}
if ((process.env.WA_INTERNAL_TOKEN || '').length < 32) {
  console.error('✗ WA_INTERNAL_TOKEN is missing or short: every request will be rejected.');
}

const service = new WhatsappService();
let ready = false;
let lock;

createApp({ service, token: process.env.WA_INTERNAL_TOKEN, isReady: () => ready })
  .listen(PORT, HOST, () => console.log(`✓ WhatsApp service listening on ${HOST}:${PORT}`));

// Only one copy may hold the WhatsApp logins. During a deploy the new copy
// waits here until the old one has stopped.
async function takeLock() {
  const needsSsl = /sslmode=require/.test(process.env.DATABASE_URL || '') || process.env.PGSSL === 'true';
  lock = new Client({
    connectionString: process.env.DATABASE_URL || undefined,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    keepAlive: true,
  });
  lock.on('error', (err) => {
    console.error('✗ lost the lock connection, restarting:', err.message);
    process.exit(1);
  });
  lock.on('end', () => { if (!stopping) process.exit(1); });
  await lock.connect();
  let told = false;
  for (;;) {
    const r = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY]);
    if (r.rows[0].ok) return;
    if (!told) console.log('… another copy is active; waiting for it to stop');
    told = true;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  ready = false;
  service.shutdown();
  await lock?.end().catch(() => {});
  await db.pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

(async () => {
  await takeLock();
  await service.init();
  ready = true;
  console.log('✓ WhatsApp service active');
})().catch((err) => {
  console.error('✗ WhatsApp service failed to start:', err.message);
  process.exit(1);
});
