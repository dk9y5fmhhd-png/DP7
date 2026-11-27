'use strict';

// Who may act on a customer: Super Admin on anyone, everyone else only on the
// customers assigned to them.

const db = require('../db');

async function ownCustomer(user, username) {
  if (!user || !username) return null;
  // The account is read fresh, so a deleted user cannot act on an old session.
  const me = await db.row('SELECT id, role FROM users WHERE id = $1', [user.id]);
  if (!me) return null;
  const c = await db.row('SELECT * FROM customers WHERE LOWER(username) = LOWER($1)', [username]);
  if (!c) return null;
  return me.role === 'super_admin' || c.assigned_to === me.id ? c : null;
}

// For remarks: a Super Admin may also note a username that is not in the
// customer master yet (older follow-up screens allow that).
async function canTouch(user, username) {
  const me = user && (await db.row('SELECT id, role FROM users WHERE id = $1', [user.id]));
  if (!me) return false;
  if (me.role === 'super_admin') return true;
  return Boolean(await ownCustomer(user, username));
}

module.exports = { ownCustomer, canTouch };
