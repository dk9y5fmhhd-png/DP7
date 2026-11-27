'use strict';

// Assignment — do raaste ek jagah:
//   1. Queue: jo naye client aaye aur kisi ko assign nahi hue (aaj/kal/is hafte)
//   2. Excel: username + caller ki file upload

const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const A = require('../lib/assign');
const D = require('../lib/dates');
const sheet = require('../lib/sheet');

const router = express.Router();

router.use(auth.requireSuperAdmin);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xlsm|xls|csv|txt)$/i.test(file.originalname || '')) return cb(null, true);
    cb(new Error('Only .xlsx or .csv files are supported.'));
  },
});

async function callerList() {
  return db.rows(
    `SELECT u.id, u.name, u.login_id, u.team, u.daily_target,
            (SELECT COUNT(*)::int FROM customers c
              WHERE c.assigned_to = u.id AND c.do_not_contact = FALSE) AS assigned
       FROM users u
      WHERE u.role <> 'super_admin'
      ORDER BY u.team, u.name`
  );
}

/* ------------------------------------------------------------------ *
 * 1. Dashboard — queue + Excel, ek page par
 * ------------------------------------------------------------------ */

router.get('/', async (req, res, next) => {
  try {
    const today = D.todayISO();
    const days = [1, 3, 7, 15, 30, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 7;

    const callers = await callerList();

    // Naye client — pehla deposit `days` days andar, aur unassigned
    const from = D.addDays(today, -(days - 1));
    const fresh = await db.rows(
      `SELECT b.id, b.username, b.mobile, b.first_deposit::text AS first_deposit,
              b.deposit_count, b.deposit_amount, b.status, b.vip_category,
              b.priority, b.cadence_tier
         FROM customer_board b
        WHERE b.assigned_to IS NULL
          AND b.do_not_contact = FALSE
          AND b.first_deposit >= $1::date
        ORDER BY b.first_deposit DESC, b.deposit_amount DESC, b.username
        LIMIT 500`,
      [from]
    );

    // Din-wise count — kaunsa din kitne naye aaye
    const byDay = await db.rows(
      `SELECT first_deposit::text AS day, COUNT(*)::int AS c
         FROM customer_board
        WHERE assigned_to IS NULL AND do_not_contact = FALSE
          AND first_deposit >= $1::date
        GROUP BY first_deposit ORDER BY first_deposit DESC`,
      [from]
    );

    // Babu bhai — kya kuch bina-assign pada hai purana bhi
    const totals = await db.row(
      `SELECT COUNT(*) FILTER (WHERE assigned_to IS NULL AND do_not_contact = FALSE)::int AS unassigned,
              COUNT(*) FILTER (WHERE assigned_to IS NULL AND do_not_contact = FALSE
                                 AND first_deposit >= $1::date)::int AS fresh,
              COUNT(*) FILTER (WHERE assigned_to IS NULL AND do_not_contact = FALSE
                                 AND first_deposit < $1::date)::int AS older,
              COUNT(*) FILTER (WHERE do_not_contact = TRUE)::int AS dnc
         FROM customer_board`,
      [from]
    );

    const history = await db.rows(
      `SELECT ai.*, u.name AS by_name FROM assign_imports ai
         LEFT JOIN users u ON u.id = ai.uploaded_by
        ORDER BY ai.uploaded_at DESC LIMIT 8`
    );

    res.render('assign', {
      title: 'Assignment',
      page: 'assign',
      callers, fresh, byDay, totals, history, days, today,
      from,
      preview: req.session.assignPreview || null,
    });
    delete req.session.assignPreview;
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * 2. Queue se manual assign — tick karke ya poora batch
 * ------------------------------------------------------------------ */

router.post('/manual', async (req, res, next) => {
  try {
    const back = req.get('referer') || '/assign';
    const unassign = req.body.unassign === '1';
    const callerId = Number(req.body.caller_id) || null;
    const usernames = [].concat(req.body.username || []).filter(Boolean);

    if (!unassign && !callerId) {
      req.session.flash = { type: 'error', message: 'Choose a caller first.' };
      return res.redirect(back);
    }
    if (!usernames.length) {
      req.session.flash = { type: 'error', message: 'Tick the customers first.' };
      return res.redirect(back);
    }

    const out = await db.query(
      `UPDATE customers SET assigned_to = $1 WHERE LOWER(username) = ANY($2::text[])`,
      [unassign ? null : callerId, usernames.map((u) => String(u).toLowerCase())]
    );
    await auth.audit(req, unassign ? 'assign_clear' : 'assign_manual',
      `rows=${out.rowCount} caller=${unassign ? 'none' : callerId}`);

    if (out.rowCount) await require('../lib/cadence').refreshAll().catch(() => null);

    req.session.flash = {
      type: 'success',
      message: unassign
        ? `${out.rowCount} customers no longer have a caller.`
        : `${out.rowCount} customers assigned.`,
    };
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// Poora queue ek caller ko — jitne abhi filter me hain
router.post('/all-fresh', async (req, res, next) => {
  try {
    const back = req.get('referer') || '/assign';
    const callerId = Number(req.body.caller_id) || null;
    const days = Number(req.body.days) || 7;

    if (!callerId) {
      req.session.flash = { type: 'error', message: 'Choose a caller first.' };
      return res.redirect(back);
    }

    const from = D.addDays(D.todayISO(), -(days - 1));
    const out = await db.query(
      `UPDATE customers SET assigned_to = $1
        WHERE assigned_to IS NULL AND do_not_contact = FALSE
          AND first_deposit >= $2::date`,
      [callerId, from]
    );
    await auth.audit(req, 'assign_fresh_all', `rows=${out.rowCount} caller=${callerId} days=${days}`);
    if (out.rowCount) await require('../lib/cadence').refreshAll().catch(() => null);

    req.session.flash = {
      type: 'success',
      message: `${out.rowCount} new clients assigned.`,
    };
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * 3. Excel — template, import, preview, apply
 * ------------------------------------------------------------------ */

router.get('/template', async (req, res, next) => {
  try {
    const buf = await A.buildTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="dp7-assign-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    next(err);
  }
});

router.get('/export', async (req, res, next) => {
  try {
    const unassignedOnly = req.query.only === 'unassigned';
    const { buffer, count } = await A.buildExport({ unassignedOnly });
    await auth.audit(req, 'assign_export', `only=${unassignedOnly ? 'unassigned' : 'all'} rows=${count}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="dp7-assignment-${unassignedOnly ? 'unassigned-' : ''}${D.todayISO()}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!auth.verifyCsrf(req)) return auth.rejectCsrf(res);
    if (!req.file) {
      req.session.flash = { type: 'error', message: 'Choose a file.' };
      return res.redirect('/assign');
    }

    const { matrix, sheet: sheetName } = await sheet.readMatrix(req.file.buffer, req.file.originalname);

    const parsed = await A.parse(matrix);

    if (!parsed.rows.length && !parsed.errors.length) {
      req.session.flash = { type: 'error', message: 'No row found in the file.' };
      return res.redirect('/assign');
    }

    // Preview session me — apply wahi lagega (file dobara upload nahi karni)
    req.session.assignPreview = {
      fileName: req.file.originalname,
      sheet: sheetName,
      at: Date.now(),
      rows: parsed.rows,
      stats: parsed.stats,
      columns: parsed.columns,
      errors: parsed.errors.slice(0, 60),
      errorTotal: parsed.errors.length,
      perCaller: [...parsed.callers.values()],
    };

    res.redirect('/assign#preview');
  } catch (err) {
    req.session.flash = {
      type: 'error',
      message: /xlsx|zip|corrupt|End of data|Invalid/i.test(err.message || '')
        ? 'Could not read the file. In Excel use "Save As → .xlsx" and send it again.'
        : err.message,
    };
    res.redirect('/assign');
  }
});

router.post('/apply', async (req, res, next) => {
  try {
    const prev = req.session.assignPreview;
    if (!prev || Date.now() - prev.at > 30 * 60 * 1000) {
      req.session.flash = { type: 'error', message: 'The preview expired. Upload the file again.' };
      return res.redirect('/assign');
    }

    const { applied } = await A.apply(prev.rows, {
      fileName: prev.fileName,
      uploadedBy: req.session.user.id,
      total: prev.stats.total,
      unmatched: prev.stats.unmatched,
      badCaller: prev.stats.badCaller,
      perCaller: Object.fromEntries(prev.perCaller.map((p) => [p.login_id, p.count])),
    });

    await require('../lib/cadence').refreshAll().catch(() => null);
    await auth.audit(req, 'assign_apply', `${applied} rows from ${prev.fileName}`);
    delete req.session.assignPreview;

    req.session.flash = {
      type: 'success',
      message: `${applied} customers assigned (${prev.fileName}).`,
    };
    res.redirect('/assign');
  } catch (err) {
    next(err);
  }
});

router.post('/cancel', async (req, res) => {
  delete req.session.assignPreview;
  res.redirect('/assign');
});

module.exports = router;

