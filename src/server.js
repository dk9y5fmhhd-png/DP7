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
const pkg = require('../package.json');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// parameterLimit: bulk assign me 2,000+ checkbox ek saath aate hain — default
// 1,000 par "too many parameters" error deta tha.
app.use(express.urlencoded({ extended: false, limit: '8mb', parameterLimit: 20000 }));
app.use(express.json({ limit: '8mb' }));
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
    // rolling: false — har request par expiry aage nahi khiskti.
    // Login ke 10 ghante baad session khatam, refresh par logout.
    rolling: false,
    cookie: {
      maxAge: auth.sessionMs(),
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
  // Mobile masking — sirf Super Admin ko poora number
  res.locals.mask = (m) => {
    const full = req.session && req.session.user && req.session.user.role === 'super_admin';
    return require('./lib/customers').maskMobile(m, full);
  };
  res.locals.appVersion = pkg.version;
  res.locals.icon = icon;
  res.locals.ACTION_TYPES = require('./lib/actions').ACTION_TYPES;
  next();
});

app.use(auth.attachUser);
app.use(auth.checkCsrf);

// Routes
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/daily', require('./routes/daily'));
app.use('/assign', require('./routes/assign'));
app.use('/cadence', require('./routes/cadence'));
app.use('/callers', require('./routes/callers'));
app.use('/approvals', require('./routes/approvals'));
app.use('/customers', require('./routes/customers'));
app.use('/new-clients', require('./routes/newclients'));
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
    res.json({ ok: true, version: pkg.version, time: new Date().toISOString() });
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
    page: null,
    appVersion: pkg.version,
    user: (req.session && req.session.user) || null,
    csrfToken: (req.session && req.session.csrf) || '',
    heading: isMissingTable ? 'Database tayyar nahi hai' : 'Kuch galat ho gaya',
    message: isMissingTable
      ? 'Tables nahi mile. Deploy ke baad ek dafa `npm run migrate` chalayein (start command me pre-deploy).'
      : err.message || 'Unknown error',
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✓ DP7 v${pkg.version} listening on :${PORT}`);
  try {
    await db.query('SELECT 1');
    // har deploy par schema/settings khud check ho jaayein
    await require('./lib/bootstrap').start();
    const cfg = await settings.all();
    console.log(`✓ db connected · session ${Math.round(auth.sessionMs() / 3600000)}h · active window ${cfg.active_window_days}d · TZ ${D.APP_TZ}`);
  } catch (err) {
    console.error('✗ database not reachable:', err.message);
  }
});

module.exports = app;






