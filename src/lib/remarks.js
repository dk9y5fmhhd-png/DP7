'use strict';

// Spec ke remarks aur unka "next action" — caller jo chune, system aage ka
// kaam khud tay kar de.

const REMARKS = [
  { key: 'Interested', next: 'Follow-up schedule', tone: 'success' },
  { key: 'Will Deposit', next: 'Follow-up priority', tone: 'success' },
  { key: 'Not Interested', next: 'Low priority / review', tone: 'neutral' },
  { key: 'No Answer', next: 'Retry queue', tone: 'warn' },
  { key: 'Number Not Reachable', next: 'Retry later', tone: 'warn' },
  { key: 'Already Active', next: 'Activity verification', tone: 'info' },
  { key: 'Wrong Number', next: 'Data correction', tone: 'danger' },
  { key: 'Do Not Contact', next: 'Suppress future calls', tone: 'danger' },
];

const REMARK_MAP = new Map(REMARKS.map((r) => [r.key, r]));

// Purane action types bhi chalte rahein (backward compatibility)
const LEGACY = ['Play Later', 'Busy', 'Deposited', 'Call Tomorrow', 'Switch Off', 'Message Done', 'Call Done', 'Call Again'];

const ALL_ACTIONS = [...REMARKS.map((r) => r.key), ...LEGACY];

function nextActionFor(action) {
  const r = REMARK_MAP.get(action);
  return r ? r.next : '';
}

function toneFor(action) {
  const r = REMARK_MAP.get(action);
  return r ? r.tone : 'neutral';
}

// Jin remarks par customer ko dobara call nahi karna
const SUPPRESS = new Set(['Do Not Contact']);

// Jin remarks se retry queue banti hai
const RETRY = new Set(['No Answer', 'Number Not Reachable', 'Call Again', 'Busy', 'Switch Off']);

module.exports = { REMARKS, REMARK_MAP, ALL_ACTIONS, LEGACY, nextActionFor, toneFor, SUPPRESS, RETRY };

