'use strict';

const express = require('express');
const auth = require('../auth');
const reports = require('../lib/reports');

const router = express.Router();

router.get('/', auth.requireLogin, async (req, res, next) => {
  try {
    // Dashboard access na ho to user ko uske pehle allowed page par bhejo.
    if (!auth.can(req.session.user, 'dashboard')) return res.redirect(auth.landingPage(req.session.user));
    const data = await reports.dashboardData();
    res.render('dashboard', { title: 'Dashboard', page: 'dashboard', data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;


