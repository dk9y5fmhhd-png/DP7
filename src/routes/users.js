'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

const GRANTABLE = auth.PAGES.filter((p) => !p.superOnly && p.key !== 'security');

// Roz ka call target — 0 se 500. 0 = koi limit nahi.
function targetOf(v, fallback = 40) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 0), 500);
}

// Team — retention (purane client) ya acquisition (naye client)
function teamOf(v, fallback = 'retention') {
  return v === 'acquisition' ? 'acquisition' : (v === 'retention' ? 'retention' : fallback);
}

router.use(auth.requireSuperAdmin);

async function listUsers() {
  return db.rows(
    `SELECT id, name, login_id, role, page_access, daily_target, team, totp_enabled, failed_attempts,
            locked_until, last_login_at, created_at
       FROM users ORDER BY role DESC, name`
  );
}

router.get('/', async (req, res, next) => {
  try {
    const users = await listUsers();
    res.render('users', {
      title: 'Users',
      page: 'users',
      users,
      grantable: GRANTABLE,
      flash: req.session.flash || null,
    });
    delete req.session.flash;
  } catch (err) {
    next(err);
  }
});

function normaliseAccess(body) {
  const raw = body.page_access;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((p) => auth.PAGE_KEYS.includes(p));
}

router.post('/create', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const loginId = String(req.body.login_id || '').trim();
    const password = String(req.body.password || '');
    const role = req.body.role === 'super_admin' ? 'super_admin' : 'admin';
    const access = role === 'super_admin' ? [] : normaliseAccess(req.body);

    if (!name || !loginId || password.length < 6) {
      req.session.flash = { type: 'error', message: 'Naam, login ID aur kam se kam 6 character ka password chahiye.' };
      return res.redirect('/users');
    }
    if (await db.value('SELECT 1 FROM users WHERE LOWER(login_id) = LOWER($1)', [loginId])) {
      req.session.flash = { type: 'error', message: `Login ID "${loginId}" pehle se hai.` };
      return res.redirect('/users');
    }

    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO users (name, login_id, password_hash, role, page_access, daily_target, team)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [name, loginId, hash, role, access, targetOf(req.body.daily_target, 40), teamOf(req.body.team)]
    );
    await auth.audit(req, 'create_user', `${loginId} (${role})`);
    req.session.flash = { type: 'success', message: `User "${loginId}" ban gaya.` };
    res.redirect('/users');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/update', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const target = await db.row('SELECT * FROM users WHERE id = $1', [id]);
    if (!target) {
      req.session.flash = { type: 'error', message: 'User nahi mila.' };
      return res.redirect('/users');
    }

    const name = String(req.body.name || '').trim() || target.name;
    const role = req.body.role === 'super_admin' ? 'super_admin' : 'admin';
    const password = String(req.body.password || '');

    // Ek hi super admin ko demote mat hone do — warna system lock ho jayega.
    if (target.role === 'super_admin' && role !== 'super_admin') {
      const supers = Number(await db.value("SELECT COUNT(*)::int FROM users WHERE role = 'super_admin'"));
      if (supers <= 1) {
        req.session.flash = { type: 'error', message: 'Ye akela Super Admin hai — ise Admin nahi bana sakte.' };
        return res.redirect('/users');
      }
    }

    const access = role === 'super_admin' ? [] : normaliseAccess(req.body);
    await db.query(
      'UPDATE users SET name = $2, role = $3, page_access = $4, daily_target = $5, team = $6 WHERE id = $1',
      [id, name, role, access, targetOf(req.body.daily_target, target.daily_target), teamOf(req.body.team, target.team)]
    );

    if (password) {
      if (password.length < 6) {
        req.session.flash = { type: 'error', message: 'Password kam se kam 6 character ka hona chahiye.' };
        return res.redirect('/users');
      }
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        id,
        await bcrypt.hash(password, 10),
      ]);
      await auth.audit(req, 'reset_password', target.login_id);
    }

    await auth.audit(req, 'update_user', `${target.login_id} → ${role}`);
    req.session.flash = { type: 'success', message: `User "${target.login_id}" update ho gaya.` };
    res.redirect('/users');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/unlock', async (req, res, next) => {
  try {
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [req.params.id]);
    await auth.audit(req, 'unlock_user', `id=${req.params.id}`);
    req.session.flash = { type: 'success', message: 'Account unlock ho gaya.' };
    res.redirect('/users');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.session.user.id) {
      req.session.flash = { type: 'error', message: 'Apna hi account delete nahi kar sakte.' };
      return res.redirect('/users');
    }
    const target = await db.row('SELECT login_id, role FROM users WHERE id = $1', [id]);
    if (target && target.role === 'super_admin') {
      const supers = Number(await db.value("SELECT COUNT(*)::int FROM users WHERE role = 'super_admin'"));
      if (supers <= 1) {
        req.session.flash = { type: 'error', message: 'Aakhri Super Admin delete nahi ho sakta.' };
        return res.redirect('/users');
      }
    }
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    await auth.audit(req, 'delete_user', target ? target.login_id : `id=${id}`);
    req.session.flash = { type: 'success', message: 'User delete ho gaya.' };
    res.redirect('/users');
  } catch (err) {
    next(err);
  }
});

module.exports = router;



