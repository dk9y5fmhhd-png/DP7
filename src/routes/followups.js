'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const D = require('../lib/dates');
const { ACTION_TYPES } = require('../lib/actions');

const router = express.Router();

const PER_PAGE = 100;

router.get('/', auth.requirePage('followups'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const action = String(req.query.action || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const params = [];
    const conds = ['TRUE'];
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(f.username) LIKE $${params.length} OR LOWER(COALESCE(f.response,'')) LIKE $${params.length})`);
    }
    if (action) {
      params.push(action);
      conds.push(`f.action_type = $${params.length}`);
    }
    const where = conds.join(' AND ');

    const total = Number(await db.value(`SELECT COUNT(*)::int FROM followups f WHERE ${where}`, params));
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const safe = Math.min(page, pages);

    const rows = await db.rows(
      `SELECT f.id, f.username, f.action_type, f.action_date::text AS action_date, f.response,
              f.created_at, u.name AS by_name
         FROM followups f LEFT JOIN users u ON u.id = f.created_by
        WHERE ${where}
        ORDER BY f.action_date DESC, f.id DESC
        LIMIT ${PER_PAGE} OFFSET ${(safe - 1) * PER_PAGE}`,
      params
    );

    const byType = await db.rows(
      `SELECT action_type, COUNT(*)::int AS c FROM followups GROUP BY action_type ORDER BY c DESC`
    );

    res.render('followups', {
      title: 'Follow-ups',
      page: 'followups',
      rows,
      total,
      page: safe,
      pages,
      q,
      action,
      byType,
      actionTypes: ACTION_TYPES,
      today: D.todayISO(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', auth.requireLogin, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const actionType = String(req.body.action_type || '').trim();
    const actionDate = D.isDate(req.body.action_date) ? req.body.action_date : D.todayISO();
    const response = String(req.body.response || '').trim().slice(0, 2000);

    if (!username || !ACTION_TYPES.includes(actionType)) {
      req.session.flash = { type: 'error', message: 'Username ya action type galat hai.' };
      return res.redirect(req.get('referer') || '/reports');
    }

    const R = require('../lib/remarks');
    const info = R.info(actionType);
    // follow-up date: caller ne di ho → wahi, warna remark ka default gap
    let followUpOn = null;
    if (req.body.follow_up_on && D.isDate(req.body.follow_up_on)) {
      followUpOn = req.body.follow_up_on;
    } else if (req.body.follow_gap !== undefined && req.body.follow_gap !== '') {
      const gap = Number(req.body.follow_gap);
      followUpOn = D.addDays(actionDate, Number.isFinite(gap) ? gap : info.days);
    } else {
      followUpOn = D.addDays(actionDate, info.days);
    }
    if (R.SUPPRESS.has(actionType)) followUpOn = null;

    await db.query(
      `INSERT INTO followups
         (username, action_type, action_date, response, next_action, follow_up_on, caller_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [username, actionType, actionDate, response, info.next, followUpOn, req.session.user.id]
    );
    if (R.SUPPRESS.has(actionType)) {
      await db.query('UPDATE customers SET do_not_contact = TRUE WHERE LOWER(username) = LOWER($1)', [username]);
    }
    await require('../lib/cadence').refreshOne(username).catch(() => null);
    await auth.audit(req, 'add_followup', `${username} → ${actionType}`);
    req.session.flash = {
      type: 'success',
      message: followUpOn
        ? `${username} ka remark save — agla follow-up ${D.prettyDate(followUpOn)}.`
        : `${username} ka remark save (koi follow-up nahi).`,
    };
    res.redirect(req.get('referer') || '/followups');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    const out = await db.query('DELETE FROM followups WHERE id = $1', [req.params.id]);
    await auth.audit(req, 'delete_followup', `id=${req.params.id} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: 'Follow-up delete ho gaya.' };
    res.redirect(req.get('referer') || '/followups');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.ACTION_TYPES = ACTION_TYPES;


