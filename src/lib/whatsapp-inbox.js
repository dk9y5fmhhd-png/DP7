'use strict';

// Conversations for the WhatsApp inbox. A chat belongs to the customer's current
// caller, so reassigning a customer moves the chat (as in Ringline).

const db = require('../db');

const PAGE = 30;

// The latest message of every conversation that has had a reply.
const latest = (extra) => `
  SELECT DISTINCT ON (m.session_id, m.conversation_key)
         m.*, m.message_at::text AS at, c.username AS customer_name, c.assigned_to, u.name AS staff_name,
         s.label AS number_label
    FROM whatsapp_messages m
    JOIN whatsapp_sessions s ON s.id = m.session_id
    LEFT JOIN customers c ON c.id = m.customer_id
    LEFT JOIN users u ON u.id = c.assigned_to
   WHERE EXISTS (SELECT 1 FROM whatsapp_messages i WHERE i.session_id = m.session_id
                   AND i.conversation_key = m.conversation_key AND i.direction = 'in') ${extra}
   ORDER BY m.session_id, m.conversation_key, m.message_at DESC, m.id DESC`;

// ownerId limits to one caller's customers; null means everyone (Super Admin).
async function conversations({ ownerId = null, staffId = null, q = '', needsReply = false, page = 1 }) {
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const inner = ownerId ? `AND c.assigned_to = ${add(ownerId)}` : '';
  const outer = [];
  if (staffId) outer.push(`t.assigned_to = ${add(staffId)}`);
  if (needsReply) outer.push("t.direction = 'in'");
  if (q) {
    const like = add(`%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    outer.push(`(LOWER(COALESCE(t.customer_name,'')) LIKE ${like} OR LOWER(COALESCE(t.staff_name,'')) LIKE ${like}
       OR EXISTS (SELECT 1 FROM whatsapp_messages x WHERE x.session_id = t.session_id
                    AND x.conversation_key = t.conversation_key AND LOWER(COALESCE(x.body,'')) LIKE ${like}))`);
  }
  const rows = await db.rows(
    `SELECT * FROM (${latest(inner)}) t ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
      ORDER BY t.message_at DESC, t.id DESC LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`,
    params
  );
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE };
}

// Chats whose last message is from the customer.
async function waitingFor(userId) {
  const me = await db.row('SELECT role FROM users WHERE id = $1', [userId]);
  if (!me) return 0;
  const mine = me.role !== 'super_admin';
  return db.value(
    `SELECT COUNT(*)::int FROM (${latest(mine ? 'AND c.assigned_to = $1' : '')}) t WHERE t.direction = 'in'`,
    mine ? [userId] : []
  );
}

// Numbers that are down and will not come back alone, or that WhatsApp keeps
// refusing (error 463). For the Super Admin's warning banner.
async function numberAlerts() {
  const rows = await db.rows(
    `SELECT s.label, s.status,
            (SELECT COUNT(DISTINCT m.number)::int FROM whatsapp_messages m WHERE m.session_id = s.id
               AND m.delivery_error = '463' AND m.message_at > NOW() - INTERVAL '24 hours') AS refused
       FROM whatsapp_sessions s WHERE s.deleted_at IS NULL ORDER BY s.id`
  );
  const out = [];
  for (const n of rows) {
    if (n.status === 'logged_out') out.push({ key: '{label} was unlinked from its phone. Nothing can be sent or answered from it until it is linked again.', label: n.label });
    else if (n.status === 'replaced') out.push({ key: '{label} was stopped because it is open somewhere else.', label: n.label });
    else if (n.refused >= 3) out.push({ key: 'WhatsApp refused messages from {label} to {n} contacts in the last 24 hours. Pause sending from it and check its phone.', label: n.label, n: n.refused });
  }
  return out;
}

module.exports = { conversations, waitingFor, numberAlerts, PAGE };
