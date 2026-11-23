'use strict';

const db = require('../db');
const settings = require('../settings');
const D = require('./dates');

const toLower = (s) => String(s || '').trim().toLowerCase();

async function levelMap() {
  const list = await settings.levels();
  const map = new Map();
  for (const l of list) map.set(l.id, l);
  return { list, map };
}

function levelName(map, id) {
  const l = map.get(Number(id));
  return l ? l.name : null;
}

function levelClass(map, id) {
  const l = map.get(Number(id));
  if (!l) return 'lvl-none';
  return 'lvl-' + (l.sort % 6);
}

async function latestFollowups(usernames) {
  const list = [...new Set(usernames.map(toLower))].filter(Boolean);
  if (!list.length) return new Map();
  const rows = await db.rows(
    `SELECT DISTINCT ON (LOWER(username))
            LOWER(username) AS u, action_type, action_date, response
       FROM followups
      WHERE LOWER(username) = ANY($1::text[])
      ORDER BY LOWER(username), action_date DESC, id DESC`,
    [list]
  );
  const map = new Map();
  for (const r of rows) map.set(r.u, r);
  return map;
}

// Mobile numbers shared by more than one client (data-entry duplicates).
async function duplicateMobiles(whereSql, params) {
  const rows = await db.rows(
    `SELECT cs.mobile, COUNT(*)::int AS c
       FROM client_stats cs
      WHERE ${whereSql} AND cs.mobile <> ''
      GROUP BY cs.mobile HAVING COUNT(*) > 1`,
    params
  );
  const map = new Map();
  for (const r of rows) map.set(r.mobile, r.c);
  return map;
}

function decorate(rows, { levels, followups, dupes }) {
  return rows.map((r) => ({
    ...r,
    levelName: levelName(levels, r.level_id),
    levelClass: levelClass(levels, r.level_id),
    followup: followups.get(toLower(r.username)) || null,
    dupeCount: dupes ? dupes.get(r.mobile) || 0 : 0,
  }));
}

/* ------------------------------------------------------------------ *
 * Client reports — who went quiet and needs a call
 * ------------------------------------------------------------------ */

function quietRange(key, date) {
  switch (key) {
    case 'today':
      return { from: D.addDays(date, -1), label: 'Naye quiet (kal tak active)' };
    case 'd3':
      return { from: D.addDays(date, -3), label: '3 din me quiet' };
    case 'd7':
      return { from: D.addDays(date, -7), label: '7 din me quiet' };
    case 'all':
      return null;
    default:
      return { from: D.addDays(date, -1), label: 'Naye quiet (kal tak active)' };
  }
}

async function clientReport({ date, levelId = null, quiet = 'today', dupsOnly = false, page = 1, perPage = 100 }) {
  const levels = await levelMap();
  const range = quietRange(quiet, date);

  const params = [date];
  const conds = ['cs.last_deposit < $1'];
  if (range) {
    params.push(range.from);
    conds.push(`cs.last_deposit >= $${params.length}`);
  }
  if (levelId) {
    params.push(Number(levelId));
    conds.push(`client_level(cs.total_deposited) = $${params.length}`);
  }
  const whereSql = conds.join(' AND ');

  const dupes = await duplicateMobiles(whereSql, params);
  let rowsWhere = whereSql;
  let rowsParams = params;
  if (dupsOnly) {
    const dupList = [...dupes.keys()];
    if (!dupList.length) {
      return { rows: [], total: 0, totalAll: 0, page: 1, pages: 1, dupes, range, perPage };
    }
    rowsParams = [...params, dupList];
    rowsWhere = `${whereSql} AND cs.mobile = ANY($${rowsParams.length}::text[])`;
  }

  const total = Number(
    await db.value(`SELECT COUNT(*)::int FROM client_stats cs WHERE ${rowsWhere}`, rowsParams)
  );
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(Math.max(1, page), pages);
  const offset = (safePage - 1) * perPage;

  const raw = await db.rows(
    `SELECT cs.username, cs.mobile, cs.last_deposit, cs.total_deposited, cs.deposit_count,
            client_level(cs.total_deposited) AS level_id
       FROM client_stats cs
      WHERE ${rowsWhere}
      ORDER BY cs.last_deposit DESC, cs.total_deposited DESC, cs.username
      LIMIT ${perPage} OFFSET ${offset}`,
    rowsParams
  );

  const followups = await latestFollowups(raw.map((r) => r.username));
  return {
    rows: decorate(raw, { levels: levels.map, followups, dupes }),
    total,
    page: safePage,
    pages,
    dupes,
    range,
    perPage,
  };
}

/* ------------------------------------------------------------------ *
 * Level report — everyone, ranked by lifetime deposits
 * ------------------------------------------------------------------ */

const SORTS = {
  total_desc: 'cs.total_deposited DESC, cs.username',
  total_asc: 'cs.total_deposited ASC, cs.username',
  count_desc: 'cs.deposit_count DESC, cs.username',
  count_asc: 'cs.deposit_count ASC, cs.username',
  days_desc: 'cs.active_days DESC, cs.username',
  user_asc: 'cs.username ASC',
  user_desc: 'cs.username DESC',
  mobile_asc: 'cs.mobile ASC',
  mobile_desc: 'cs.mobile DESC',
};

async function levelReport({ levelId = null, dupsOnly = false, sort = 'total_desc', page = 1, perPage = 100 }) {
  const levels = await levelMap();
  const today = D.todayISO();
  const windowDays = await settings.getNumber('active_window_days', 7);
  const cutoff = D.addDays(today, -windowDays);

  const params = [];
  const conds = ['TRUE'];
  if (levelId) {
    params.push(Number(levelId));
    conds.push(`client_level(cs.total_deposited) = $${params.length}`);
  }
  const whereSql = conds.join(' AND ');

  const dupes = await duplicateMobiles(whereSql, params);

  let rowsWhere = whereSql;
  let rowsParams = params;
  if (dupsOnly) {
    const dupList = [...dupes.keys()];
    if (!dupList.length) {
      return { rows: [], total: 0, page: 1, pages: 1, dupes, perPage, cutoff, unbanded: 0 };
    }
    rowsParams = [...params, dupList];
    rowsWhere = `${whereSql} AND cs.mobile = ANY($${rowsParams.length}::text[])`;
  }

  const total = Number(await db.value(`SELECT COUNT(*)::int FROM client_stats cs WHERE ${rowsWhere}`, rowsParams));
  const unbanded = Number(
    await db.value(
      `SELECT COUNT(*)::int FROM client_stats cs WHERE client_level(cs.total_deposited) IS NULL`
    )
  );
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(Math.max(1, page), pages);
  const offset = (safePage - 1) * perPage;
  const orderBy = SORTS[sort] || SORTS.total_desc;

  const raw = await db.rows(
    `SELECT cs.username, cs.mobile, cs.last_deposit, cs.total_deposited, cs.deposit_count,
            cs.active_days, client_level(cs.total_deposited) AS level_id
       FROM client_stats cs
      WHERE ${rowsWhere}
      ORDER BY ${orderBy}
      LIMIT ${perPage} OFFSET ${offset}`,
    rowsParams
  );

  const followups = await latestFollowups(raw.map((r) => r.username));
  const rows = decorate(raw, { levels: levels.map, followups, dupes }).map((r) => ({
    ...r,
    active: r.last_deposit >= cutoff,
  }));

  return { rows, total, page: safePage, pages, dupes, perPage, cutoff, unbanded };
}

/* ------------------------------------------------------------------ *
 * Cohort reports — Daily / Weekly / By Weekly / Monthly
 * ------------------------------------------------------------------ */

const COHORTS = {
  daily: {
    key: 'daily',
    title: 'Daily Report',
    blurb: 'Clients who deposit almost every day',
    habit: 'most days',
  },
  weekly: {
    key: 'weekly',
    title: 'Weekly Report',
    blurb: 'Clients who deposit about once a week',
    habit: 'about once a week',
  },
  biweekly: {
    key: 'biweekly',
    title: 'By Weekly Report',
    blurb: 'Clients who deposit a few times a week',
    habit: 'a few times a week',
  },
  monthly: {
    key: 'monthly',
    title: 'Monthly Report',
    blurb: 'Clients who deposit a few times a month',
    habit: 'a few times a month',
  },
};

async function thresholds() {
  return {
    daily: await settings.getNumber('cohort_daily_min', 6),
    byweekly: await settings.getNumber('cohort_byweekly_min', 2),
    weekly: await settings.getNumber('cohort_weekly_min', 0.75),
  };
}

function classify(perWeek, th) {
  if (perWeek >= th.daily) return 'daily';
  if (perWeek >= th.byweekly) return 'biweekly';
  if (perWeek >= th.weekly) return 'weekly';
  return 'monthly';
}

// One lookup shared by every cohort page and the dashboard.
async function cohortMembership(period, weeks) {
  const lookbackEnd = D.addDays(period.start, -1);
  const lookbackStart = D.addDays(lookbackEnd, -(weeks * 7) + 1);

  const regRows = await db.rows(
    `SELECT LOWER(username) AS u, COUNT(DISTINCT play_date)::int AS days
       FROM deposits
      WHERE play_date BETWEEN $1 AND $2
      GROUP BY 1`,
    [lookbackStart, lookbackEnd]
  );
  const depositorRows = await db.rows(
    `SELECT DISTINCT LOWER(username) AS u FROM deposits WHERE play_date BETWEEN $1 AND $2`,
    [period.start, period.end]
  );

  const th = await thresholds();
  const members = new Map(); // cohort key -> [{u, perWeek}]
  const buckets = { daily: [], biweekly: [], weekly: [], monthly: [] };

  for (const r of regRows) {
    const perWeek = Math.round((r.days / weeks) * 100) / 100;
    const key = classify(perWeek, th);
    buckets[key].push({ u: r.u, perWeek });
  }

  const deposited = new Set(depositorRows.map((r) => r.u));
  for (const key of Object.keys(buckets)) {
    members.set(key, buckets[key]);
  }

  const summary = {};
  for (const key of Object.keys(buckets)) {
    const total = buckets[key].length;
    const quiet = buckets[key].filter((m) => !deposited.has(m.u));
    summary[key] = { total, quiet: quiet.length, deposited: total - quiet.length };
  }

  return { members, summary, lookbackStart, lookbackEnd, th };
}

async function cohortReport({ kind, anchor, dupsOnly = false, page = 1, perPage = 100 }) {
  const meta = COHORTS[kind];
  if (!meta) throw new Error('Unknown cohort: ' + kind);

  const period = D.periodFor(kind, anchor);
  const weeks = await settings.getNumber('retention_lookback_weeks', 7);
  const { members, summary, lookbackStart, lookbackEnd, th } = await cohortMembership(period, weeks);
  const levels = await levelMap();
  const today = D.todayISO();

  // Quiet clients in this cohort, worst regularity first (matches the old layout).
  const quiet = [...members.get(kind)].sort(
    (a, b) => b.perWeek - a.perWeek || a.u.localeCompare(b.u)
  );
  const totalQuiet = quiet.length;

  const pages = Math.max(1, Math.ceil(totalQuiet / perPage));
  const safePage = Math.min(Math.max(1, page), pages);
  const slice = quiet.slice((safePage - 1) * perPage, safePage * perPage);

  let rows = [];
  let dupes = new Map();
  if (slice.length) {
    const names = slice.map((s) => s.u);
    const raw = await db.rows(
      `SELECT cs.username, cs.mobile, cs.last_deposit, cs.total_deposited, cs.deposit_count,
              client_level(cs.total_deposited) AS level_id
         FROM client_stats cs
        WHERE LOWER(cs.username) = ANY($1::text[])`,
      [names]
    );
    const byName = new Map(raw.map((r) => [toLower(r.username), r]));

    // Duplicate mobiles across this cohort's quiet list
    const mobileCount = new Map();
    for (const r of raw) if (r.mobile) mobileCount.set(r.mobile, (mobileCount.get(r.mobile) || 0) + 1);
    for (const [m, c] of mobileCount) if (c > 1) dupes.set(m, c);

    rows = slice
      .map((s) => {
        const r = byName.get(s.u);
        if (!r) return null;
        return { ...r, perWeek: s.perWeek };
      })
      .filter(Boolean);

    if (dupsOnly) {
      rows = rows.filter((r) => dupes.get(r.mobile));
      if (!rows.length) {
        // fall back to the full cohort so the badge count stays honest
        rows = [];
      }
    }

    const followups = await latestFollowups(rows.map((r) => r.username));
    rows = decorate(rows, { levels: levels.map, followups, dupes });
  }

  const grouped = [];
  let current = null;
  for (const r of rows) {
    const label = r.perWeek.toFixed(1);
    if (!current || current.label !== label) {
      current = { label, perWeek: r.perWeek, rows: [] };
      grouped.push(current);
    }
    current.rows.push(r);
  }

  return {
    meta,
    period,
    weeks,
    lookbackStart,
    lookbackEnd,
    thresholds: th,
    summary: summary[kind],
    allSummary: summary,
    rows,
    grouped,
    total: totalQuiet,
    page: safePage,
    pages,
    perPage,
    dupes,
    today,
  };
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

async function dashboardData() {
  const today = D.todayISO();
  const windowDays = await settings.getNumber('active_window_days', 7);
  const cutoff = D.addDays(today, -windowDays);
  const weeks = await settings.getNumber('retention_lookback_weeks', 7);
  const levels = await levelMap();

  const totals = await db.row(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE last_deposit >= $1)::int AS active,
            COUNT(*) FILTER (WHERE last_deposit < $1)::int AS inactive
       FROM client_stats`,
    [cutoff]
  );

  const rangeStart = D.addDays(today, -windowDays + 1);
  const newClientRows = await db.row(
    `SELECT COUNT(*)::int AS new_clients FROM client_stats WHERE first_deposit >= $1`,
    [rangeStart]
  );

  const weekPeriod = D.periodFor('weekly', today);
  const { summary } = await cohortMembership(weekPeriod, weeks);

  const trend = await db.rows(
    `SELECT play_date::text AS d, COUNT(DISTINCT LOWER(username))::int AS clients,
            COALESCE(SUM(amount), 0)::float8 AS amount
       FROM deposits
      WHERE play_date > $1
      GROUP BY play_date ORDER BY play_date`,
    [D.addDays(today, -14)]
  );

  const followupTypes = await db.rows(
    `SELECT action_type, COUNT(*)::int AS c
       FROM followups
      WHERE action_date > $1
      GROUP BY action_type ORDER BY c DESC`,
    [D.addDays(today, -30)]
  );

  const recentFollowups = await db.rows(
    `SELECT f.username, f.action_type, f.action_date::text AS action_date, f.response,
            f.created_at, u.name AS by_name
       FROM followups f LEFT JOIN users u ON u.id = f.created_by
      ORDER BY f.created_at DESC LIMIT 8`
  );

  const topClients = await db.rows(
    `SELECT cs.username, cs.mobile, cs.total_deposited, cs.last_deposit,
            client_level(cs.total_deposited) AS level_id
       FROM client_stats cs
      ORDER BY cs.total_deposited DESC LIMIT 5`
  );

  const dupCount = Number(
    await db.value(
      `SELECT COUNT(*)::int FROM (SELECT mobile FROM client_stats WHERE mobile <> '' GROUP BY mobile HAVING COUNT(*) > 1) x`
    )
  );

  // ---- retention CRM (spec) ----
  let crm = {
    total: 0, new: 0, active: 0, inactive: 0, reactivated: 0,
    vip: 0, premium: 0, high: 0,
    p1: 0, p2: 0, p3: 0, free: 0,
    callsToday: 0, remarksToday: 0,
  };
  try {
    const row = await db.row(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'new')::int AS new_c,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active_c,
         COUNT(*) FILTER (WHERE status = 'inactive')::int AS inactive_c,
         COUNT(*) FILTER (WHERE status = 'reactivated')::int AS reactivated_c,
         COUNT(*) FILTER (WHERE vip_category = 'vip')::int AS vip_c,
         COUNT(*) FILTER (WHERE vip_category = 'premium_vip')::int AS premium_c,
         COUNT(*) FILTER (WHERE vip_category = 'high_value_vip')::int AS high_c,
         COUNT(*) FILTER (WHERE priority = 'P1')::int AS p1,
         COUNT(*) FILTER (WHERE priority = 'P2')::int AS p2,
         COUNT(*) FILTER (WHERE priority = 'P3')::int AS p3,
         COUNT(*) FILTER (WHERE assigned_to IS NULL)::int AS free
       FROM customer_board`
    );
    const calls = await db.value('SELECT COUNT(*)::int FROM calls WHERE called_at::date = $1', [today]);
    const remarks = await db.value('SELECT COUNT(*)::int FROM followups WHERE action_date = $1', [today]);
    crm = {
      total: row.total, new: row.new_c, active: row.active_c, inactive: row.inactive_c,
      reactivated: row.reactivated_c,
      vip: row.vip_c, premium: row.premium_c, high: row.high_c,
      p1: row.p1, p2: row.p2, p3: row.p3, free: row.free,
      callsToday: Number(calls), remarksToday: Number(remarks),
    };
  } catch (err) {
    console.error('[dashboard] crm stats skip:', err.message);
  }

  return {
    today,
    windowDays,
    cutoff,
    crm,
    totals: {
      total: totals.total,
      active: totals.active,
      inactive: totals.inactive,
      activityPct: totals.total ? Math.round((totals.active / totals.total) * 100) : 0,
      newClients: newClientRows.new_clients,
      duplicates: dupCount,
    },
    cohorts: summary,
    weekPeriod,
    trend,
    followupTypes,
    recentFollowups,
    topClients: topClients.map((r) => ({
      ...r,
      levelName: levelName(levels.map, r.level_id),
      levelClass: levelClass(levels.map, r.level_id),
    })),
    rangeStart,
  };
}

module.exports = {
  COHORTS,
  clientReport,
  levelReport,
  cohortReport,
  cohortMembership,
  dashboardData,
  latestFollowups,
  levelMap,
  levelName,
  levelClass,
};



