'use strict';

// Caller Load — admin dekhta hai kis caller ke paas kitna kaam hai,
// aur yahan se barabar auto-split karta hai.

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const split = require('../lib/split');

const router = express.Router();

router.use(auth.requireSuperAdmin);

async function callerOptions() {
  return db.rows(
    `SELECT u.id, u.name, u.login_id, u.team, u.daily_target,
            (SELECT COUNT(*)::int FROM customer_board b
              WHERE b.assigned_to = u.id AND b.do_not_contact = FALSE) AS assigned
       FROM users u
      WHERE u.role <> 'super_admin'
      ORDER BY u.team, u.name`
  );
}

router.get('/', async (req, res, next) => {
  try {
    const team = ['retention', 'acquisition'].includes(req.query.team) ? req.query.team : '';
    const { rows, totals } = await split.callerLoad({ team });

    const unassigned = await db.row(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE priority = 'P1')::int AS p1,
         COUNT(*) FILTER (WHERE priority = 'P2')::int AS p2,
         COUNT(*) FILTER (WHERE priority = 'P3')::int AS p3,
         COUNT(*) FILTER (WHERE priority = 'P4')::int AS p4
       FROM customer_board
      WHERE assigned_to IS NULL AND do_not_contact = FALSE`
    );

    const lastRuns = await db.rows(
      `SELECT sr.*, u.name AS by_name
         FROM split_runs sr LEFT JOIN users u ON u.id = sr.run_by
        ORDER BY sr.run_at DESC LIMIT 8`
    );

    res.render('caller_load', {
      title: 'Caller Load',
      page: 'callers',
      rows, totals, unassigned, lastRuns,
      callers: await callerOptions(),
      team,
      preview: req.session.splitPreview || null,
    });
    delete req.session.splitPreview;
  } catch (err) {
    next(err);
  }
});

// Split ka preview — DB ko chhue bina, pehle dikhao
router.post('/preview', async (req, res, next) => {
  try {
    const callerIds = [].concat(req.body.caller_id || []).map(Number).filter(Boolean);
    const scope = req.body.scope || 'unassigned';
    const priority = req.body.priority || '';
    const perCaller = Number(req.body.per_caller) || 0;
    const take = Number(req.body.take) || 0;

    const plan = await split.buildPlan({ callerIds, scope, priority, perCaller, take });

    const names = await db.rows('SELECT id, name FROM users WHERE id = ANY($1::int[])', [plan.callers]);
    const nameMap = new Map(names.map((n) => [n.id, n.name]));

    // Preview ko session me rakho — apply wahi karega (user file badal na sake)
    req.session.splitPlan = {
      callerIds: plan.callers,
      counts: plan.counts,
      scope, priority, perCaller: plan.perCaller, total: plan.total,
      at: Date.now(),
    };

    req.session.splitPreview = {
      scope, priority, perCaller: plan.perCaller, total: plan.total,
      available: plan.available,
      rows: plan.callers.map((id) => ({
        id, name: nameMap.get(id) || String(id), ...plan.counts[id],
      })),
    };
    res.redirect('/callers#preview');
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect('/callers');
  }
});

// Preview confirm → asli assignment
router.post('/apply', async (req, res, next) => {
  try {
    const saved = req.session.splitPlan;
    if (!saved || Date.now() - saved.at > 10 * 60 * 1000) {
      req.session.flash = { type: 'error', message: 'Preview purana ho gaya (10 minute). Dobara preview banayein.' };
      return res.redirect('/callers');
    }

    // Same logic se dobara plan banao — session me sirf count tha, usernames nahi
    const plan = await split.buildPlan({
      callerIds: saved.callerIds,
      scope: saved.scope,
      priority: saved.priority,
      perCaller: saved.perCaller,
      take: saved.total,
    });

    const applied = await split.applyPlan({
      plan: plan.plan,
      runBy: req.session.user.id,
      scope: saved.scope,
      callers: saved.callerIds.length,
      perCaller: plan.perCaller,
      total: plan.total,
    });

    delete req.session.splitPlan;
    await auth.audit(req, 'auto_split', `applied=${applied} callers=${saved.callerIds.length} scope=${saved.scope}`);

    req.session.flash = {
      type: 'success',
      message: `${applied} customers split across ${saved.callerIds.length} callers — about ${plan.perCaller} each.`,
    };
    res.redirect('/callers');
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect('/callers');
  }
});

router.post('/cancel', async (req, res) => {
  delete req.session.splitPlan;
  res.redirect('/callers');
});

// Team badalna (retention / acquisition)
router.post('/:id/team', async (req, res, next) => {
  try {
    const team = req.body.team === 'acquisition' ? 'acquisition' : 'retention';
    const target = await db.row('SELECT id, login_id, role FROM users WHERE id = $1', [req.params.id]);
    if (!target) {
      req.session.flash = { type: 'error', message: 'User nahi mila.' };
      return res.redirect('/callers');
    }
    if (target.role === 'super_admin') {
      req.session.flash = { type: 'error', message: 'Super Admin ka koi team nahi.' };
      return res.redirect('/callers');
    }
    await db.query('UPDATE users SET team = $2 WHERE id = $1', [target.id, team]);
    await auth.audit(req, 'team_change', `${target.login_id} → ${team}`);
    req.session.flash = { type: 'success', message: `${target.login_id} is now on the ${team} team.` };
    res.redirect('/callers');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

