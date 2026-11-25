'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

const DEFAULT_LEVELS = [
  { name: 'Level 1', min: 0, max: 1000, sort: 1 },
  { name: 'Level 2', min: 1001, max: 10000, sort: 2 },
  { name: 'Level 3', min: 10001, max: 20000, sort: 3 },
  { name: 'Level 4', min: 20001, max: 50000, sort: 4 },
  { name: 'Level 5', min: 50001, max: null, sort: 5 },
];

const DEFAULT_SETTINGS = {
  active_window_days: 7,
  retention_lookback_weeks: 7,
  cohort_daily_min: 6, // 7 is impossible over a 7 week window, so the daily band starts at 6
  cohort_byweekly_min: 2,
  cohort_weekly_min: 0.75,
  delete_pin: '969696',
  site_name: 'DP7',
  site_tagline: 'Client deposit tracking & retention',
  // retention CRM (spec) — 7-din rule, VIP by count, priority
  inactive_days: 7,
  recent_inactive_days: 14,
  vip_min_count: 25,
  vip_premium_count: 51,
  vip_high_count: 101,
  telecmi_app_id: '',
  telecmi_secret: '',
  telecmi_agent: '',
};

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  console.log('→ applying schema…');
  await pool.query(schema);

  for (const [file, label] of [
    ['schema-v3.sql', 'schema v3 (customers, calls, txn status)'],
    ['schema-v3.2.sql', 'schema v3.2 (deposit count support)'],
    ['schema-v3.4.sql', 'schema v3.4 (upload batch protection)'],
    ['schema-v3.5.sql', 'schema v3.5 (purana unique index cleanup)'],
    ['schema-v3.8.sql', 'schema v3.8 (follow-up scheduling)'],
    ['schema-v3.8.1.sql', 'schema v3.8.1 (purane follow-up dates fix)'],
    ['schema-v3.9.sql', 'schema v3.9 (admin-approved login)'],
    ['schema-v4.1.sql', 'schema v4.1 (daily target + progress)'],
    ['schema-v4.2.sql', 'schema v4.2 (auto-split + caller load)'],
    ['schema-v4.3.sql', 'schema v4.3 (retention cadence)'],
  ]) {
    const p2 = path.join(__dirname, '..', 'db', file);
    if (!fs.existsSync(p2)) continue;
    console.log(`→ applying ${label}…`);
    await pool.query(fs.readFileSync(p2, 'utf8'));
  }

  // Level bands (only seed when the table is empty, so edits are never overwritten)
  const levelCount = Number((await pool.query('SELECT COUNT(*)::int AS c FROM levels')).rows[0].c);
  if (levelCount === 0) {
    console.log('→ seeding level bands…');
    for (const l of DEFAULT_LEVELS) {
      await pool.query(
        'INSERT INTO levels (name, min_amount, max_amount, sort) VALUES ($1,$2,$3,$4)',
        [l.name, l.min, l.max, l.sort]
      );
    }
  } else {
    console.log(`→ levels already present (${levelCount}), left untouched`);
  }

  for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(val)]
    );
  }
  console.log('→ settings ensured');

  // First super admin. Change the password right after the first login.
  const loginId = (process.env.SEED_ADMIN_LOGIN || 'admin').trim();
  const password = process.env.SEED_ADMIN_PASSWORD || 'admin123';
  const existing = await pool.query('SELECT id FROM users WHERE login_id = $1', [loginId]);

  if (existing.rowCount === 0) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access)
       VALUES ($1,$2,$3,'super_admin','{}')`,
      ['Super Admin', loginId, hash]
    );
    console.log(`→ created super admin "${loginId}" (password: ${password}) — change it after login`);
  } else {
    console.log(`→ super admin "${loginId}" already exists, password left unchanged`);
  }

  // customers master ko deposits se sync karo (idempotent)
  try {
    const C = require('../src/lib/customers');
    const r = await C.syncCustomers();
    console.log(`→ customers synced: ${r.total} total, ${r.created} new, ${r.updated} updated`);
  } catch (err) {
    console.log('→ customer sync skip:', err.message);
  }

  console.log('✓ migrate complete');
  await pool.end();
}

main().catch((err) => {
  console.error('✗ migrate failed:', err.message);
  console.error(err);
  process.exit(1);
});

