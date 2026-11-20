'use strict';

// All business dates are plain YYYY-MM-DD strings handled in UTC, so there is no
// DST/offset drift. "Today" is resolved in APP_TZ (default: Asia/Kolkata) because
// the office works on IST days, not on the server's UTC day.

const APP_TZ = process.env.APP_TZ || 'Asia/Kolkata';

function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function parse(d) {
  return new Date(d + 'T00:00:00Z');
}
function fmt(dt) {
  return dt.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const dt = parse(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmt(dt);
}
function diffDays(a, b) {
  // b - a, in whole days
  return Math.round((parse(b) - parse(a)) / 86400000);
}
function dow(d) {
  return parse(d).getUTCDay(); // 0 = Sunday
}

function startOfWeek(d) {
  return addDays(d, -((dow(d) + 6) % 7)); // Monday
}
function endOfWeek(d) {
  return addDays(startOfWeek(d), 6); // Sunday
}
function startOfMonth(d) {
  return d.slice(0, 7) + '-01';
}
function endOfMonth(d) {
  const dt = parse(startOfMonth(d));
  dt.setUTCMonth(dt.getUTCMonth() + 1);
  dt.setUTCDate(0);
  return fmt(dt);
}

function isoWeekNumber(d) {
  const dt = parse(d);
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  return 1 + Math.round((dt - firstThursday) / (7 * 86400000));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function prettyDate(d) {
  if (!isDate(d)) return '—';
  const dt = parse(d);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()].slice(0, 3)} ${dt.getUTCFullYear()}`;
}
function prettyDateLong(d) {
  if (!isDate(d)) return '—';
  const dt = parse(d);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()} (${DAYS[dt.getUTCDay()]})`;
}
function prettyDateTime(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}
function relativeDays(d, from) {
  if (!isDate(d)) return 'never';
  const n = diffDays(d, from || todayISO());
  if (n <= 0) return 'today';
  if (n === 1) return '1 day ago';
  return `${n} days ago`;
}

function money(n) {
  const num = Number(n || 0);
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function moneyExact(n) {
  const num = Number(n || 0);
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The period a cohort report is looking at.
function periodFor(kind, anchor) {
  if (kind === 'daily') {
    return { start: anchor, end: anchor, label: prettyDateLong(anchor) };
  }
  if (kind === 'monthly') {
    const start = startOfMonth(anchor);
    const end = endOfMonth(anchor);
    return { start, end, label: `${MONTHS[parse(start).getUTCMonth()]} ${start.slice(0, 4)}` };
  }
  const start = startOfWeek(anchor);
  const end = endOfWeek(anchor);
  const wk = isoWeekNumber(start);
  return { start, end, label: `Week ${wk} · ${prettyDate(start)} – ${prettyDate(end)}` };
}

// Previous / next anchor for the "change" selector.
function shiftPeriod(kind, anchor, dir) {
  if (kind === 'daily') return addDays(anchor, dir);
  if (kind === 'monthly') {
    const dt = parse(startOfMonth(anchor));
    dt.setUTCMonth(dt.getUTCMonth() + dir);
    return fmt(dt);
  }
  return addDays(anchor, dir * 7);
}

module.exports = {
  APP_TZ,
  todayISO,
  isDate,
  parse,
  fmt,
  addDays,
  diffDays,
  dow,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  isoWeekNumber,
  prettyDate,
  prettyDateLong,
  prettyDateTime,
  relativeDays,
  money,
  moneyExact,
  periodFor,
  shiftPeriod,
  MONTHS,
};

