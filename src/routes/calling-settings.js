'use strict';

// Settings → Calling: TeleCMI accounts, webhook address, agent per user.

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const secrets = require('../lib/crypto');
const telecmi = require('../lib/telecmi');

const router = express.Router();
router.use(auth.requireSuperAdmin);

const clean = (v, max) => String(v || '').trim().slice(0, max);
const idOf = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);

function done(req, res, type, message) {
  req.session.flash = { type, message };
  res.redirect('/settings/calling');
}

function webhookUrl(req) {
  const token = telecmi.webhookToken();
  if (!token) return null;
  const origin = (process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${origin}/telecmi/webhook/${token}`;
}

// The addresses TeleCMI has to allow: this server's outgoing public IPs.
const serverIps = () => String(process.env.SERVER_PUBLIC_IP || '').split(/[\s,]+/).filter(Boolean);

// Only the last four characters of a saved secret are ever shown.
function secretEnd(stored) {
  try { return secrets.decrypt(stored).slice(-4); } catch { return null; }
}

// Wraps a handler so a failure shows as a message on this page.
const action = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[calling settings]', err.message);
    done(req, res, 'error', err.code === '23505' ? 'That app ID is already saved.' : err.message);
  }
};

router.get('/', async (req, res, next) => {
  try {
    const accounts = await db.rows(
      `SELECT id, label, app_id, is_active, secret_enc, last_webhook_at::text AS last_webhook_at
         FROM telecmi_accounts ORDER BY id`
    );
    res.render('settings_calling', {
      title: 'Calling',
      page: 'settings',
      encryptionReady: secrets.isConfigured(),
      webhookUrl: webhookUrl(req),
      serverIps: serverIps(),
      accounts: accounts.map(({ secret_enc: stored, ...a }) => ({ ...a, secretEnd: secretEnd(stored) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/accounts', action(async (req, res) => {
  const label = clean(req.body.label, 60);
  const appId = clean(req.body.app_id, 20);
  const secret = clean(req.body.secret, 200);
  if (!label || !/^\d+$/.test(appId) || !secret) {
    return done(req, res, 'error', 'Enter a name, a numeric app ID and the app secret.');
  }
  await db.query(
    `INSERT INTO telecmi_accounts (label, app_id, secret_enc, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$4)`,
    [label, appId, secrets.encrypt(secret), req.session.user.id]
  );
  await auth.audit(req, 'telecmi_account_add', `${label} app=${appId}`);
  done(req, res, 'success', 'TeleCMI account saved.');
}));

router.post('/accounts/:id', action(async (req, res) => {
  const id = idOf(req.params.id);
  const label = clean(req.body.label, 60);
  const secret = clean(req.body.secret, 200);
  if (!label) return done(req, res, 'error', 'The account needs a name.');
  await db.query(
    `UPDATE telecmi_accounts
        SET label = $2, secret_enc = COALESCE($3, secret_enc), is_active = $4, updated_at = NOW(), updated_by = $5
      WHERE id = $1`,
    [id, label, secret ? secrets.encrypt(secret) : null, req.body.is_active === '1', req.session.user.id]
  );
  await auth.audit(req, 'telecmi_account_update', `id=${id}${secret ? ' (secret changed)' : ''}`);
  done(req, res, 'success', 'Account updated.');
}));

router.post('/accounts/:id/test', action(async (req, res) => {
  const a = await db.row('SELECT app_id, secret_enc FROM telecmi_accounts WHERE id = $1', [idOf(req.params.id)]);
  if (!a) return done(req, res, 'error', 'Account not found.');
  const r = await telecmi.checkAccount(a.app_id, secrets.decrypt(a.secret_enc));
  done(req, res, r.ok ? 'success' : 'error', r.message);
}));

router.post('/accounts/:id/delete', action(async (req, res) => {
  const out = await db.query('DELETE FROM telecmi_accounts WHERE id = $1 AND NOT is_active', [idOf(req.params.id)]);
  if (!out.rowCount) return done(req, res, 'error', 'Switch the account off before removing it.');
  await auth.audit(req, 'telecmi_account_delete', `id=${req.params.id}`);
  done(req, res, 'success', 'Account removed.');
}));

module.exports = router;
