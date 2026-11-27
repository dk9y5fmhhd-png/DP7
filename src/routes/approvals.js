'use strict';

// Login Approvals — Super Admin dekhta hai kaun login karne ki koshish kar raha hai
// aur ek click me allow/reject karta hai.

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const D = require('../lib/dates');

const router = express.Router();

router.use(auth.requireSuperAdmin);

async function pending() {
  return db.rows(
    `SELECT lr.*,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - lr.requested_at)) / 60)::int AS age_min,
            u.totp_enabled
       FROM login_requests lr
       JOIN users u ON u.id = lr.user_id
      WHERE lr.status = 'pending'
      ORDER BY lr.requested_at ASC`
  );
}

async function recent() {
  return db.rows(
    `SELECT lr.*,
            d.name AS decided_by_name,
            FLOOR(EXTRACT(EPOCH FROM (lr.decided_at - lr.requested_at)))::int AS wait_sec
       FROM login_requests lr
       LEFT JOIN users d ON d.id = lr.decided_by
      WHERE lr.status <> 'pending'
      ORDER BY COALESCE(lr.decided_at, lr.requested_at) DESC
      LIMIT 40`
  );
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await pending();
    const history = await recent();

    const stats = await db.row(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
         COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
         COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
         COUNT(*) FILTER (WHERE status = 'expired')::int  AS expired
       FROM login_requests`
    );

    const usersOff = await db.rows(
      `SELECT id, name, login_id FROM users
        WHERE require_approval = FALSE AND role <> 'super_admin'
        ORDER BY name`
    );

    res.render('approvals', {
      title: 'Login Approvals',
      page: 'approvals',
      rows, history, stats, usersOff,
      ttl: 5,
      today: D.todayISO(),
    });
  } catch (err) {
    next(err);
  }
});

// JSON — badge ke liye (page har 3 second me poochhta hai)
router.get('/pending.json', async (req, res, next) => {
  try {
    const rows = await pending();
    res.json({ count: rows.length, id: rows[0] ? Number(rows[0].id) : null });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    const out = await db.query(
      `UPDATE login_requests
          SET status = 'approved', decided_at = NOW(), decided_by = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING login_id`,
      [req.params.id, req.session.user.id]
    );
    await auth.audit(req, 'login_approve', `request=${req.params.id} rows=${out.rowCount}`);
    req.session.flash = {
      type: out.rowCount ? 'success' : 'error',
      message: out.rowCount
        ? `Login permitted for ${out.rows[0].login_id}.`
        : 'This request was already decided or has expired.',
    };
    res.redirect('/approvals');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const out = await db.query(
      `UPDATE login_requests
          SET status = 'rejected', decided_at = NOW(), decided_by = $2, note = $3
        WHERE id = $1 AND status = 'pending'
        RETURNING login_id`,
      [req.params.id, req.session.user.id, String(req.body.reason || '').slice(0, 200)]
    );
    await auth.audit(req, 'login_reject', `request=${req.params.id} rows=${out.rowCount}`);
    req.session.flash = {
      type: out.rowCount ? 'success' : 'error',
      message: out.rowCount
        ? `Login rejected for ${out.rows[0].login_id}.`
        : 'This request was already decided.',
    };
    res.redirect('/approvals');
  } catch (err) {
    next(err);
  }
});

// Sab pending ek saath
router.post('/approve-all', async (req, res, next) => {
  try {
    const out = await db.query(
      `UPDATE login_requests
          SET status = 'approved', decided_at = NOW(), decided_by = $1
        WHERE status = 'pending'`,
      [req.session.user.id]
    );
    await auth.audit(req, 'login_approve_all', `rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: `${out.rowCount} requests approved.` };
    res.redirect('/approvals');
  } catch (err) {
    next(err);
  }
});

// Kisi user ke liye approval hamesha band (trusted account)
router.post('/user/:id/toggle', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const target = await db.row('SELECT id, login_id, role, require_approval FROM users WHERE id = $1', [id]);
    if (!target) {
      req.session.flash = { type: 'error', message: 'User not found.' };
      return res.redirect('/approvals');
    }
    if (target.role === 'super_admin') {
      req.session.flash = { type: 'error', message: 'Approval is always off for the Super Admin.' };
      return res.redirect('/approvals');
    }
    await db.query('UPDATE users SET require_approval = NOT require_approval WHERE id = $1', [id]);
    await auth.audit(req, 'approval_toggle', `${target.login_id} → ${!target.require_approval}`);
    req.session.flash = {
      type: 'success',
      message: target.require_approval
        ? `${target.login_id} can now log in without approval.`
        : `${target.login_id} now needs approval on every login.`,
    };
    res.redirect('/approvals');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

