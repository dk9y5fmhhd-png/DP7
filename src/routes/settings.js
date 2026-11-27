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

router.post('/retention', async (req, res, next) => {
  try {
    const num = (v, fallback, min, max) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(n, min), max);
    };

    const cfg = {
      inactive_days: Math.round(num(req.body.inactive_days, 7, 1, 90)),
      recent_inactive_days: Math.round(num(req.body.recent_inactive_days, 14, 1, 180)),
      vip_min_count: Math.round(num(req.body.vip_min_count, 25, 1, 1000)),
      vip_premium_count: Math.round(num(req.body.vip_premium_count, 51, 2, 2000)),
      vip_high_count: Math.round(num(req.body.vip_high_count, 101, 3, 5000)),
    };

    if (!(cfg.vip_high_count > cfg.vip_premium_count && cfg.vip_premium_count > cfg.vip_min_count)) {
      req.session.flash = { type: 'error', message: 'VIP counts badhte kram me hone chahiye: VIP < Premium < High Value.' };
      return res.redirect('/settings?tab=retention');
    }

    await settings.setMany(cfg);
    // naye thresholds se master dobara sync
    const r = await require('../lib/customers').syncCustomers();
    await auth.audit(req, 'settings_retention', JSON.stringify(cfg));
    req.session.flash = {
      type: 'success',
      message: `Retention settings save — ${r.total} customers dobara check hue.`,
    };
    res.redirect('/settings?tab=retention');
  } catch (err) {
    next(err);
  }
});

router.post('/telecmi', async (req, res, next) => {
  try {
    await settings.setMany({
      telecmi_app_id: String(req.body.telecmi_app_id || '').trim().slice(0, 120),
      telecmi_secret: String(req.body.telecmi_secret || '').trim().slice(0, 200),
      telecmi_agent: String(req.body.telecmi_agent || '').replace(/[^\d+]/g, '').slice(0, 20),
    });
    await auth.audit(req, 'settings_telecmi', 'updated');
    req.session.flash = { type: 'success', message: 'TeleCMI settings save ho gaye.' };
    res.redirect('/settings?tab=telecmi');
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


