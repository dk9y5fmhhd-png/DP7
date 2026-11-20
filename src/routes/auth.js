'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    login_id: u.login_id,
    role: u.role,
    page_access: u.page_access || [],
  };
}

// Session ko regenerate + save karke hi resolve hota hai, warna redirect ke waqt
// cookie save nahi hoti aur user wapas login page par chala jata hai.
function finishLogin(req, user) {
  const returnTo = req.session.returnTo && req.session.returnTo !== '/' ? req.session.returnTo : null;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = publicUser(user);
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      req.session.save(async (saveErr) => {
        if (saveErr) return reject(saveErr);
        try {
          await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
          await auth.audit(req, 'login', `role=${user.role}`);
        } catch (e) {
          console.error('[login]', e.message);
        }
        resolve(returnTo || auth.landingPage(publicUser(user)));
      });
    });
  });
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null, loginId: '' });
});

router.post('/login', async (req, res, next) => {
  const loginId = String(req.body.login_id || '').trim();
  const password = String(req.body.password || '');

  try {
    const user = await db.row('SELECT * FROM users WHERE LOWER(login_id) = LOWER($1)', [loginId]);

    const fail = async (message, status = 401) => {
      await auth.audit(req, 'login_failed', `login_id=${loginId}`);
      res.status(status).render('login', { title: 'Sign in', error: message, loginId });
    };

    if (!user) return fail('Login ID ya password galat hai.');

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return fail(`Account lock hai. ${mins} minute baad try kijiye.`);
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const attempts = user.failed_attempts + 1;
      const lock = attempts >= MAX_ATTEMPTS;
      await db.query(
        'UPDATE users SET failed_attempts = $2, locked_until = $3 WHERE id = $1',
        [user.id, lock ? 0 : attempts, lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null]
      );
      return fail(
        lock
          ? `Galat password ${MAX_ATTEMPTS} dafa — account ${LOCK_MINUTES} minute ke liye lock hai.`
          : `Login ID ya password galat hai. ${MAX_ATTEMPTS - attempts} try baaki.`
      );
    }

    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

    if (user.totp_enabled && user.totp_secret) {
      req.session.pending2fa = user.id;
      return res.redirect('/login/2fa');
    }

    const to = await finishLogin(req, user);
    return res.redirect(to);
  } catch (err) {
    return next(err);
  }
});

router.get('/login/2fa', (req, res) => {
  if (!req.session.pending2fa) return res.redirect('/login');
  res.render('login2fa', { title: 'Two-factor', error: null });
});

router.post('/login/2fa', async (req, res, next) => {
  if (!req.session.pending2fa) return res.redirect('/login');
  const token = String(req.body.token || '').replace(/\s+/g, '');
  try {
    const user = await db.row('SELECT * FROM users WHERE id = $1', [req.session.pending2fa]);
    if (!user) return res.redirect('/login');

    const valid = token.length === 6 && authenticator.check(token, user.totp_secret);
    if (!valid) {
      await auth.audit(req, '2fa_failed', `user=${user.login_id}`);
      return res
        .status(401)
        .render('login2fa', { title: 'Two-factor', error: 'Code galat hai, dobara try kijiye.' });
    }

    delete req.session.pending2fa;
    const to = await finishLogin(req, user);
    return res.redirect(to);
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', async (req, res) => {
  await auth.audit(req, 'logout', null);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;



