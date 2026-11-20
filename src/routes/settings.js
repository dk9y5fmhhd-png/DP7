'use strict';

const express = require('express');
const auth = require('../auth');
const settings = require('../settings');

const router = express.Router();

router.use(auth.requireSuperAdmin);

router.get('/', async (req, res, next) => {
  try {
    const cfg = await settings.all();
    const levels = await settings.levels();
    res.render('settings', {
      title: 'Settings',
      page: 'settings',
      cfg,
      levels,
      saved: req.query.saved === '1',
      tab: req.query.tab || 'general',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/general', async (req, res, next) => {
  try {
    const num = (v, fallback, min, max) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(n, min), max);
    };

    const cfg = {
      site_name: String(req.body.site_name || 'DP7').trim().slice(0, 40) || 'DP7',
      site_tagline: String(req.body.site_tagline || '').trim().slice(0, 120),
      active_window_days: Math.round(num(req.body.active_window_days, 7, 1, 365)),
      retention_lookback_weeks: Math.round(num(req.body.retention_lookback_weeks, 7, 1, 52)),
      cohort_daily_min: num(req.body.cohort_daily_min, 6, 0.5, 7),
      cohort_byweekly_min: num(req.body.cohort_byweekly_min, 2, 0.5, 7),
      cohort_weekly_min: num(req.body.cohort_weekly_min, 0.75, 0.05, 7),
      delete_pin: String(req.body.delete_pin || '969696').trim().slice(0, 20),
    };

    if (!(cfg.cohort_daily_min > cfg.cohort_byweekly_min && cfg.cohort_byweekly_min > cfg.cohort_weekly_min)) {
      req.session.flash = {
        type: 'error',
        message: 'Cohort limits ghatte kram me hone chahiye: Daily > By Weekly > Weekly.',
      };
      return res.redirect('/settings?tab=cohorts');
    }

    await settings.setMany(cfg);
    await auth.audit(req, 'update_settings', 'general');
    req.session.flash = { type: 'success', message: 'Settings save ho gaye.' };
    res.redirect('/settings?tab=general&saved=1');
  } catch (err) {
    next(err);
  }
});

router.post('/levels', async (req, res, next) => {
  try {
    const names = [].concat(req.body.level_name || []);
    const mins = [].concat(req.body.level_min || []);
    const maxs = [].concat(req.body.level_max || []);
    const ids = [].concat(req.body.level_id || []);

    const list = names.map((name, i) => ({
      id: ids[i] ? Number(ids[i]) : null,
      name,
      min: mins[i],
      max: maxs[i],
    }));

    try {
      await settings.saveLevels(list);
    } catch (e) {
      req.session.flash = { type: 'error', message: e.message };
      return res.redirect('/settings?tab=levels');
    }

    await auth.audit(req, 'update_levels', `${list.length} bands`);
    req.session.flash = { type: 'success', message: 'Level bands save ho gaye.' };
    res.redirect('/settings?tab=levels');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

