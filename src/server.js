'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const db = require('./db');
const D = require('./lib/dates');
const auth = require('./auth');
const settings = require('./settings');
const { icon } = require('./lib/icons');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: false, limit: '4mb' }));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET set nahi hai — har restart par login reset ho jayega.');
}

app.use(
  session({
    store: new PgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
    },
  })
);

app.use((req, res, next) => {
  res.locals.csrfToken = auth.csrfToken(req);
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.helpers = {
    money: D.money,
    moneyExact: D.moneyExact,
    prettyDate: D.prettyDate,
    prettyDateLong: D.prettyDateLong,
    prettyDateTime: D.prettyDateTime,
    relativeDays: D.relativeDays,
    today: D.todayISO,
  };
  res.locals.title = 'DP7';
  res.locals.icon = icon;
  res.locals.ACTION_TYPES = require('./lib/actions').ACTION_TYPES;
  next();
});

app.use(auth.attachUser);
app.use(auth.checkCsrf);

// Routes
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/customers', require('./routes/customers'));
app.use('/calling', require('./routes/priority'));
app.use('/calls', require('./routes/calls'));
app.use('/upload', require('./routes/upload'));
app.use('/add-data', require('./routes/adddata'));
app.use('/reports', require('./routes/reports'));
app.use('/followups', require('./routes/followups'));
app.use('/users', require('./routes/users'));
app.use('/settings', require('./routes/settings'));
app.use('/security', require('./routes/security'));
app.use('/backup', require('./routes/backup'));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    heading: 'Page nahi mila',
    message: `"${req.path}" exist nahi karta.`,
  });
});

app.use((err, req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  const isMissingTable = /relation .* does not exist|does not exist/i.test(err.message || '');
  res.status(500).render('error', {
    title: 'Error',
    heading: isMissingTable ? 'Database tayyar nahi hai' : 'Kuch galat ho gaya',
    message: isMissingTable
      ? 'Tables nahi mile. Deploy ke baad ek dafa `npm run migrate` chalayein (start command me pre-deploy).'
      : err.message || 'Unknown error',
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✓ DP7 listening on :${PORT}`);
  try {
    await db.query('SELECT 1');
    // har deploy par schema/settings khud check ho jaayein
    await require('./lib/bootstrap').start();
    const cfg = await settings.all();
    console.log(`✓ db connected · active window ${cfg.active_window_days}d · TZ ${D.APP_TZ}`);
  } catch (err) {
    console.error('✗ database not reachable:', err.message);
  }
});

module.exports = app;






