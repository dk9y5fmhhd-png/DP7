'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../auth');
const secrets = require('../lib/crypto');
const telecmi = require('../lib/telecmi');

const router = express.Router();

const GRANTABLE = auth.PAGES.filter((p) => !p.superOnly && p.key !== 'security');

// Daily call target — 0 se 500. 0 = koi limit nahi.
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
    `SELECT id, name, login_id, role, page_access, daily_target, nodep_target, dep_target, team, totp_enabled, failed_attempts,
            locked_until, last_login_at, created_at,
            telecmi_agent_id, telecmi_password_enc IS NOT NULL AS has_telecmi_password
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
      telecmiAccounts: await db.rows('SELECT app_id, label, is_active FROM telecmi_accounts ORDER BY id'),
      encryptionReady: secrets.isConfigured(),
      flash: req.session.flash || null,
    });
    delete req.session.flash;
  } catch (err) {
    next(err);
  }
});

// Reads the TeleCMI fields of a user form; null when the form has none.
function agentFields(body) {
  if (body.telecmi_agent_id === undefined) return null;
  const agentId = String(body.telecmi_agent_id).replace(/\s/g, '').slice(0, 40);
  const password = String(body.telecmi_password || '').slice(0, 200);
  const error = !telecmi.validAgentId(agentId) ? 'An agent ID looks like 5001_1111112 (digits, then the app ID).'
    : password && !secrets.isConfigured() ? 'CREDENTIALS_ENCRYPTION_KEY is missing or shorter than 32 characters.' : null;
  return { agentId, password, error };
}

// The "Test login" button: uses what is typed, falling back to what is saved.
router.post('/telecmi-test', async (req, res, next) => {
  try {
    const id = /^\d{1,9}$/.test(String(req.body.user_id)) ? Number(req.body.user_id) : 0;
    const saved = id ? await db.row('SELECT telecmi_agent_id, telecmi_password_enc FROM users WHERE id = $1', [id]) : null;
    const agentId = String(req.body.telecmi_agent_id || '').trim() || saved?.telecmi_agent_id || '';
    let password = String(req.body.telecmi_password || '');
    // The saved password belongs to the saved ID only.
    if (!password && saved?.telecmi_password_enc && agentId === saved.telecmi_agent_id) {
      password = secrets.decrypt(saved.telecmi_password_enc);
    }
    const r = agentId && password
      ? await telecmi.checkLogin(agentId, password)
      : { ok: false, message: 'Enter the agent ID and password to test.' };
    res.json({ ok: r.ok, message: res.locals._tm(r.message) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/telecmi', async (req, res, next) => {
  try {
    const id = Number(req.params.id) || 0;
    const agent = agentFields(req.body);
    if (!agent || agent.error) {
      req.session.flash = { type: 'error', message: agent?.error || 'User not found.' };
      return res.redirect('/users');
    }
    await telecmi.saveAgent(id, agent.agentId, agent.password);
    await auth.audit(req, 'telecmi_agent', `user=${id} agent=${agent.agentId || 'none'}`);
    req.session.flash = { type: 'success', message: 'TeleCMI ID saved.' };
    res.redirect('/users');
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
      req.session.flash = { type: 'error', message: 'Enter a name, a login ID and a password of at least 6 characters.' };
      return res.redirect('/users');
    }
    if (await db.value('SELECT 1 FROM users WHERE LOWER(login_id) = LOWER($1)', [loginId])) {
      req.session.flash = { type: 'error', message: `Login ID "${loginId}" already exists.` };
      return res.redirect('/users');
    }

    const agent = agentFields(req.body);
    if (agent?.error) {
      req.session.flash = { type: 'error', message: agent.error };
      return res.redirect('/users');
    }

    const hash = await bcrypt.hash(password, 10);
    const created = await db.row(
      `INSERT INTO users (name, login_id, password_hash, role, page_access,
                          nodep_target, dep_target, daily_target, team)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [name, loginId, hash, role, access,
        targetOf(req.body.nodep_target, 40), targetOf(req.body.dep_target, 35),
        targetOf(req.body.nodep_target, 40) + targetOf(req.body.dep_target, 35),
        teamOf(req.body.team)]
    );
    if (agent?.agentId) await telecmi.saveAgent(created.id, agent.agentId, agent.password);
    await auth.audit(req, 'create_user', `${loginId} (${role})`);
    req.session.flash = { type: 'success', message: `User "${loginId}" created.` };
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
      req.session.flash = { type: 'error', message: 'User not found.' };
      return res.redirect('/users');
    }

    const name = String(req.body.name || '').trim() || target.name;
    const role = req.body.role === 'super_admin' ? 'super_admin' : 'admin';
    const password = String(req.body.password || '');

    // Ek hi super admin ko demote mat hone do — warna system lock ho jayega.
    if (target.role === 'super_admin' && role !== 'super_admin') {
      const supers = Number(await db.value("SELECT COUNT(*)::int FROM users WHERE role = 'super_admin'"));
      if (supers <= 1) {
        req.session.flash = { type: 'error', message: 'This is the only Super Admin — it cannot be made an Admin.' };
        return res.redirect('/users');
      }
    }

    const access = role === 'super_admin' ? [] : normaliseAccess(req.body);
    const agent = agentFields(req.body);
    if (agent?.error) {
      req.session.flash = { type: 'error', message: agent.error };
      return res.redirect('/users');
    }
    if (agent) await telecmi.saveAgent(id, agent.agentId, agent.password);
    await db.query(
      `UPDATE users SET name = $2, role = $3, page_access = $4,
                        nodep_target = $5, dep_target = $6, daily_target = $7, team = $8
        WHERE id = $1`,
      [id, name, role, access,
        targetOf(req.body.nodep_target, target.nodep_target ?? 40),
        targetOf(req.body.dep_target, target.dep_target ?? 35),
        targetOf(req.body.nodep_target, target.nodep_target ?? 40)
          + targetOf(req.body.dep_target, target.dep_target ?? 35),
        teamOf(req.body.team, target.team)]
    );

    if (password) {
      if (password.length < 6) {
        req.session.flash = { type: 'error', message: 'The password needs at least 6 characters.' };
        return res.redirect('/users');
      }
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        id,
        await bcrypt.hash(password, 10),
      ]);
      await auth.audit(req, 'reset_password', target.login_id);
    }

    await auth.audit(req, 'update_user', `${target.login_id} → ${role}`);
    req.session.flash = { type: 'success', message: `User "${target.login_id}" updated.` };
    res.redirect('/users');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/unlock', async (req, res, next) => {
  try {
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [req.params.id]);
    await auth.audit(req, 'unlock_user', `id=${req.params.id}`);
    req.session.flash = { type: 'success', message: 'Account unlocked.' };
    res.redirect('/users');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.session.user.id) {
      req.session.flash = { type: 'error', message: 'You cannot delete your own account.' };
      return res.redirect('/users');
    }
    const target = await db.row('SELECT login_id, role FROM users WHERE id = $1', [id]);
    if (target && target.role === 'super_admin') {
      const supers = Number(await db.value("SELECT COUNT(*)::int FROM users WHERE role = 'super_admin'"));
      if (supers <= 1) {
        req.session.flash = { type: 'error', message: 'The last Super Admin cannot be deleted.' };
        return res.redirect('/users');
      }
    }
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    await auth.audit(req, 'delete_user', target ? target.login_id : `id=${id}`);
    req.session.flash = { type: 'success', message: 'User deleted.' };
    res.redirect('/users');
  } catch (err) {
    next(err);
  }
});

module.exports = router;



