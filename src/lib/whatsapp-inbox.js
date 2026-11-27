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

// One refusal is a contact who never chatted with the number. Several contacts
// refused within a day, and not reached since, is what a restricted number
// looks like. Same threshold and window as Ringline.
const REFUSED_CONTACTS_THRESHOLD = 3;

async function refusals() {
  const rows = await db.rows(
    `SELECT r.session_id AS id, COUNT(DISTINCT r.conversation_key)::int AS refused,
            (SELECT COUNT(*)::int FROM whatsapp_messages c WHERE c.session_id = r.session_id AND c.direction = 'out'
               AND c.delivery_status >= 2 AND c.message_at > NOW() - INTERVAL '24 hours') AS confirmed
       FROM whatsapp_messages r
      WHERE r.direction = 'out' AND r.delivery_error = '463' AND r.message_at > NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages ok
              WHERE ok.session_id = r.session_id AND ok.conversation_key = r.conversation_key
                AND ok.direction = 'out' AND ok.delivery_status >= 2 AND ok.message_at > r.message_at)
      GROUP BY r.session_id
     HAVING COUNT(DISTINCT r.conversation_key) >= $1`,
    [REFUSED_CONTACTS_THRESHOLD]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Numbers that are down and will not come back alone, or that WhatsApp keeps
// refusing (error 463). For the Super Admin's warning banner.
async function numberAlerts() {
  const rows = await db.rows('SELECT id, label, status FROM whatsapp_sessions WHERE deleted_at IS NULL ORDER BY id');
  const refused = await refusals();
  const out = [];
  for (const n of rows) {
    const r = refused.get(n.id);
    if (n.status === 'logged_out') out.push({ key: '{label} was unlinked from its phone. Nothing can be sent or answered from it until it is linked again.', label: n.label });
    else if (n.status === 'replaced') out.push({ key: '{label} was stopped because it is open somewhere else.', label: n.label });
    else if (r) {
      out.push({
        key: r.confirmed
          ? '{label} cannot start new chats right now: WhatsApp refused messages to {n} contacts in the last 24 hours, although {confirmed} other messages went through. It can probably still answer people who wrote first. Use another number for new contacts.'
          : '{label} is probably restricted by WhatsApp: it refused messages to {n} contacts in the last 24 hours and confirmed none. Pause sending from it and check its phone for a WhatsApp notice.',
        label: n.label, n: r.refused, confirmed: r.confirmed,
      });
    }
  }
  return out;
}

module.exports = { conversations, waitingFor, numberAlerts, refusals, PAGE };
