'use strict';

// Startup bootstrap — har deploy par tables/settings khud check ho jaate hain.
// Isse "relation does not exist" wali dikkat khatam ho jaati hai; Console me
// npm run migrate chalane ki zaroorat nahi padti.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');

const DEFAULT_SETTINGS = {
  active_window_days: 7,
  retention_lookback_weeks: 7,
  cohort_daily_min: 6,
  cohort_byweekly_min: 2,
  cohort_weekly_min: 0.75,
  delete_pin: '969696',
  site_name: 'DP7',
  site_tagline: 'Client deposit tracking & retention',
  // ---- retention CRM (spec) ----
  inactive_days: 7,
  recent_inactive_days: 14,
  vip_min_count: 25,
  vip_premium_count: 51,
  vip_high_count: 101,
  telecmi_app_id: '',
  telecmi_secret: '',
  telecmi_agent: '',
};

async function run() {
  const root = path.join(__dirname, '..', '..', 'db');
  for (const f of ['schema.sql', 'schema-v3.sql', 'schema-v3.2.sql', 'schema-v3.4.sql', 'schema-v3.5.sql', 'schema-v3.8.sql', 'schema-v3.8.1.sql', 'schema-v3.9.sql', 'schema-v4.1.sql', 'schema-v4.2.sql', 'schema-v4.3.sql', 'schema-v4.4.sql']) {
    const file = path.join(root, f);
    if (!fs.existsSync(file)) continue;
    await db.query(fs.readFileSync(file, 'utf8'));
    console.log('✓ schema applied:', f);
  }

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING',
      [k, JSON.stringify(v)]
    );
  }

  const levels = Number(await db.value('SELECT COUNT(*)::int FROM levels'));
  if (levels === 0) {
    const bands = [
      ['Level 1', 0, 1000, 1], ['Level 2', 1001, 10000, 2], ['Level 3', 10001, 20000, 3],
      ['Level 4', 20001, 50000, 4], ['Level 5', 50001, null, 5],
    ];
    for (const [name, min, max, sort] of bands) {
      await db.query('INSERT INTO levels (name, min_amount, max_amount, sort) VALUES ($1,$2,$3,$4)', [name, min, max, sort]);
    }
    console.log('✓ level bands seeded');
  }

  const admins = Number(await db.value("SELECT COUNT(*)::int FROM users WHERE role = 'super_admin'"));
  if (admins === 0) {
    const loginId = (process.env.SEED_ADMIN_LOGIN || 'admin').trim();
    const password = process.env.SEED_ADMIN_PASSWORD || 'admin123';
    await db.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access)
       VALUES ($1,$2,$3,'super_admin','{}') ON CONFLICT (login_id) DO NOTHING`,
      ['Super Admin', loginId, await bcrypt.hash(password, 10)]
    );
    console.log(`✓ super admin "${loginId}" created`);
  }

  // deposits se customer master sync (idempotent, sasta)
  try {
    const r = await require('./customers').syncCustomers();
    console.log(`✓ customers synced: ${r.total} total, ${r.created} new, ${r.updated} updated`);
  } catch (err) {
    console.log('[bootstrap] customer sync skip:', err.message);
  }

  console.log('✓ bootstrap complete');
}

// Server start hone se pehle chalao, par failure par server band na ho.
async function start() {
  try {
    await run();
  } catch (err) {
    console.error('[bootstrap] fail:', err.message);
    console.error('[bootstrap] Console me `node scripts/migrate.js` chalayein.');
  }
}

module.exports = { run, start };

