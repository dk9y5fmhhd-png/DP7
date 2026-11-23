'use strict';

// Daily Excel upload — spec ke do data types:
//   A. New customer  : username, mobile, registration date
//   B. Deposits      : username, transaction id, deposit date, amount, status
//
// Duplicate transaction ID → reject. Ek username ke kai genuine deposits → allowed.

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
    cb(new Error('Sirf .xlsx ya .csv file chalti hai.'));
  },
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
// Galat file upload ho jaye (jaise summary ki jagah transaction) to pehle saaf karein.
router.post('/clear', auth.requireSuperAdmin, async (req, res, next) => {
  try {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      req.session.flash = { type: 'error', message: 'Confirm box me DELETE likhein — kuch delete nahi hua.' };
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
      message: `${removed} deposit rows delete — customer master dobara sync (${sync.total} customers). Ab sahi file upload karein.`,
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
        req.session.flash = { type: 'error', message: 'File chunein.' };
        return res.redirect('/upload');
      }

      const dryRun = req.body.dry === '1';
      const fallbackDate = D.isDate(req.body.play_date) ? req.body.play_date : D.todayISO();

      const opts = kind === 'customers'
        ? { required: ['username'], positional: ['username', 'mobile', 'date'] }
        : { required: ['username', 'qty'], positional: ['username', 'txn_id', 'date', 'qty', 'status'] };

      const parsed = await sheet.parseSheet(req.file.buffer, req.file.originalname, opts);
      const errors = [...parsed.errors];
      const preview = [];

      let inserted = 0;
      let skipped = 0;

      if (kind === 'customers') {
        for (const rec of parsed.rows) {
          const username = String(rec.username || rec.item || rec.worker || '').trim();
          if (!username) {
            errors.push({ line: rec.line, text: '', reason: 'Username khaali' });
            continue;
          }
          const mobile = String(rec.mobile || rec.meters || '').replace(/[^\d]/g, '');
          const regDate = rec.date || null;

          preview.push({
            line: rec.line, username, mobile,
            date: regDate || '—',
            note: mobile ? '' : 'mobile missing',
          });

          if (!dryRun) {
            // customer master me upsert — deposit ka hisaab sync karega
            const existing = await db.row('SELECT id FROM customers WHERE LOWER(username) = LOWER($1)', [username]);
            if (existing) {
              if (mobile) {
                await db.query('UPDATE customers SET mobile = $2, reg_date = COALESCE($3, reg_date) WHERE id = $1',
                  [existing.id, mobile, regDate]);
              } else if (regDate) {
                await db.query('UPDATE customers SET reg_date = COALESCE($3, reg_date) WHERE id = $1', [existing.id, mobile, regDate]);
              }
              skipped++;
            } else {
              await db.query(
                `INSERT INTO customers (username, mobile, reg_date, status)
                 VALUES ($1,$2,$3,'no_deposit')`,
                [username, mobile, regDate]
              );
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
            errors.push({ line: rec.line, text: '', reason: 'Username khaali' });
            continue;
          }
          if (!Number.isFinite(qty) || qty < 0) {
            errors.push({ line: rec.line, text: `amount=${rec.qty}`, reason: 'Amount galat' });
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

          // Har row ek alag transaction hai — usi din do deposit aaye to dono save honge.
          if (!txn) {
            // txn ID nahi hai to same entry dobara upload hone par skip karo
            const same = await db.value(
              `SELECT 1 FROM deposits
                WHERE LOWER(username) = LOWER($1) AND play_date = $2 AND amount = $3
                  AND status = $4 AND txn_count = $5 AND txn_id IS NULL
                LIMIT 1`,
              [username, date, qty, status, txnCount]
            );
            if (same) {
              skipped++;
              errors.push({ line: rec.line, text: `${username} ${date}`, reason: 'Ye entry pehle se hai (skip)' });
              continue;
            }
          }

          try {
            await db.query(
              `INSERT INTO deposits (play_date, username, mobile, amount, txn_id, status, txn_count, source, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'excel',$8)`,
              [date, username, '', qty, txn || null, status, txnCount, req.session.user.id]
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
          recent: [],
          result: { kind, dryRun, empty: true, fileName: req.file.originalname, sheet: parsed.sheet, headerMap: parsed.headerMap, errors, preview },
        });
      }

      res.render('upload', {
        title: 'Daily Upload',
        page: 'upload',
        today: D.todayISO(),
        recent: await db.rows(
          `SELECT source, COUNT(*)::int AS rows, MAX(created_at) AS last_at
             FROM deposits GROUP BY source ORDER BY last_at DESC NULLS LAST`
        ),
        result: {
          kind, dryRun,
          fileName: req.file.originalname,
          sheet: parsed.sheet,
          headerMap: parsed.headerMap,
          preview, errors, inserted, skipped, sync,
          count: preview.length,
        },
      });
    } catch (err) {
      req.session.flash = {
        type: 'error',
        message: /xlsx|zip|corrupt|End of data|Invalid/i.test(err.message || '')
          ? 'File padhi nahi ja saki. Excel me "Save As → .xlsx" karke dobara bhejein.'
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





