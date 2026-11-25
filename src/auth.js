'use strict';

const crypto = require('crypto');
const db = require('./db');

const PAGES = [
  { key: 'dashboard', label: 'Dashboard', url: '/', icon: 'grid', group: 'main' },
  { key: 'customers', label: 'Customers', url: '/customers', icon: 'team', group: 'main' },
  { key: 'newclients', label: 'New Clients', url: '/new-clients', icon: 'day', group: 'main' },
  { key: 'priority', label: 'Calling List', url: '/calling', icon: 'alert', group: 'main' },
  { key: 'mycalls', label: 'My Calls', url: '/calling/my', icon: 'phone', group: 'main' },
  { key: 'calls', label: 'Call Log', url: '/calls', icon: 'clock', group: 'main' },
  { key: 'due', label: 'Follow-ups Due', url: '/calling/due', icon: 'alert', group: 'main' },
  { key: 'upload', label: 'Daily Upload', url: '/upload', icon: 'upload', group: 'main' },
  { key: 'adddata', label: 'Add Data', url: '/add-data', icon: 'plus', group: 'main' },
  { key: 'reports', label: 'Client Reports', url: '/reports', icon: 'list', group: 'reports' },
  { key: 'level_report', label: 'Level Report', url: '/reports/level', icon: 'award', group: 'reports' },
  { key: 'daily_report', label: 'Daily Report', url: '/reports/daily', icon: 'day', group: 'reports' },
  { key: 'weekly_report', label: 'Weekly Report', url: '/reports/weekly', icon: 'week', group: 'reports' },
  { key: 'biweekly_report', label: 'By Weekly Report', url: '/reports/biweekly', icon: 'weeks', group: 'reports' },
  { key: 'monthly_report', label: 'Monthly Report', url: '/reports/monthly', icon: 'month', group: 'reports' },
  { key: 'followups', label: 'Follow-ups', url: '/followups', icon: 'phone', group: 'reports' },
  { key: 'cadence', label: 'Cadence', url: '/cadence', icon: 'refresh', group: 'admin', superOnly: true },
  { key: 'callers', label: 'Caller Load', url: '/callers', icon: 'layers', group: 'admin', superOnly: true },
  { key: 'approvals', label: 'Login Approvals', url: '/approvals', icon: 'shield', group: 'admin', superOnly: true },
  { key: 'backup', label: 'Backup & Export', url: '/backup', icon: 'download', group: 'admin', superOnly: true },
  { key: 'users', label: 'Users', url: '/users', icon: 'team', group: 'admin', superOnly: true },
  { key: 'settings', label: 'Settings', url: '/settings', icon: 'settings', group: 'admin', superOnly: true },
  { key: 'security', label: 'Security', url: '/security', icon: 'shield', group: 'account' },
];

const PAGE_KEYS = PAGES.map((p) => p.key);

// Login ke baad user ko uske pehle allowed page par bhejo — warna dashboard
// access na hone par seedha 403 milta hai.
function landingPage(user) {
  if (!user) return '/login';
  if (can(user, 'dashboard')) return '/';
  const first = PAGES.find((p) => p.key !== 'dashboard' && can(user, p.key));
  return first ? first.url : '/security';
}

function can(user, page) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (!PAGE_KEYS.includes(page)) return false;
  const grant = user.page_access || [];
  return grant.includes('all') || grant.includes(page);
}

// Session kitna lamba chalega — default 10 ghante (env se badal sakte hain)
function sessionMs() {
  const h = Number(process.env.SESSION_HOURS || 10);
  const hours = Number.isFinite(h) && h > 0 ? h : 10;
  return hours * 60 * 60 * 1000;
}

// 10 ghante ka fixed clock — har refresh par nahi badhta
function sessionExpired(req) {
  if (!req.session || !req.session.user) return false;
  const exp = Number(req.session.expiresAt || 0);
  if (!exp) return false;
  return Date.now() > exp;
}

function destroySession(req) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

function attachUser(req, res, next) {
  // Muddat khatam → turant logout (refresh par bhi yahi hoga)
  if (sessionExpired(req)) {
    return destroySession(req).then(() => {
      res.locals.user = null;
      res.locals.can = () => false;
      res.locals.PAGES = PAGES;
      res.locals.page = null;
      res.locals.path = req.path;
      res.locals.sessionExpiredFlash = true;
      return res.redirect('/login?expired=1');
    });
  }
  res.locals.user = req.session.user || null;
  res.locals.can = (page) => can(req.session.user, page);
  res.locals.PAGES = PAGES;
  res.locals.page = null;
  res.locals.path = req.path;
  next();
}

function requireLogin(req, res, next) {
  if (sessionExpired(req)) return destroySession(req).then(() => res.redirect('/login?expired=1'));
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requirePage(page) {
  return function (req, res, next) {
    if (sessionExpired(req)) return destroySession(req).then(() => res.redirect('/login?expired=1'));
    if (!req.session.user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (!can(req.session.user, page)) {
      return res.status(403).render('error', {
        title: 'Access denied',
        heading: 'Access denied',
        message: `Aapke account ko "${page}" page ka access nahi hai. Super Admin se kehiye.`,
      });
    }
    next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'super_admin') {
    return res.status(403).render('error', {
      title: 'Access denied',
      heading: 'Super Admin only',
      message: 'Ye page sirf Super Admin ke liye hai.',
    });
  }
  next();
}

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function isMultipart(req) {
  return String(req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data');
}

// multipart body multer ke andar parse hota hai, isliye CSRF check route ke
// andar hota hai (verifyCsrf) — yahan sirf aage jaane dete hain.
function checkCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (isMultipart(req)) return next();
  const sent = req.body && (req.body.csrf_token || req.get('x-csrf-token'));
  if (!req.session.csrf || sent !== req.session.csrf) {
    return res.status(403).render('error', {
      title: 'Session expired',
      heading: 'Form expired',
      message: 'Page purana ho gaya tha. Refresh karke dobara try kijiye.',
    });
  }
  next();
}

// multipart route ke andar, parsing ke baad.
function verifyCsrf(req) {
  if (!req.session.csrf) return false;
  const sent = (req.body && req.body.csrf_token) || req.get('x-csrf-token');
  return sent === req.session.csrf;
}

function rejectCsrf(res) {
  return res.status(403).render('error', {
    title: 'Session expired',
    heading: 'Form expired',
    message: 'Page purana ho gaya tha. Refresh karke dobara try kijiye.',
  });
}

async function audit(req, action, detail) {
  try {
    const u = req.session.user;
    await db.query(
      'INSERT INTO audit_log (user_id, login_id, action, detail, ip) VALUES ($1,$2,$3,$4,$5)',
      [u ? u.id : null, u ? u.login_id : null, action, detail || null, clientIp(req)]
    );
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket ? req.socket.remoteAddress : '';
}

module.exports = {
  PAGES,
  PAGE_KEYS,
  landingPage,
  can,
  attachUser,
  sessionMs,
  sessionExpired,
  destroySession,
  requireLogin,
  requirePage,
  requireSuperAdmin,
  csrfToken,
  checkCsrf,
  verifyCsrf,
  rejectCsrf,
  isMultipart,
  audit,
  clientIp,
};






