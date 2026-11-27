'use strict';

require('dotenv').config();

const fs = require('fs');
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
const i18n = require('./lib/i18n');
const pkg = require('../package.json');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);
// English fallbacks, so the error page renders even before a language is chosen.
Object.assign(app.locals, {
  lang: 'en', LANGUAGES: i18n.LANGUAGES,
  waAlerts: [],
  assetVersion: '0',
  _t: (k, v) => i18n.t(k, v, 'en'), _th: (k, v) => i18n.th(k, v, 'en'), _tm: (m) => m, _js: (k, v) => i18n.js(k, v, 'en'),
});
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// TeleCMI call records. Mounted before sessions and CSRF: the caller is
// TeleCMI's server, authenticated by the secret token in the address.
app.use('/telecmi', require('./routes/telecmi-webhook'));

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

// Newest change among the stylesheet and scripts, so their addresses change
// whenever they do and a cached copy is never reused.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const assetVersion = () => Math.max(...['style.css', 'ui.js', 'app.js', 'wa.js', 'popups.js', 'users.js']
  .map((f) => fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs)).toString(36).replace('.', '');
const bootAssetVersion = assetVersion();

app.use((req, res, next) => {
  res.locals.assetVersion = process.env.NODE_ENV === 'production' ? bootAssetVersion : assetVersion();
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
  res.locals.mask = require('./lib/customers').maskMobile;
  res.locals.appVersion = pkg.version;
  res.locals.icon = icon;
  res.locals.ACTION_TYPES = require('./lib/actions').ACTION_TYPES;
  next();
});

app.use(auth.attachUser);

// Language: what was picked in this session, then the user's saved choice, then
// the system default. Runs before the CSRF check so its error page is translated.
app.use(async (req, res, next) => {
  let lang = req.session.lang || req.session.user?.language;
  if (!lang) lang = await settings.get('default_language', 'en').catch(() => 'en');
  if (!i18n.isLang(lang)) lang = 'en';
  res.locals.lang = lang;
  res.locals.LANGUAGES = i18n.LANGUAGES;
  res.locals._t = (key, vars) => i18n.t(key, vars, lang);
  res.locals._th = (key, vars) => i18n.th(key, vars, lang);
  res.locals._tm = (message) => i18n.tm(message, lang);
  res.locals._js = (key, vars) => i18n.js(key, vars, lang);
  // Date helpers answer in the same language, wherever the page is rendered from.
  const helpers = res.locals.helpers;
  for (const name of Object.keys(helpers)) {
    const fn = helpers[name];
    helpers[name] = (...args) => i18n.run(lang, () => fn(...args));
  }
  i18n.run(lang, next);
});

app.use(auth.checkCsrf);

// A WhatsApp number that silently dropped is otherwise only noticed when a
// caller complains, so the Super Admin sees it on every page.
app.use(async (req, res, next) => {
  res.locals.waAlerts = [];
  if (req.method === 'GET' && req.session.user?.role === 'super_admin') {
    res.locals.waAlerts = await require('./lib/whatsapp-inbox').numberAlerts().catch(() => []);
  }
  next();
});

// Routes
app.use('/', require('./routes/language'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/assign', require('./routes/assign'));
app.use('/cadence', require('./routes/cadence'));
app.use('/callers', require('./routes/callers'));
app.use('/approvals', require('./routes/approvals'));
app.use('/customers', require('./routes/customers'));
app.use('/new-clients', require('./routes/newclients'));
app.use('/calling', require('./routes/priority'));
app.use('/calls', require('./routes/calls'));
app.use('/settings/calling', require('./routes/calling-settings'));
app.use('/whatsapp', require('./routes/whatsapp'));
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
  require('./lib/respond').fail(req, res, 404, {
    title: 'Not found',
    heading: 'Page not found',
    message: `"${req.path}" does not exist.`,
  });
});

app.use((err, req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  const isMissingTable = /relation .* does not exist|does not exist/i.test(err.message || '');
  require('./lib/respond').fail(req, res, 500, {
    title: 'Error',
    page: null,
    appVersion: pkg.version,
    user: (req.session && req.session.user) || null,
    csrfToken: (req.session && req.session.csrf) || '',
    heading: isMissingTable ? 'The database is not ready' : 'Something went wrong',
    message: isMissingTable
      ? 'Tables are missing. Run `npm run migrate` once after deploying.'
      // Raw error text stays in the server log.
      : 'Something went wrong. Try again.',
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






