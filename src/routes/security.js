'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

router.get('/', auth.requireLogin, async (req, res, next) => {
  try {
    const me = await db.row(
      'SELECT id, name, login_id, role, totp_enabled, last_login_at FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const log = await db.rows(
      `SELECT action, detail, ip, created_at FROM audit_log
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [req.session.user.id]
    );
    res.render('security', {
      title: 'Security',
      page: 'security',
      me,
      log,
      qr: null,
      secret: req.session.newTotpSecret || null,
      tab: req.query.tab || 'password',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/password', auth.requireLogin, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || '');
    const next1 = String(req.body.new_password || '');
    const next2 = String(req.body.confirm_password || '');

    const me = await db.row('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (!(await bcrypt.compare(current, me.password_hash))) {
      req.session.flash = { type: 'error', message: 'Purana password galat hai.' };
      return res.redirect('/security?tab=password');
    }
    if (next1.length < 6) {
      req.session.flash = { type: 'error', message: 'Naya password kam se kam 6 character ka hona calls.' };
      return res.redirect('/security?tab=password');
    }
    if (next1 !== next2) {
      req.session.flash = { type: 'error', message: 'Dono naye password match nahi kar rahe.' };
      return res.redirect('/security?tab=password');
    }

    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      me.id,
      await bcrypt.hash(next1, 10),
    ]);
    await auth.audit(req, 'change_password', null);
    req.session.flash = { type: 'success', message: 'Password change ho gaya.' };
    res.redirect('/security?tab=password');
  } catch (err) {
    next(err);
  }
});

// 2FA step 1 — secret generate karke QR dikhao
router.post('/2fa/start', auth.requireLogin, async (req, res, next) => {
  try {
    const me = await db.row('SELECT login_id FROM users WHERE id = $1', [req.session.user.id]);
    const secret = authenticator.generateSecret();
    req.session.newTotpSecret = secret;
    const otpauth = authenticator.keyuri(me.login_id, 'DP7', secret);
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 260 });
    await auth.audit(req, '2fa_setup_started', null);

    const full = await db.row('SELECT id, name, login_id, role, totp_enabled FROM users WHERE id = $1', [
      req.session.user.id,
    ]);
    res.render('security', {
      title: 'Security',
      page: 'security',
      me: full,
      log: [],
      qr,
      secret,
      tab: '2fa',
    });
  } catch (err) {
    next(err);
  }
});

// 2FA step 2 — ek code verify karke enable
router.post('/2fa/confirm', auth.requireLogin, async (req, res, next) => {
  try {
    const secret = req.session.newTotpSecret;
    const token = String(req.body.token || '').replace(/\s+/g, '');
    if (!secret) return res.redirect('/security?tab=2fa');
    if (token.length !== 6 || !authenticator.check(token, secret)) {
      req.session.flash = { type: 'error', message: 'Code match nahi hua. App me naya code check kijiye.' };
      return res.redirect('/security?tab=2fa');
    }
    await db.query('UPDATE users SET totp_secret = $2, totp_enabled = TRUE WHERE id = $1', [
      req.session.user.id,
      secret,
    ]);
    delete req.session.newTotpSecret;
    await auth.audit(req, '2fa_enabled', null);
    req.session.flash = { type: 'success', message: 'Two-factor on ho gaya.' };
    res.redirect('/security?tab=2fa');
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/disable', auth.requireLogin, async (req, res, next) => {
  try {
    const me = await db.row('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (!(await bcrypt.compare(String(req.body.password || ''), me.password_hash))) {
      req.session.flash = { type: 'error', message: 'Password galat hai — 2FA on hi rahega.' };
      return res.redirect('/security?tab=2fa');
    }
    await db.query('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1', [me.id]);
    await auth.audit(req, '2fa_disabled', null);
    req.session.flash = { type: 'success', message: 'Two-factor off ho gaya.' };
    res.redirect('/security?tab=2fa');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

