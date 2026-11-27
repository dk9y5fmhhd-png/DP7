'use strict';

// Daily Excel upload — spec ke do data types:
//   A. New customer  : username, mobile, registration date
//   B. Deposits      : username, transaction id, deposit date, amount, status
//
// Duplicate transaction ID → reject. Ek username ke kai genuine deposits → allowed.

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const C = require('../lib/customers');
const sheet = require('../lib/sheet');
const D = require('../lib/dates');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xlsm|xls|csv|txt)$/i.test(file.originalname || '')) return cb(null, true);
    cb(new Error('Only .xlsx or .csv files are supported.'));
  },
});

// Har page par caller logins — upload page me hint ke liye
router.use(async (req, res, next) => {
  try {
    const rows = await db.rows(
      `SELECT login_id FROM users WHERE role <> 'super_admin' ORDER BY name`
    );
    res.locals.callerLogins = rows.map((r) => r.login_id).join(', ');
  } catch (e) {
    res.locals.callerLogins = '';
  }
  next();
});

/* ------------------------------ page ------------------------------ */

router.get('/', auth.requirePage('upload'), async (req, res, next) => {
  try {
    const recent = await db.rows(
      `SELECT source, COUNT(*)::int AS rows, MAX(created_at) AS last_at
         FROM deposits GROUP BY source ORDER BY last_at DESC NULLS LAST`
    );
    res.render('upload', {
      title: 'Daily Upload',
      page: 'upload',
      result: null,
      recent,
      perUser: null,
      perUserTotal: null,
      hasDateCol: true,
      today: D.todayISO(),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ templates ------------------------------ */

router.get('/template/:kind', auth.requirePage('upload'), async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (!['customers', 'deposits'].includes(kind)) return res.status(404).end();
    const buf = await sheet.buildTemplate(kind);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="dp7-${kind}-template.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ clear uploaded data ------------------------------ */
// Galat file upload ho jaye (jaise summary ki jagah transaction) to pehle saaf split it:
router.post('/clear', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      req.session.flash = { type: 'error', message: 'Type DELETE in the confirm box — nothing was deleted.' };
      return res.redirect('/upload');
    }

    const scope = req.body.scope === 'all' ? 'all' : 'excel';
    let removed = 0;

    if (scope === 'all') {
      removed = (await db.query('DELETE FROM deposits')).rowCount;
    } else {
      removed = (await db.query("DELETE FROM deposits WHERE source = 'excel'")).rowCount;
    }

    const sync = await C.syncCustomers();
    await auth.audit(req, 'clear_deposits', `scope=${scope} removed=${removed}`);
    req.session.flash = {
      type: 'success',
      message: `${removed} deposit rows deleted — customer master synced again (${sync.total} customers). Now upload the correct file.`,
    };
    res.redirect('/upload');
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ upload ------------------------------ */

router.post('/:kind', auth.requirePage('upload'), (req, res, next) => {
  const kind = req.params.kind;
  if (!['customers', 'deposits'].includes(kind)) return res.status(404).end();

  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      req.session.flash = { type: 'error', message: uploadErr.message };
      return res.redirect('/upload');
    }
    try {
      if (!auth.verifyCsrf(req)) return auth.rejectCsrf(res);
      if (!req.file) {
        req.session.flash = { type: 'error', message: 'Choose a file.' };
        return res.redirect('/upload');
      }

      const dryRun = req.body.dry === '1';
      const fallbackDate = D.isDate(req.body.play_date) ? req.body.play_date : D.todayISO();

      // File ka hash — wahi file dobara upload ho to poora block
      const batch = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 40);
      const batchInfo = await db.row(
        `SELECT COUNT(*)::int AS rows, MIN(created_at) AS first_at
           FROM deposits WHERE batch = $1`,
        [batch]
      );

      const opts = kind === 'customers'
        ? { required: ['username'], positional: ['username', 'mobile', 'date', 'caller'] }
        : { required: ['username', 'qty'], positional: ['username', 'txn_id', 'date', 'qty', 'status'] };

      if (kind === 'deposits' && !dryRun && batchInfo && batchInfo.rows > 0) {
        return res.status(409).render('upload', {
          title: 'Daily Upload', page: 'upload', today: D.todayISO(),
          recent: await db.rows(
            `SELECT source, COUNT(*)::int AS rows, MAX(created_at) AS last_at
               FROM deposits GROUP BY source ORDER BY last_at DESC NULLS LAST`
          ),
          perUser: null,
          perUserTotal: null,
          hasDateCol: true,
          result: {
            kind, dryRun: false, blocked: true,
            fileName: req.file.originalname,
            batchRows: batchInfo.rows,
            errors: [], preview: [], count: 0, inserted: 0, skipped: 0,
          },
        });
      }

      const parsed = await sheet.parseSheet(req.file.buffer, req.file.originalname, opts);
      const errors = [];

      // Date column na ho to saaf batao (ye error nahi, warning hai)
      const hasDateCol = Boolean(parsed.headerMap && parsed.headerMap.date !== undefined);
      errors.push(...parsed.errors);
      const preview = [];

      let inserted = 0;
      let skipped = 0;
      let autoAssigned = 0;
      let badCaller = 0;

      if (kind === 'customers') {
        // caller column optional — login_id ya naam se match
        const userRows = await db.rows('SELECT id, name, login_id FROM users WHERE role <> \'super_admin\'');
        const byCaller = new Map();
        for (const u of userRows) {
          byCaller.set(String(u.login_id).toLowerCase(), u);
          byCaller.set(String(u.name).toLowerCase(), u);
        }
        for (const rec of parsed.rows) {
          const username = String(rec.username || rec.item || rec.worker || '').trim();
          if (!username) {
            errors.push({ line: rec.line, text: '', reason: 'Username is empty' });
            continue;
          }
          let mobile = String(rec.mobile || rec.meters || '').replace(/[^\d]/g, '');
          // masked number (+919****0880) ya adhoora number store na karo
          if (mobile.length < 10) mobile = '';
          const regDate = rec.date || null;
          const callerRaw = String(rec.caller || '').trim();
          const callerUser = callerRaw ? byCaller.get(callerRaw.toLowerCase()) : null;
          if (callerRaw && !callerUser) badCaller++;

          preview.push({
            line: rec.line, username, mobile,
            date: regDate || '—',
            caller: callerUser ? callerUser.name : (callerRaw || ''),
            note: mobile ? '' : 'mobile missing',
          });

          if (!dryRun) {
            // customer master me upsert — deposit ka hisaab sync karega
            const existing = await db.row(
              `SELECT id, assigned_to, status FROM customers WHERE LOWER(username) = LOWER($1)`,
              [username]
            );
            if (existing) {
              // purana customer — sirf mobile/date/caller update, deposit data nahi chhedte
              await db.query(
                `UPDATE customers
                    SET mobile = COALESCE(NULLIF($2,''), mobile),
                        reg_date = COALESCE($3, reg_date),
                        created_by = COALESCE($4, created_by),
                        assigned_to = CASE
                          WHEN assigned_to IS NULL AND $4::int IS NOT NULL THEN $4
                          ELSE assigned_to END
                  WHERE id = $1`,
                [existing.id, mobile, regDate, callerUser ? callerUser.id : null]
              );
              skipped++;
            } else {
              await db.query(
                `INSERT INTO customers
                   (username, mobile, reg_date, status, created_by, assigned_to, reg_source)
                 VALUES ($1,$2,COALESCE($3, CURRENT_DATE),'no_deposit',$4,$4,'upload')`,
                [username, mobile, regDate, callerUser ? callerUser.id : null]
              );
              if (callerUser) autoAssigned++;
              inserted++;
            }
          }
        }
      } else {
        // deposits
        for (const rec of parsed.rows) {
          const username = String(rec.username || '').trim();
          const qty = Number(rec.qty);
          const txn = String(rec.txn_id || '').trim();
          const status = normaliseStatus(rec.status);
          const date = rec.date || fallbackDate;
          // summary file me ek row me kai deposits ho sakti hain
          const txnCount = Number.isFinite(Number(rec.count)) && Number(rec.count) >= 1
            ? Math.round(Number(rec.count)) : 1;

          if (!username) {
            errors.push({ line: rec.line, text: '', reason: 'Username is empty' });
            continue;
          }
          if (!Number.isFinite(qty) || qty < 0) {
            errors.push({ line: rec.line, text: `amount=${rec.qty}`, reason: 'Amount is wrong' });
            continue;
          }

          preview.push({
            line: rec.line, username, mobile: '',
            date, amount: qty, txn, status, count: txnCount,
          });

          if (dryRun) {
            if (txn) {
              const dup = await db.value('SELECT 1 FROM deposits WHERE LOWER(txn_id) = LOWER($1)', [txn]);
              if (dup) errors.push({ line: rec.line, text: txn, reason: 'Duplicate transaction ID — reject' });
            }
            continue;
          }

          if (txn) {
            const dup = await db.value('SELECT 1 FROM deposits WHERE LOWER(txn_id) = LOWER($1)', [txn]);
            if (dup) {
              skipped++;
              errors.push({ line: rec.line, text: txn, reason: 'Duplicate transaction ID — reject' });
              continue;
            }
          }

          // Har row ek alag deposit hai. Same amount dobara aaye to bhi rakho —
          // warna 25,000 char baar karne wale ka count 1 ho jaata hai.
          // Duplicate ka pehchan sirf transaction ID aur file-hash se hota hai.
          try {
            await db.query(
              `INSERT INTO deposits (play_date, username, mobile, amount, txn_id, status, txn_count, batch, source, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'excel',$9)`,
              [date, username, '', qty, txn || null, status, txnCount, batch, req.session.user.id]
            );
            inserted++;
          } catch (err) {
            errors.push({ line: rec.line, text: `${username} ${date}`, reason: err.message.slice(0, 80) });
          }
        }
      }

      // upload ke baad customer master sync
      let sync = null;
      if (!dryRun) {
        sync = await C.syncCustomers();
        await auth.audit(req, 'upload_' + kind,
          `file=${req.file.originalname} inserted=${inserted} skipped=${skipped} errors=${errors.length}`);
      }

      if (!preview.length) {
        return res.status(400).render('upload', {
          title: 'Daily Upload', page: 'upload', today: D.todayISO(),
          perUser: null, perUserTotal: null, hasDateCol,
          recent: [],
          result: { kind, dryRun, empty: true, fileName: req.file.originalname, sheet: parsed.sheet, headerMap: parsed.headerMap, errors, preview },
        });
      }

      // Kis customer ke kitni rows aur kitna total — turant dikhe
      const perUserMap = new Map();
      for (const r of parsed.rows) {
        const k = r.username.toLowerCase();
        const cur = perUserMap.get(k) || { username: r.username, rows: 0, amount: 0 };
        cur.rows += 1;
        cur.amount += Number(r.qty) || 0;
        perUserMap.set(k, cur);
      }
      const perUser = [...perUserMap.values()].sort((a, b) => b.rows - a.rows).slice(0, 25);
      const perUserTotal = {
        users: perUserMap.size,
        rows: parsed.rows.length,
        amount: [...perUserMap.values()].reduce((a, b) => a + b.amount, 0),
      };

      res.render('upload', {
        title: 'Daily Upload',
        page: 'upload',
        today: D.todayISO(),
        recent: await db.rows(
          `SELECT source, COUNT(*)::int AS rows, MAX(created_at) AS last_at
             FROM deposits GROUP BY source ORDER BY last_at DESC NULLS LAST`
        ),
        perUser, perUserTotal, hasDateCol,
        result: {
          kind, dryRun,
          playDate: fallbackDate,
          fileName: req.file.originalname,
          sheet: parsed.sheet,
          headerMap: parsed.headerMap,
          preview, errors, inserted, skipped, sync,
          autoAssigned, badCaller,
          count: preview.length,
        },
      });
    } catch (err) {
      req.session.flash = {
        type: 'error',
        message: /xlsx|zip|corrupt|End of data|Invalid/i.test(err.message || '')
          ? 'Could not read the file. In Excel use "Save As → .xlsx" and send it again.'
          : err.message,
      };
      res.redirect('/upload');
    }
  });
});

function normaliseStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'successful';
  if (['success', 'successful', 'ok', 'done', 'complete', 'completed', 'paid'].includes(s)) return 'successful';
  if (['failed', 'fail', 'error', 'declined'].includes(s)) return 'failed';
  if (['pending', 'processing', 'hold'].includes(s)) return 'pending';
  if (['reversed', 'refund', 'refunded', 'cancelled', 'canceled'].includes(s)) return 'reversed';
  return 'successful';
}

module.exports = router;





