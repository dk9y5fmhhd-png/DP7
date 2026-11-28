'use strict';

// Remarks + unka next action + DEFAULT follow-up gap (days).
//
// No-deposit pipeline ke 5 bade remark:
//   Deposited      → Deposited tab me shift (caller wahi), queue se out
//   Interested     → 5 days
//   Will Deposit   → 3 days
//   Fake           → customer permanently delete
//   Not Interested → 15 days

const REMARKS = [
  { key: 'Deposited',            next: 'Move to Deposited',      tone: 'success', days: 0 },
  { key: 'Will Deposit',         next: 'Follow-up priority',     tone: 'success', days: 3 },
  { key: 'Interested',           next: 'Follow-up schedule',     tone: 'success', days: 5 },
  { key: 'Not Interested',       next: 'Low priority / review',  tone: 'neutral', days: 15 },
  { key: 'No Answer',            next: 'Retry queue',            tone: 'warn',    days: 1 },
  { key: 'Number Not Reachable', next: 'Retry later',            tone: 'warn',    days: 1 },
  { key: 'Fake',                 next: 'Delete permanently',     tone: 'danger',  days: 0 },
  { key: 'Wrong Number',         next: 'Data correction',        tone: 'danger',  days: 30 },
  { key: 'Already Active',       next: 'Activity verification',  tone: 'info',    days: 7 },
  { key: 'Do Not Contact',       next: 'Suppress future calls',  tone: 'danger',  days: 0 },
];

const REMARK_MAP = new Map(REMARKS.map((r) => [r.key, r]));

// Purane action types bhi chalte rahein (backward compatibility)
const LEGACY = [
  { key: 'Play Later',    next: 'Follow-up schedule', tone: 'info',    days: 2 },
  { key: 'Busy',          next: 'Retry queue',        tone: 'warn',    days: 1 },
  { key: 'Call Tomorrow', next: 'Follow-up schedule', tone: 'info',    days: 1 },
  { key: 'Switch Off',    next: 'Retry queue',        tone: 'warn',    days: 1 },
  { key: 'Message Done',  next: 'Follow-up schedule', tone: 'info',    days: 2 },
  { key: 'Call Done',     next: 'Follow-up schedule', tone: 'info',    days: 3 },
  { key: 'Call Again',    next: 'Retry queue',        tone: 'warn',    days: 1 },
];
for (const l of LEGACY) if (!REMARK_MAP.has(l.key)) REMARK_MAP.set(l.key, l);

const ALL_ACTIONS = [...REMARKS.map((r) => r.key), ...LEGACY.map((l) => l.key)];

function info(action) {
  return REMARK_MAP.get(action) || { key: action, next: '', tone: 'neutral', days: 1 };
}
const nextActionFor = (action) => info(action).next;
const toneFor = (action) => info(action).tone;
const daysFor = (action) => info(action).days;

// Jin remarks par customer dobara call nahi karna
const SUPPRESS = new Set(['Do Not Contact']);

// Deposited — customer queue se nikal kar Deposited tab me
const MOVES_OUT = new Set(['Deposited']);

// Fake — customer permanently delete
const DELETES = new Set(['Fake']);

// Retry queue
const RETRY = new Set(['No Answer', 'Number Not Reachable', 'Call Again', 'Busy', 'Switch Off']);

// Caller ke liye quick date buttons
const QUICK_DATES = [
  { days: 1, label: 'Tomorrow' },
  { days: 3, label: '3 days' },
  { days: 5, label: '5 days' },
  { days: 15, label: '15 days' },
];

module.exports = {
  REMARKS, LEGACY, REMARK_MAP, ALL_ACTIONS, QUICK_DATES,
  info, nextActionFor, toneFor, daysFor,
  SUPPRESS, MOVES_OUT, DELETES, RETRY,
};

