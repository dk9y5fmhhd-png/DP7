'use strict';

const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const D = require('../lib/dates');
const importer = require('../lib/import-data');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls|csv|txt)$/i.test(file.originalname || '');
    if (!ok) {
      return cb(new Error('Sirf .xlsx, .csv ya .txt file chalti hai.'));
    }
    cb(null, true);
  },
});

const SPLIT = /\s*[\t,;|]\s*|\s{2,}|\s+/;

function parseLine(line) {
  const parts = line.split(SPLIT).filter((p) => p !== '');
  if (!parts.length) return null;
  const username = String(parts[0] || '').trim();
  const mobile = importer.normaliseMobile(parts[1] || '');
  let amount = 0;
  if (parts[2] !== undefined && parts[2] !== '') {
    amount = Number(String(parts[2]).replace(/[₹,\s]/g, ''));
  }
  return { username, mobile, amount: Number.isFinite(amount) ? amount : NaN };
}

function parseBulk(text, fallbackDate) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  const errors = [];
  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    // header line skip
    if (/^(username|user|name)\b/i.test(trimmed)) return;
    const parsed = parseLine(trimmed);
    if (!parsed) return;
    if (!parsed.username) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Username khaali hai' });
      return;
    }
    if (parsed.username.length > 60) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Username 60 characters se bada hai' });
      return;
    }
    if (!parsed.mobile || parsed.mobile.length < 10) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Mobile number galat ya missing hai' });
      return;
    }
    if (!Number.isFinite(parsed.amount) || parsed.amount < 0) {
      errors.push({ line: i + 1, text: trimmed, reason: 'Amount galat hai' });
      return;
    }
    rows.push({ line: i + 1, date: fallbackDate, username: parsed.username, mobile: parsed.mobile, amount: parsed.amount });
  });
  return { rows, errors };
}

async function recentDays() {
  return db.rows(
    `SELECT play_date::text AS d,
            COUNT(*)::int AS entries,
            COUNT(DISTINCT LOWER(username))::int AS clients,
            COALESCE(SUM(amount),0)::float8 AS amount
       FROM deposits
      GROUP BY play_date
      ORDER BY play_date DESC
      LIMIT 14`
  );
}

function render(req, res, status, extra) {
  return recentDays().then((days) =>
    res.status(status).render('adddata', {
      title: 'Add Data',
      page: 'adddata',
      today: extra.today,
      days,
      result: extra.result,
      draft: extra.draft || '',
      tab: extra.tab || 'excel',
    })
  );
}

// Data ko date ke hisaab se group karke insert karo. Ek hi din+username par
// doosri entry skip ho jaati hai (unique index).
async function insertRows(rows, userId) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  let inserted = 0;
  let skipped = 0;
  const perDate = [];

  for (const [date, list] of [...byDate.entries()].sort()) {
    const out = await db.query(
      `INSERT INTO deposits (play_date, username, mobile, amount, created_by)
       SELECT $1::date, u, m, a, $5
         FROM UNNEST($2::text[], $3::text[], $4::numeric[]) AS t(u, m, a)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [date, list.map((r) => r.username), list.map((r) => r.mobile), list.map((r) => r.amount), userId]
    );
    const ok = out.rowCount;
    inserted += ok;
    skipped += list.length - ok;
    perDate.push({ date, total: list.length, inserted: ok, skipped: list.length - ok });
  }

  return { inserted, skipped, perDate };
}

router.get('/', auth.requirePage('adddata'), async (req, res, next) => {
  try {
    await render(req, res, 200, { today: D.todayISO(), result: null });
  } catch (err) {
    next(err);
  }
});

router.get('/template', auth.requirePage('adddata'), async (req, res, next) => {
  try {
    const buf = await importer.buildTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="dp7-upload-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    next(err);
  }
});

// File upload ya paste — dono ek hi handler se
router.post('/', auth.requirePage('adddata'), (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      req.session.flash = {
        type: 'error',
        message:
          uploadErr.code === 'LIMIT_FILE_SIZE'
            ? 'File 20 MB se badi hai — chhote hisson me upload karein.'
            : uploadErr.message,
      };
      return res.redirect('/add-data');
    }
    try {
      if (!auth.verifyCsrf(req)) return auth.rejectCsrf(res);

      const playDate = D.isDate(req.body.play_date) ? req.body.play_date : D.todayISO();
      const dryRun = req.body.dry === '1';
      const draft = String(req.body.rows || '');
      const mode = req.file ? 'file' : 'paste';

      let parsed = { rows: [], errors: [], sheet: null, sheets: [], headerMap: null, usedDateColumn: false };

      if (mode === 'file') {
        parsed = await importer.parseFile(req.file.buffer, req.file.originalname, playDate);
      } else {
        const p = parseBulk(draft, playDate);
        parsed.rows = p.rows;
        parsed.errors = p.errors;
      }

      const base = {
        today: playDate,
        draft: dryRun && mode === 'paste' ? draft : '',
        tab: mode,
      };

      if (!parsed.rows.length) {
        return render(req, res, 400, {
          ...base,
          result: {
            dryRun, playDate, mode, empty: true,
            fileName: req.file ? req.file.originalname : null,
            sheet: parsed.sheet, sheets: parsed.sheets,
            headerMap: parsed.headerMap,
            usedDateColumn: parsed.usedDateColumn,
            inserted: 0, skipped: 0,
            errors: parsed.errors,
          },
        });
      }

      let saved = { inserted: 0, skipped: 0, perDate: [] };
      if (!dryRun) {
        saved = await insertRows(parsed.rows, req.session.user.id);
        // customer master ko naye deposits se sync karo
        try { await require('../lib/customers').syncCustomers(); } catch (e) { console.error('[sync]', e.message); }
        await auth.audit(
          req,
          'add_data',
          `mode=${mode} file=${req.file ? req.file.originalname : 'paste'} inserted=${saved.inserted} skipped=${saved.skipped}`
        );
      }

      const dates = [...new Set(parsed.rows.map((r) => r.date))].sort();

      return render(req, res, 200, {
        ...base,
        draft: '',
        result: {
          dryRun,
          mode,
          playDate,
          fileName: req.file ? req.file.originalname : null,
          sheet: parsed.sheet,
          sheets: parsed.sheets,
          headerMap: parsed.headerMap,
          usedDateColumn: parsed.usedDateColumn,
          dates,
          inserted: saved.inserted,
          skipped: saved.skipped,
          perDate: saved.perDate,
          errors: parsed.errors,
          parsed: parsed.rows.slice(0, 200),
          totalRows: parsed.rows.length,
        },
      });
    } catch (err) {
      if (err && /xlsx|zip|corrupt|End of data|Invalid/i.test(err.message || '')) {
        req.session.flash = {
          type: 'error',
          message:
            'File padhi nahi ja saki. Excel me File → Save As → "Excel Workbook (.xlsx)" karke dobara upload karein.',
        };
        return res.redirect('/add-data');
      }
      next(err);
    }
  });
});

// Poora din delete — T-PIN ke saath
router.post('/delete-day', auth.requirePage('adddata'), async (req, res, next) => {
  try {
    const playDate = req.body.play_date;
    const pin = String(req.body.pin || '').trim();
    const realPin = String(await settings.get('delete_pin', '969696'));

    if (!D.isDate(playDate)) {
      req.session.flash = { type: 'error', message: 'Date galat hai.' };
      return res.redirect('/add-data');
    }
    if (pin !== realPin) {
      req.session.flash = { type: 'error', message: 'T-PIN galat hai. Kuch delete nahi hua.' };
      return res.redirect('/add-data');
    }
    const out = await db.query('DELETE FROM deposits WHERE play_date = $1', [playDate]);
    await auth.audit(req, 'delete_day', `date=${playDate} rows=${out.rowCount}`);
    req.session.flash = { type: 'success', message: `${playDate} ke ${out.rowCount} entries delete ho gaye.` };
    res.redirect('/add-data');
  } catch (err) {
    next(err);
  }
});

module.exports = router;


