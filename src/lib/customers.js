'use strict';

// Customer master engine — spec ke hisaab se status, VIP aur priority.
//
// 1. Status (7-din ka niyam)
//    - pehla deposit            → New
//    - 7 days dobara deposit  → Active
//    - 7 din tak koi deposit nahi → Inactive
//    - Inactive ne dobara kiya  → Reactivated
//    Har naye deposit par 7 din ka countdown phir se shuru.
//
// 2. VIP — sirf successful deposit ke COUNT se (amount se nahi), aur permanent
//    1-24 normal · 25+ VIP · 51+ Premium VIP · 101+ High Value VIP
//
// 3. Priority
//    P1 = VIP inactive, ya recently inactive (<=14 din)
//    P2 = normal inactive, ya new customer jiska repeat nahi hua
//    P3 = reactivated (became active again)
//    P4 = active (no call needed)

const db = require('../db');

const VIP_ORDER = ['normal', 'vip', 'premium_vip', 'high_value_vip'];
const VIP_LABEL = {
  normal: 'Normal',
  vip: 'VIP',
  premium_vip: 'Premium VIP',
  high_value_vip: 'High Value VIP',
};
const STATUS_LABEL = {
  new: 'New',
  active: 'Active',
  inactive: 'Inactive',
  reactivated: 'Reactivated',
  no_deposit: 'ID created · no deposit',
};
const PRIORITY_LABEL = {
  P0: 'P0 — Do not contact',
  PD: 'PD — First deposit pending',
  P1: 'P1 — Sabse pehle',
  P2: 'P2 — Regular',
  P3: 'P3 — Reactivated',
  P4: 'P4 — Active',
};

const rank = (cat) => VIP_ORDER.indexOf(cat);

function vipForCount(count, cfg) {
  if (count >= cfg.vip_high_min) return 'high_value_vip';
  if (count >= cfg.vip_premium_min) return 'premium_vip';
  if (count >= cfg.vip_min) return 'vip';
  return 'normal';
}

/* ------------------------------------------------------------------ *
 * Sync: deposits → customers
 * ------------------------------------------------------------------ */

async function syncCustomers() {
  const cfg = await thresholds();

  // Sirf successful deposits ginte hain (failed / pending / reversed chhod do)
  const rows = await db.rows(
    `SELECT LOWER(username) AS u,
            MAX(username) AS username,
            (ARRAY_AGG(mobile ORDER BY play_date DESC, id DESC))[1] AS mobile,
            MIN(play_date) AS first_deposit,
            MAX(play_date) AS last_deposit,
            COUNT(*)::int AS cnt,
            COALESCE(SUM(amount), 0)::float8 AS amt,
            COALESCE(SUM(txn_count), 0)::int AS txn_cnt
       FROM deposits
      WHERE status = 'successful'
      GROUP BY LOWER(username)`
  );

  const existing = new Map(
    (await db.rows('SELECT * FROM customers')).map((c) => [c.username.toLowerCase(), c])
  );

  let created = 0;
  let updated = 0;

  for (const r of rows) {
    const key = r.u;
    const prev = existing.get(key);
    const daysSinceLast = daysBetween(r.last_deposit);

    let status;
    if (r.txn_cnt <= 1 && daysSinceLast <= cfg.inactive_days) status = 'new';
    else if (daysSinceLast > cfg.inactive_days) status = 'inactive';
    else if (prev && (prev.status === 'inactive' || prev.status === 'reactivated')) status = 'reactivated';
    else status = 'active';

    // VIP kabhi neeche nahi jaata
    const computed = vipForCount(r.txn_cnt, cfg);
    const vip = prev && rank(prev.vip_category) > rank(computed) ? prev.vip_category : computed;

    const reactivatedAt =
      status === 'reactivated' && (!prev || prev.status !== 'reactivated')
        ? r.last_deposit
        : prev
          ? prev.reactivated_at
          : null;

    if (!prev) {
      await db.query(
        `INSERT INTO customers
           (username, mobile, reg_date, first_deposit, last_deposit, deposit_count, deposit_amount,
            status, vip_category, reactivated_at, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [r.username, r.mobile || '', r.first_deposit, r.first_deposit, r.last_deposit,
          r.txn_cnt, r.amt, status, vip, reactivatedAt]
      );
      created++;
    } else {
      await db.query(
        `UPDATE customers
            SET username = $2, mobile = $3, first_deposit = $4, last_deposit = $5,
                deposit_count = $6, deposit_amount = $7, status = $8, vip_category = $9,
                reactivated_at = $10, last_synced_at = NOW()
          WHERE id = $1`,
        [prev.id, r.username, r.mobile || prev.mobile || '', r.first_deposit, r.last_deposit,
          r.txn_cnt, r.amt, status, vip, reactivatedAt]
      );
      updated++;
    }
  }

  // Jin customers ka koi successful deposit nahi bacha
  const active = new Set(rows.map((r) => r.u));
  let cleared = 0;
  for (const [key, c] of existing) {
    if (active.has(key)) continue;

    // Pehle se no_deposit hai par purani dates chipki hui hain (delete ke baad ka case)
    if (c.status === 'no_deposit') {
      if (c.last_deposit !== null || c.first_deposit !== null) {
        await db.query(
          `UPDATE customers SET first_deposit = NULL, last_deposit = NULL,
                  deposit_count = 0, deposit_amount = 0, last_synced_at = NOW()
            WHERE id = $1`,
          [c.id]
        );
        cleared++;
      }
      continue;
    }

    await db.query(
      `UPDATE customers
          SET status = 'no_deposit', deposit_count = 0, deposit_amount = 0,
              first_deposit = NULL, last_deposit = NULL, reactivated_at = NULL,
              last_synced_at = NOW()
        WHERE id = $1`,
      [c.id]
    );
    cleared++;
  }

  // Deposit badla → status/VIP badla → cadence tier bhi badal sakta hai.
  // (schema v4.3 se pehle ye column nahi hota, isliye silent fail.)
  let cadence = null;
  try {
    cadence = await require('./cadence').refreshAll();
  } catch (e) {
    if (!/cadence_tier|next_touch_on|does not exist/i.test(e.message)) {
      console.error('[cadence]', e.message);
    }
  }

  return { total: rows.length, created, updated, cleared, cadence };
}

function daysBetween(dateStr) {
  if (!dateStr) return 9999;
  const today = new Date();
  const todayISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TZ || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(today);
  const a = Date.parse(todayISO + 'T00:00:00Z');
  const b = Date.parse(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}

async function thresholds() {
  const get = async (k, d) => {
    const v = await db.value('SELECT value FROM settings WHERE key = $1', [k]);
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    inactive_days: await get('inactive_days', 7),
    recent_inactive_days: await get('recent_inactive_days', 14),
    vip_min: await get('vip_min_count', 25),
    vip_premium_min: await get('vip_premium_count', 51),
    vip_high_min: await get('vip_high_count', 101),
  };
}

/* ------------------------------------------------------------------ *
 * Priority — board view me already calculate hota hai, yahan JS me bhi
 * ------------------------------------------------------------------ */

function priorityFor(c, cfg) {
  if (c.do_not_contact) return 'P0';
  // ID created with no deposit yet — first in queue
  if (c.status === 'no_deposit') return 'PD';
  if (c.status === 'inactive' && c.vip_category !== 'normal') return 'P1';
  if (c.status === 'inactive' && Number(c.days_inactive) <= (cfg ? cfg.recent_inactive_days : 14)) return 'P1';
  if (c.status === 'new') return 'P2';
  if (c.status === 'inactive') return 'P2';
  if (c.status === 'reactivated') return 'P3';
  return 'P4';
}

/* ------------------------------------------------------------------ *
 * Mobile masking — caller ko poora number nahi dikhta
 * ------------------------------------------------------------------ */

function maskMobile(mobile, canSeeFull) {
  const m = String(mobile || '');
  if (canSeeFull) return m;
  if (m.length < 4) return m ? '••••' : '';
  return '•'.repeat(Math.max(0, m.length - 4)) + m.slice(-4);
}

module.exports = {
  VIP_ORDER, VIP_LABEL, STATUS_LABEL, PRIORITY_LABEL,
  vipForCount, syncCustomers, thresholds, priorityFor, maskMobile, daysBetween, rank,
};





