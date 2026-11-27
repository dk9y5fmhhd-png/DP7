'use strict';

// POST /language — the switch on the sign-in page and in the top bar.

const express = require('express');
const db = require('../db');
const i18n = require('../lib/i18n');

const router = express.Router();

router.post('/language', async (req, res, next) => {
  try {
    const lang = String(req.body.lang || '');
    if (i18n.isLang(lang)) {
      req.session.lang = lang;
      if (req.session.user) {
        req.session.user.language = lang;
        await db.query('UPDATE users SET language = $2 WHERE id = $1', [req.session.user.id, lang]);
      }
    }
    // Back to the same page, never to another site.
    let back = '/';
    try {
      const from = new URL(req.get('referer'));
      if (from.host === req.get('host')) back = from.pathname + from.search;
    } catch { /* no referer */ }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
