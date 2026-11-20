'use strict';

const express = require('express');
const auth = require('../auth');
const R = require('../lib/reports');
const D = require('../lib/dates');

const router = express.Router();

const PER_PAGE = 100;

function intOr(value, fallback = 1) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  const head = headers.map((h) => csvCell(h.label)).join(',');
  const body = rows.map((r) => headers.map((h) => csvCell(h.get(r))).join(',')).join('\n');
  return head + '\n' + body + '\n';
}
function sendCsv(res, filename, content) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\ufeff' + content); // BOM so Excel shows ₹ and Hindi text correctly
}

/* ---------------- Client reports ---------------- */

async function buildClientReport(req, perPage) {
  const date = D.isDate(req.query.date) ? req.query.date : D.todayISO();
  return R.clientReport({
    date,
    levelId: req.query.level ? Number(req.query.level) : null,
    quiet: req.query.quiet || 'today',
    dupsOnly: req.query.dups === '1',
    page: intOr(req.query.page, 1),
    perPage: perPage || PER_PAGE,
  }).then((data) => ({ ...data, date }));
}

router.get('/', auth.requirePage('reports'), async (req, res, next) => {
  try {
    const data = await buildClientReport(req);
    const levels = await R.levelMap();
    res.render('reports', {
      title: 'Client Reports',
      page: 'reports',
      data,
      levels: levels.list,
      filters: {
        date: data.date,
        level: req.query.level || '',
        quiet: req.query.quiet || 'today',
        dups: req.query.dups === '1',
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- Level report ---------------- */

async function buildLevelReport(req, perPage) {
  return R.levelReport({
    levelId: req.query.level ? Number(req.query.level) : null,
    dupsOnly: req.query.dups === '1',
    sort: req.query.sort || 'total_desc',
    page: intOr(req.query.page, 1),
    perPage: perPage || PER_PAGE,
  });
}

router.get('/level', auth.requirePage('level_report'), async (req, res, next) => {
  try {
    const data = await buildLevelReport(req);
    const levels = await R.levelMap();
    res.render('level_report', {
      title: 'Level Report',
      page: 'level_report',
      data,
      levels: levels.list,
      filters: { level: req.query.level || '', dups: req.query.dups === '1', sort: req.query.sort || 'total_desc' },
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- Cohorts ---------------- */

const COHORT_ROUTES = {
  '/daily': { kind: 'daily', perm: 'daily_report', page: 'daily_report' },
  '/weekly': { kind: 'weekly', perm: 'weekly_report', page: 'weekly_report' },
  '/biweekly': { kind: 'biweekly', perm: 'biweekly_report', page: 'biweekly_report' },
  '/monthly': { kind: 'monthly', perm: 'monthly_report', page: 'monthly_report' },
};

for (const [path, cfg] of Object.entries(COHORT_ROUTES)) {
  router.get(path, auth.requirePage(cfg.perm), async (req, res, next) => {
    try {
      const anchor = D.isDate(req.query.d) ? req.query.d : D.todayISO();
      const data = await R.cohortReport({
        kind: cfg.kind,
        anchor,
        dupsOnly: req.query.dups === '1',
        page: intOr(req.query.page, 1),
        perPage: PER_PAGE,
      });
      res.render('cohort', {
        title: data.meta.title,
        page: cfg.page,
        data,
        filters: { d: anchor, dups: req.query.dups === '1' },
        prevAnchor: D.shiftPeriod(cfg.kind, anchor, -1),
        nextAnchor: D.shiftPeriod(cfg.kind, anchor, 1),
        isCurrent: cfg.kind === 'daily' ? anchor >= D.todayISO() : false,
      });
    } catch (err) {
      next(err);
    }
  });
}

/* ---------------- CSV export ---------------- */

router.get('/export', auth.requireLogin, async (req, res, next) => {
  try {
    const type = req.query.type || 'client';

    if (type === 'client') {
      if (!auth.can(req.session.user, 'reports')) return res.status(403).end();
      const data = await buildClientReport(req, 100000);
      const csv = toCsv(
        [
          { label: 'Username', get: (r) => r.username },
          { label: 'Mobile', get: (r) => r.mobile },
          { label: 'Level', get: (r) => r.levelName || 'No level' },
          { label: 'Total Deposited', get: (r) => r.total_deposited },
          { label: 'Deposits', get: (r) => r.deposit_count },
          { label: 'Inactive On', get: () => data.date },
          { label: 'Last Active', get: (r) => r.last_deposit },
          { label: 'Remark', get: (r) => (r.followup ? r.followup.response : '') },
          { label: 'Follow-up', get: (r) => (r.followup ? r.followup.action_type : '') },
          { label: 'Follow-up Date', get: (r) => (r.followup ? r.followup.action_date : '') },
        ],
        data.rows
      );
      return sendCsv(res, `client-report-${data.date}.csv`, csv);
    }

    if (type === 'level') {
      if (!auth.can(req.session.user, 'level_report')) return res.status(403).end();
      const data = await buildLevelReport(req, 100000);
      const csv = toCsv(
        [
          { label: 'Username', get: (r) => r.username },
          { label: 'Mobile', get: (r) => r.mobile },
          { label: 'Total Deposited', get: (r) => r.total_deposited },
          { label: 'Deposits', get: (r) => r.deposit_count },
          { label: 'Level', get: (r) => r.levelName || 'No level' },
          { label: 'Status', get: (r) => (r.active ? 'Active' : 'Inactive') },
          { label: 'Last Active', get: (r) => r.last_deposit },
        ],
        data.rows
      );
      return sendCsv(res, `level-report-${D.todayISO()}.csv`, csv);
    }

    const cohortCfg = { daily: 'daily_report', weekly: 'weekly_report', biweekly: 'biweekly_report', monthly: 'monthly_report' }[type];
    if (cohortCfg) {
      if (!auth.can(req.session.user, cohortCfg)) return res.status(403).end();
      const anchor = D.isDate(req.query.d) ? req.query.d : D.todayISO();
      const data = await R.cohortReport({ kind: type, anchor, perPage: 100000 });
      const csv = toCsv(
        [
          { label: 'Username', get: (r) => r.username },
          { label: 'Mobile', get: (r) => r.mobile },
          { label: 'Level', get: (r) => r.levelName || 'No level' },
          { label: 'Days per week', get: (r) => r.perWeek },
          { label: 'Last Deposit', get: (r) => r.last_deposit },
          { label: 'Remark', get: (r) => (r.followup ? r.followup.response : '') },
          { label: 'Follow-up', get: (r) => (r.followup ? r.followup.action_type : '') },
        ],
        data.rows
      );
      return sendCsv(res, `${type}-report-${anchor}.csv`, csv);
    }

    res.status(400).send('Unknown export type');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

