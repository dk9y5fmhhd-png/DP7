'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const APPROVAL_TTL_MIN = 5; // admin ke paas itne minute tak request zinda

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    login_id: u.login_id,
    role: u.role,
    page_access: u.page_access || [],
    language: u.language || null,
  };
}

/* ------------------------------------------------------------------ *
 * Session banao — login time bhi save hota hai (10 ghante ka clock)
 * ------------------------------------------------------------------ */
function finishLogin(req, user) {
  const returnTo = req.session.returnTo && req.session.returnTo !== '/' ? req.session.returnTo : null;
  const picked = req.session.lang || null;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = publicUser(user);
      if (picked) { req.session.lang = picked; req.session.user.language = picked; }
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      // 10 ghante ka fixed clock — refresh se nahi badhta
      req.session.loginAt = Date.now();
      req.session.expiresAt = Date.now() + auth.sessionMs();
      req.session.ua = String(req.get('user-agent') || '').slice(0, 120);
      req.session.save(async (saveErr) => {
        if (saveErr) return reject(saveErr);
        try {
          await db.query('UPDATE users SET last_login_at = NOW(), language = COALESCE($2, language) WHERE id = $1', [user.id, picked]);
          await auth.audit(req, 'login', `role=${user.role}`);
        } catch (e) {
          console.error('[login]', e.message);
        }
        resolve(returnTo || auth.landingPage(publicUser(user)));
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Admin approval — request banao / status dekho
 * ------------------------------------------------------------------ */
async function needsApproval(user) {
  if (user.role === 'super_admin') return false;
  if (user.require_approval === false) return false;
  const on = await settings.get('require_login_approval', true);
  return on !== false && on !== 'false' && on !== 0;
}

async function createApproval(req, user) {
  // purani pending requests expire kar do
  await db.query(
    `UPDATE login_requests SET status = 'expired', decided_at = NOW()
      WHERE user_id = $1 AND status = 'pending'`,
    [user.id]
  );

  const row = await db.row(
    `INSERT INTO login_requests (user_id, login_id, name, role, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, requested_at`,
    [user.id, user.login_id, user.name, user.role,
      auth.clientIp(req), String(req.get('user-agent') || '').slice(0, 200)]
  );
  return row;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', {
    title: 'Sign in',
    error: null,
    loginId: '',
    expired: req.query.expired === '1',
  });
});

router.post('/login', async (req, res, next) => {
  const loginId = String(req.body.login_id || '').trim();
  const password = String(req.body.password || '');

  try {
    const user = await db.row('SELECT * FROM users WHERE LOWER(login_id) = LOWER($1)', [loginId]);

    const fail = async (message, status = 401) => {
      await auth.audit(req, 'login_failed', `login_id=${loginId}`);
      res.status(status).render('login', { title: 'Sign in', error: message, loginId, expired: false });
    };

    if (!user) return fail('Wrong login ID or password.');

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return fail(`The account is locked. Try again in ${mins} minutes.`);
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
          ? `Wrong password ${MAX_ATTEMPTS} times — account locked for ${LOCK_MINUTES} minutes.`
          : `Wrong login ID or password. ${MAX_ATTEMPTS - attempts} tries left.`
      );
    }

    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

    if (user.totp_enabled && user.totp_secret) {
      req.session.pending2fa = user.id;
      return res.redirect('/login/2fa');
    }

    // ---- admin approval chahiye? ----
    if (await needsApproval(user)) {
      const request = await createApproval(req, user);
      req.session.pendingApproval = { requestId: Number(request.id), userId: user.id };
      return res.redirect('/login/waiting');
    }

    const to = await finishLogin(req, user);
    return res.redirect(to);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------- 2FA ---------------------- */

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
        .render('login2fa', { title: 'Two-factor', error: 'Wrong code, try again.' });
    }

    delete req.session.pending2fa;

    if (await needsApproval(user)) {
      const request = await createApproval(req, user);
      req.session.pendingApproval = { requestId: Number(request.id), userId: user.id };
      return res.redirect('/login/waiting');
    }

    const to = await finishLogin(req, user);
    return res.redirect(to);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------- admin approval ka intezaar ---------------------- */

router.get('/login/waiting', async (req, res, next) => {
  const pa = req.session.pendingApproval;
  if (!pa) return res.redirect('/login');
  try {
    const r = await db.row(
      `SELECT lr.*, u.name AS user_name FROM login_requests lr
         JOIN users u ON u.id = lr.user_id WHERE lr.id = $1`,
      [pa.requestId]
    );
    if (!r) {
      delete req.session.pendingApproval;
      return res.redirect('/login');
    }
    if (r.status === 'approved') return res.redirect('/login/complete');

    const ageMin = Math.floor((Date.now() - new Date(r.requested_at).getTime()) / 60000);
    res.render('login_waiting', {
      title: 'Waiting for approval',
      request: r,
      ageMin,
      ttl: APPROVAL_TTL_MIN,
      stale: ageMin >= APPROVAL_TTL_MIN,
      rejected: r.status === 'rejected',
    });
  } catch (err) {
    next(err);
  }
});

// Poll — page har 2 second me yahan poochhta hai
router.get('/login/status', async (req, res, next) => {
  const pa = req.session.pendingApproval;
  if (!pa) return res.json({ status: 'none' });
  try {
    const r = await db.row('SELECT status, requested_at FROM login_requests WHERE id = $1', [pa.requestId]);
    if (!r) return res.json({ status: 'none' });

    const ageMin = Math.floor((Date.now() - new Date(r.requested_at).getTime()) / 60000);
    if (r.status === 'pending' && ageMin >= APPROVAL_TTL_MIN) {
      await db.query(
        `UPDATE login_requests SET status = 'expired', decided_at = NOW() WHERE id = $1 AND status = 'pending'`,
        [pa.requestId]
      );
      return res.json({ status: 'expired', ageMin });
    }
    res.json({ status: r.status, ageMin });
  } catch (err) {
    next(err);
  }
});

// Approved hone ke baad session banao
router.post('/login/complete', async (req, res, next) => {
  const pa = req.session.pendingApproval;
  if (!pa) return res.redirect('/login');
  try {
    const r = await db.row('SELECT * FROM login_requests WHERE id = $1', [pa.requestId]);
    if (!r || r.status !== 'approved') {
      return res.redirect('/login/waiting');
    }
    const user = await db.row('SELECT * FROM users WHERE id = $1 AND id = $2', [pa.userId, r.user_id]);
    if (!user) return res.redirect('/login');

    delete req.session.pendingApproval;
    await db.query('UPDATE login_requests SET note = $2 WHERE id = $1', [r.id, 'session created']);
    const to = await finishLogin(req, user);
    return res.redirect(to);
  } catch (err) {
    return next(err);
  }
});

// User khud cancel kare
router.post('/login/cancel', async (req, res, next) => {
  const pa = req.session.pendingApproval;
  if (pa) {
    await db.query(
      `UPDATE login_requests SET status = 'expired', decided_at = NOW(), note = 'user cancelled'
        WHERE id = $1 AND status = 'pending'`,
      [pa.requestId]
    ).catch(() => {});
    delete req.session.pendingApproval;
  }
  res.redirect('/login');
});

/* ---------------------- logout ---------------------- */

router.post('/logout', async (req, res) => {
  await auth.audit(req, 'logout', null);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;

