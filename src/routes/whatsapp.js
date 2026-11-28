'use strict';

// Staff screens for WhatsApp. This file decides who may send what to whom; the
// WhatsApp process (src/wa) owns the connections.
//
// Super Admin: everything. Others: only customers assigned to them, only from
// numbers assigned to them, and they never see a full mobile number. Pages
// address chats by customer or message id so numbers stay out of addresses.

const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const auth = require('../auth');
const access = require('../lib/access');
const wa = require('../lib/wa-client');
const inbox = require('../lib/whatsapp-inbox');
const C = require('../lib/customers');
const { normalizeNumber } = require('../lib/phone');
const { describeDeliveryError, describeDeliveryErrorShort } = require('../wa/delivery-error');

const router = express.Router();
router.use(auth.requirePage('whatsapp'));

const PER_PAGE = 100;
const wantsJson = (req) => String(req.get('accept') || '').includes('application/json');
const isAdmin = (req) => req.session.user.role === 'super_admin';
const idOf = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);
const clean = (v, max) => String(v || '').trim().slice(0, max);

function done(req, res, type, message, to) {
  req.session.flash = { type, message };
  res.redirect(to);
}
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) { next(err); }
};

const STATUS_TEXT = { 1: 'Sending', 2: 'Sent', 3: 'Delivered', 4: 'Read', 5: 'Played' };
function present(m) {
  const failed = m.direction === 'out' && m.delivery_status === 0;
  return {
    ...m,
    contact: m.customer_name || (m.number ? C.maskMobile(m.number) : 'Unknown contact'),
    state: m.direction === 'in' ? '' : failed ? 'Not delivered' : STATUS_TEXT[m.delivery_status] || '',
    failure: failed ? describeDeliveryError(m.delivery_error) : '',
    failureShort: failed ? describeDeliveryErrorShort(m.delivery_error) : '',
  };
}

const MESSAGE_SELECT = `SELECT m.*, m.message_at::text AS at, c.username AS customer_name, s.label AS number_label
   FROM whatsapp_messages m
   JOIN whatsapp_sessions s ON s.id = m.session_id
   LEFT JOIN customers c ON c.id = m.customer_id`;

// Numbers this person may send from.
function usableNumbers(user) {
  const admin = user.role === 'super_admin';
  return db.rows(
    `SELECT s.id, s.label, s.status, s.daily_cap,
            (SELECT COUNT(*)::int FROM whatsapp_messages m WHERE m.session_id = s.id AND m.direction = 'out'
               AND m.message_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS sent_today
       FROM whatsapp_sessions s
      WHERE s.deleted_at IS NULL
        ${admin ? '' : 'AND EXISTS (SELECT 1 FROM whatsapp_session_users su WHERE su.session_id = s.id AND su.user_id = $1)'}
      ORDER BY s.label`,
    admin ? [] : [user.id]
  );
}

/* ------------------------------ inbox + history ------------------------------ */

router.get('/', handle(async (req, res) => {
  const admin = isAdmin(req);
  const filters = {
    q: clean(req.query.q, 100), staff: admin ? idOf(req.query.staff) : 0,
    needsReply: req.query.needs === '1', page: Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 10_000),
  };
  const found = await inbox.conversations({
    ownerId: admin ? null : req.session.user.id, staffId: filters.staff || null,
    q: filters.q, needsReply: filters.needsReply, page: filters.page,
  });
  res.render('whatsapp_list', {
    title: 'WhatsApp', page: 'whatsapp', tab: 'inbox', isAdmin: admin, filters, more: found.more,
    rows: found.rows.map(present),
    staff: admin ? await db.rows("SELECT id, name FROM users ORDER BY name") : [],
  });
}));

router.get('/history', handle(async (req, res) => {
  const admin = isAdmin(req);
  const filters = {
    q: clean(req.query.q, 100), direction: ['in', 'out'].includes(req.query.direction) ? req.query.direction : '',
    number: idOf(req.query.number), page: Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 10_000),
  };
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const where = [];
  // Staff: what they sent, plus replies from their own customers.
  if (!admin) { const me = add(req.session.user.id); where.push(`(m.sent_by = ${me} OR (m.direction = 'in' AND c.assigned_to = ${me}))`); }
  if (filters.direction) where.push(`m.direction = ${add(filters.direction)}`);
  if (filters.number) where.push(`m.session_id = ${add(filters.number)}`);
  if (filters.q) {
    const like = add(`%${filters.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(LOWER(COALESCE(c.username,'')) LIKE ${like} OR LOWER(COALESCE(m.body,'')) LIKE ${like} OR LOWER(COALESCE(m.sent_by_name,'')) LIKE ${like})`);
  }
  const rows = await db.rows(
    `${MESSAGE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY m.message_at DESC, m.id DESC LIMIT ${PER_PAGE + 1} OFFSET ${(filters.page - 1) * PER_PAGE}`, params
  );
  res.render('whatsapp_list', {
    title: 'WhatsApp history', page: 'whatsapp', tab: 'history', isAdmin: admin, filters,
    more: rows.length > PER_PAGE, rows: rows.slice(0, PER_PAGE).map(present),
    allNumbers: await db.rows('SELECT id, label FROM whatsapp_sessions ORDER BY label'),
  });
}));

/* ------------------------------ send to a customer ------------------------------ */

// Where a free-text reply to this customer would go: the number they last wrote to.
const replyTarget = (customerId) => db.row(
  `SELECT m.id, s.label, s.status FROM whatsapp_messages m
     JOIN whatsapp_sessions s ON s.id = m.session_id AND s.deleted_at IS NULL
    WHERE m.customer_id = $1 AND m.direction = 'in' AND m.number IS NOT NULL
    ORDER BY m.message_at DESC, m.id DESC LIMIT 1`, [customerId]
);

// The conversation and everything needed to write in it, for the page and the pop-up.
async function sendContext(req, customer) {
  const messages = await db.rows(
    `${MESSAGE_SELECT} WHERE m.customer_id = $1 ORDER BY m.message_at DESC, m.id DESC LIMIT ${PER_PAGE}`, [customer.id]
  );
  return {
    messages: messages.reverse().map(present), reply: await replyTarget(customer.id),
    me: req.session.user.id, isAdmin: isAdmin(req),
    customer, mobileShown: C.maskMobile(customer.mobile),
    numbers: await usableNumbers(req.session.user),
    templates: await db.rows('SELECT id, name, language, body FROM whatsapp_templates WHERE is_active ORDER BY name, language'),
    optedOut: Boolean(await db.value('SELECT 1 FROM whatsapp_opt_outs WHERE number = $1', [normalizeNumber(customer.mobile)])),
  };
}

router.get('/customer/:username/dialog', handle(async (req, res) => {
  const customer = await access.ownCustomer(req.session.user, req.params.username);
  if (!customer) return res.status(403).end();
  res.render('partials/wa_send_dialog', await sendContext(req, customer));
}));

router.get('/customer/:username', handle(async (req, res) => {
  const customer = await access.ownCustomer(req.session.user, req.params.username);
  if (!customer) {
    return res.status(403).render('error', { title: 'Access denied', heading: 'This customer is not yours', message: 'You can only message customers assigned to you.' });
  }
  res.render('whatsapp_chat', {
    title: `WhatsApp · ${customer.username}`, page: 'whatsapp', ...(await sendContext(req, customer)),
  });
}));

// "Hello {1}" + values -> text. Every placeholder needs a value.
function renderTemplate(body, values) {
  return body.replace(/\{([1-9])\}/g, (_, n) => {
    const v = clean(values[n - 1], 200);
    if (!v) throw new Error(`Fill in value {${n}}.`);
    return v;
  });
}

router.post('/customer/:username', handle(async (req, res) => {
  const back = `/whatsapp/customer/${encodeURIComponent(req.params.username)}`;
  // The pop-up asks for JSON; the full page gets a redirect with a message.
  const answer = (type, message, to = back) => (wantsJson(req)
    ? res.json({ ok: type === 'success', message: res.locals._tm(message) })
    : done(req, res, type, message, to));
  const customer = await access.ownCustomer(req.session.user, req.params.username);
  if (!customer) return answer('error', 'That customer is not assigned to you.', '/whatsapp');
  try {
    if (customer.do_not_contact) throw new Error('This customer is marked "Do Not Contact".');
    const number = (await usableNumbers(req.session.user)).find((n) => n.id === idOf(req.body.session_id));
    if (!number) throw new Error('Choose a WhatsApp number assigned to you.');
    const template = await db.row('SELECT body FROM whatsapp_templates WHERE id = $1 AND is_active', [idOf(req.body.template_id)]);
    if (!template) throw new Error('Choose a template.');
    const text = renderTemplate(template.body, [].concat(req.body.value || []));
    await wa.send(number.id, {
      to: normalizeNumber(customer.mobile), text, customerId: customer.id,
      sentBy: req.session.user.id, sentByName: req.session.user.login_id,
    });
    await auth.audit(req, 'whatsapp_send', `${customer.username} number=${number.id}`);
    answer('success', 'Message sent.');
  } catch (err) {
    answer('error', err.message);
  }
}));

/* ------------------------------ one conversation ------------------------------ */

// The conversation a message belongs to, if this person may see and answer it.
async function conversation(req, messageId) {
  const m = await db.row(
    `SELECT m.session_id, m.conversation_key FROM whatsapp_messages m WHERE m.id = $1`, [messageId]
  );
  if (!m) return null;
  const messages = (await db.rows(
    `${MESSAGE_SELECT} WHERE m.session_id = $1 AND m.conversation_key = $2
     ORDER BY m.message_at DESC, m.id DESC LIMIT ${PER_PAGE}`, [m.session_id, m.conversation_key]
  )).reverse();
  const last = [...messages].reverse().find((x) => x.customer_id);
  const customer = last ? await db.row('SELECT * FROM customers WHERE id = $1', [last.customer_id]) : null;
  const user = req.session.user;
  if (!isAdmin(req) && (!customer || customer.assigned_to !== user.id)) return null;
  const incoming = [...messages].reverse().find((x) => x.direction === 'in');
  return { sessionId: m.session_id, messages, customer, number: incoming?.number || null, hasReply: Boolean(incoming) };
}

router.get('/chat/:id', handle(async (req, res) => {
  const chat = await conversation(req, idOf(req.params.id));
  if (!chat) return res.status(404).render('error', { title: 'Not found', heading: 'Chat not found', message: 'It may belong to another caller.' });
  // A known customer has one chat page, whichever way it was opened.
  if (chat.customer) return res.redirect(`/whatsapp/customer/${encodeURIComponent(chat.customer.username)}`);
  const incoming = [...chat.messages].reverse().find((m) => m.direction === 'in' && m.number);
  res.render('whatsapp_chat', {
    title: 'WhatsApp chat', page: 'whatsapp', isAdmin: isAdmin(req), customer: null,
    mobileShown: chat.number ? C.maskMobile(chat.number) : 'number hidden by WhatsApp',
    messages: chat.messages.map(present), me: req.session.user.id,
    reply: incoming ? { id: incoming.id, ...(await db.row('SELECT label, status FROM whatsapp_sessions WHERE id = $1', [chat.sessionId])) } : null,
    optedOut: Boolean(chat.number && await db.value('SELECT 1 FROM whatsapp_opt_outs WHERE number = $1', [chat.number])),
  });
}));

router.post('/chat/:id', handle(async (req, res) => {
  const id = idOf(req.params.id);
  const chat = await conversation(req, id);
  const back = chat?.customer ? `/whatsapp/customer/${encodeURIComponent(chat.customer.username)}` : `/whatsapp/chat/${id}`;
  const answer = (type, message) => (wantsJson(req)
    ? res.json({ ok: type === 'success', message: res.locals._tm(message) })
    : done(req, res, type, message, chat ? back : '/whatsapp'));
  if (!chat) return answer('error', 'Chat not found.');
  try {
    // Free text only answers someone who wrote to us.
    if (!chat.hasReply || !chat.number) throw new Error('This chat cannot be answered from here.');
    if (chat.customer?.do_not_contact) throw new Error('This customer is marked "Do Not Contact".');
    const text = clean(req.body.text, 1000);
    if (!text) throw new Error('Write a reply first.');
    await wa.send(chat.sessionId, {
      to: chat.number, text, isReply: true, customerId: chat.customer?.id || null,
      sentBy: req.session.user.id, sentByName: req.session.user.login_id,
    });
    await auth.audit(req, 'whatsapp_reply', `chat=${id}`);
    answer('success', 'Reply sent.');
  } catch (err) {
    answer('error', err.message);
  }
}));

/* ------------------------------ numbers (Super Admin) ------------------------------ */

const admin = auth.requireSuperAdmin;
const NUMBERS = '/whatsapp/numbers';

router.get('/numbers', admin, handle(async (req, res) => {
  const numbers = await db.rows(
    `SELECT s.*, COALESCE(ARRAY_AGG(su.user_id) FILTER (WHERE su.user_id IS NOT NULL), '{}') AS user_ids,
            (s.restriction_active AND (s.restriction_until IS NULL OR s.restriction_until > NOW())) AS restricted_now,
            s.restriction_until::text AS until_text, s.restriction_checked_at::text AS checked_text,
            (SELECT COUNT(*)::int FROM whatsapp_messages m WHERE m.session_id = s.id AND m.direction = 'out'
               AND m.message_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS sent_today
       FROM whatsapp_sessions s LEFT JOIN whatsapp_session_users su ON su.session_id = s.id
      WHERE s.deleted_at IS NULL GROUP BY s.id ORDER BY s.id`
  );
  const refusals = await inbox.refusals();
  numbers.forEach((n) => { n.refusal = refusals.get(n.id); });
  res.render('whatsapp_numbers', {
    title: 'WhatsApp numbers', page: 'whatsapp', tab: 'numbers', isAdmin: true, numbers,
    users: await db.rows("SELECT id, name FROM users WHERE role <> 'super_admin' ORDER BY name"),
    optOuts: await db.rows('SELECT id, number, source, trigger_text FROM whatsapp_opt_outs ORDER BY id DESC LIMIT 200'),
    configured: Boolean(process.env.WA_INTERNAL_TOKEN),
  });
}));

const capOf = (v) => Math.min(Math.max(parseInt(v, 10) || 150, 1), 1000);

router.post('/numbers', admin, handle(async (req, res) => {
  const label = clean(req.body.label, 60);
  if (!label) return done(req, res, 'error', 'Give the number a name.', NUMBERS);
  await db.query('INSERT INTO whatsapp_sessions (label, daily_cap, created_by, updated_by) VALUES ($1,$2,$3,$3)',
    [label, capOf(req.body.daily_cap), req.session.user.id]);
  await auth.audit(req, 'whatsapp_number_add', label);
  done(req, res, 'success', 'Number added. Press "Link with QR" to connect a phone.', NUMBERS);
}));

router.post('/numbers/:id', admin, handle(async (req, res) => {
  const id = idOf(req.params.id);
  const label = clean(req.body.label, 60);
  const userIds = [].concat(req.body.user_id || []).map(idOf).filter(Boolean);
  if (!label) return done(req, res, 'error', 'Give the number a name.', NUMBERS);
  await db.tx(async (client) => {
    const found = await client.query(
      'UPDATE whatsapp_sessions SET label = $2, daily_cap = $3, updated_at = NOW(), updated_by = $4 WHERE id = $1 AND deleted_at IS NULL',
      [id, label, capOf(req.body.daily_cap), req.session.user.id]);
    if (!found.rowCount) return;
    await client.query('DELETE FROM whatsapp_session_users WHERE session_id = $1', [id]);
    await client.query(
      `INSERT INTO whatsapp_session_users (session_id, user_id, created_by, updated_by)
       SELECT $1, u.id, $3, $3 FROM users u WHERE u.id = ANY($2::int[])`, [id, userIds, req.session.user.id]);
  });
  await auth.audit(req, 'whatsapp_number_update', `id=${id} users=${userIds.join(',')}`);
  done(req, res, 'success', 'Saved.', NUMBERS);
}));

router.get('/numbers/:id/link', admin, handle(async (req, res) => {
  const number = await db.row('SELECT id, label FROM whatsapp_sessions WHERE id = $1 AND deleted_at IS NULL', [idOf(req.params.id)]);
  if (!number) return res.redirect(NUMBERS);
  res.render('whatsapp_link', { title: 'Link WhatsApp', page: 'whatsapp', number });
}));

// Polled by the link page.
router.get('/numbers/:id/state.json', admin, async (req, res) => {
  try {
    const s = await wa.state(idOf(req.params.id));
    res.set('Cache-Control', 'no-store');
    res.json({ status: s.status, image: s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 280 }) : null });
  } catch (err) {
    res.status(502).json({ status: 'error', message: err.message });
  }
});

router.post('/numbers/:id/connect', admin, handle(async (req, res) => {
  const id = idOf(req.params.id);
  try {
    const state = await wa.connect(id);
    await auth.audit(req, 'whatsapp_connect', `id=${id}`);
    if (state.status === 'connected') {
      return state.restrictionChecked
        ? done(req, res, 'success', 'Connected. The restriction status was updated.', NUMBERS)
        : done(req, res, 'error', 'Connected, but WhatsApp did not answer the restriction check.', NUMBERS);
    }
    res.redirect(`${NUMBERS}/${id}/link`);
  } catch (err) {
    done(req, res, 'error', err.message, NUMBERS);
  }
}));

router.post('/numbers/:id/logout', admin, handle(async (req, res) => {
  const id = idOf(req.params.id);
  try {
    const r = await wa.logout(id);
    await auth.audit(req, 'whatsapp_logout', `id=${id}`);
    done(req, res, 'success', r.unlinkedOnPhone ? 'Logged out.' : 'Login removed here. Also remove it under "Linked devices" on the phone.', NUMBERS);
  } catch (err) {
    done(req, res, 'error', err.message, NUMBERS);
  }
}));

// History is kept, so a number is hidden rather than erased.
router.post('/numbers/:id/delete', admin, handle(async (req, res) => {
  const id = idOf(req.params.id);
  const status = await db.value('SELECT status FROM whatsapp_sessions WHERE id = $1', [id]);
  if (status === 'connected') return done(req, res, 'error', 'Log the phone out before removing the number.', NUMBERS);
  try {
    await wa.logout(id);
  } catch (err) {
    return done(req, res, 'error', `Not removed: ${err.message}`, NUMBERS);
  }
  await db.query('UPDATE whatsapp_sessions SET deleted_at = NOW(), updated_by = $2 WHERE id = $1', [id, req.session.user.id]);
  await db.query('DELETE FROM whatsapp_session_users WHERE session_id = $1', [id]);
  await auth.audit(req, 'whatsapp_number_delete', `id=${id}`);
  done(req, res, 'success', 'Number removed.', NUMBERS);
}));

router.post('/opt-outs', admin, handle(async (req, res) => {
  const number = normalizeNumber(req.body.number);
  if (!/^\d{8,15}$/.test(number)) return done(req, res, 'error', 'Enter a full mobile number.', NUMBERS);
  await db.query(
    `INSERT INTO whatsapp_opt_outs (number, source, created_by, updated_by) VALUES ($1,'manual',$2,$2)
     ON CONFLICT (number) DO NOTHING`, [number, req.session.user.id]);
  await auth.audit(req, 'whatsapp_optout_add', C.maskMobile(number));
  done(req, res, 'success', 'Added to the do-not-contact list.', NUMBERS);
}));

router.post('/opt-outs/:id/delete', admin, handle(async (req, res) => {
  await db.query('DELETE FROM whatsapp_opt_outs WHERE id = $1', [idOf(req.params.id)]);
  await auth.audit(req, 'whatsapp_optout_remove', `id=${req.params.id}`);
  done(req, res, 'success', 'Removed from the list.', NUMBERS);
}));

/* ------------------------------ templates (Super Admin) ------------------------------ */

const TEMPLATES = '/whatsapp/templates';

router.get('/templates', admin, handle(async (req, res) => {
  res.render('whatsapp_templates', {
    title: 'WhatsApp templates', page: 'whatsapp', tab: 'templates', isAdmin: true,
    templates: await db.rows('SELECT * FROM whatsapp_templates ORDER BY name, language'),
  });
}));

router.post(['/templates', '/templates/:id'], admin, handle(async (req, res) => {
  const name = clean(req.body.name, 60);
  const body = clean(req.body.body, 1000);
  const language = req.body.language === 'hi' ? 'hi' : 'en';
  if (!name || !body) return done(req, res, 'error', 'A template needs a name and a message.', TEMPLATES);
  try {
    if (req.params.id) {
      await db.query(
        `UPDATE whatsapp_templates SET name=$2, language=$3, body=$4, is_active=$5, updated_at=NOW(), updated_by=$6 WHERE id=$1`,
        [idOf(req.params.id), name, language, body, req.body.is_active === '1', req.session.user.id]);
    } else {
      await db.query(
        'INSERT INTO whatsapp_templates (name, language, body, created_by, updated_by) VALUES ($1,$2,$3,$4,$4)',
        [name, language, body, req.session.user.id]);
    }
  } catch (err) {
    if (err.code !== '23505') throw err;
    return done(req, res, 'error', 'A template with this name and language already exists.', TEMPLATES);
  }
  await auth.audit(req, 'whatsapp_template_save', `${name} (${language})`);
  done(req, res, 'success', 'Template saved.', TEMPLATES);
}));

router.post('/templates/:id/delete', admin, handle(async (req, res) => {
  await db.query('DELETE FROM whatsapp_templates WHERE id = $1', [idOf(req.params.id)]);
  await auth.audit(req, 'whatsapp_template_delete', `id=${req.params.id}`);
  done(req, res, 'success', 'Template removed.', TEMPLATES);
}));

module.exports = router;
