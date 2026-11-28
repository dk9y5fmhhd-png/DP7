'use strict';

/* TeleCMI + WhatsApp end to end, with a mock TeleCMI server and a stand-in for
   the WhatsApp library, so nothing leaves this machine.
   Run on an EMPTY test database: DATABASE_URL=... npm run test:integrations */

const WEB = 3611, WAP = 3612, TCP = 3613;
Object.assign(process.env, {
  PORT: String(WEB), SEED_ADMIN_PASSWORD: 'admin123',
  TELECMI_API_BASE: `http://127.0.0.1:${TCP}`, WA_SERVICE_URL: `http://127.0.0.1:${WAP}`,
  SERVER_PUBLIC_IP: '203.0.113.7', WA_INTERNAL_TOKEN: 't'.repeat(40), CREDENTIALS_ENCRYPTION_KEY: 'k'.repeat(40),
});
require('dotenv').config();

const http = require('http');
const { EventEmitter } = require('events');
const bcrypt = require('bcryptjs');

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- mock TeleCMI ---- */
const tc = { calls: [], answer: { code: 200, msg: 'Call initiated', request_id: 'REQ-1' } };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    tc.calls.push({ path: req.url, json });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v2/user/login') return res.end(JSON.stringify(json.password === 'agent-pass' ? { token: 'tok' } : { code: 401 }));
    if (req.url === '/v3/contact/add') return res.end(JSON.stringify({ code: 200 }));
    res.end(JSON.stringify(tc.answer));
  });
});

/* ---- stand-in WhatsApp socket ---- */
const wa = { sockets: [], sent: [], n: 0, beforeReturn: null, lock: { isActive: false, enforcementType: 'DEFAULT' } };
async function fakeBaileys() {
  const real = await import('@whiskeysockets/baileys');
  return {
    initAuthCreds: real.initAuthCreds, BufferJSON: real.BufferJSON, proto: real.proto, Browsers: real.Browsers,
    DisconnectReason: real.DisconnectReason, normalizeMessageContent: real.normalizeMessageContent, toNumber: Number,
    fetchLatestBaileysVersion: async () => ({ version: [1, 0, 0] }),
    makeCacheableSignalKeyStore: (k) => k,
    makeWASocket: ({ auth }) => {
      const sock = {
        ev: new EventEmitter(), auth, user: { id: '919000000000:1@s.whatsapp.net' },
        end() {}, async logout() {}, signalRepository: { lidMapping: { getPNForLID: async () => null } },
        async onWhatsApp(jid) { return [{ jid, exists: true }]; },
        async fetchAccountReachoutTimelock() { if (wa.lock instanceof Error) throw wa.lock; return wa.lock; },
        async sendMessage(jid, msg) {
          wa.sent.push({ jid, text: msg.text });
          const key = { id: `MSG-${++wa.n}`, fromMe: true, remoteJid: jid };
          if (wa.beforeReturn) await wa.beforeReturn(sock, key);
          return { key };
        },
      };
      wa.sockets.push(sock);
      return sock;
    },
  };
}

function client() {
  const jar = new Map();
  const c = {
    async req(p, o = {}) {
      const headers = { ...(o.headers || {}) };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await fetch(`http://127.0.0.1:${WEB}${p}`, { ...o, headers, redirect: 'manual' });
      for (const s of r.headers.getSetCookie()) { const [a] = s.split(';'); const i = a.indexOf('='); jar.set(a.slice(0, i), a.slice(i + 1)); }
      return { status: r.status, text: await r.text(), location: r.headers.get('location') };
    },
    token: null,
    async post(p, fields = {}) {
      const body = new URLSearchParams({ csrf_token: c.token });
      for (const [k, v] of Object.entries(fields)) [].concat(v).forEach((x) => body.append(k, x));
      return c.req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    },
    // post, then return the page that shows the resulting message
    async flash(p, fields, then = '/security') { await c.post(p, fields); return (await c.req(then)).text; },
    async login(id, password) {
      c.token = (await c.req('/login')).text.match(/name="csrf_token" value="([^"]+)"/)[1];
      await c.post('/login', { login_id: id, password });
      c.token = (await c.req('/security')).text.match(/name="csrf_token" value="([^"]+)"/)[1];
    },
  };
  return c;
}

(async () => {
  await new Promise((r) => mock.listen(TCP, '127.0.0.1', r));
  const db = require('../src/db');
  require('../src/server');
  for (let i = 0; i < 100; i++) {
    await wait(200);
    if (await db.value("SELECT 1 FROM information_schema.tables WHERE table_name='whatsapp_opt_outs'").catch(() => 0)
      && await db.value("SELECT 1 FROM users WHERE login_id='admin'").catch(() => 0)) break;
  }
  await wait(500);

  const { WhatsappService } = require('../src/wa/service');
  const { createApp } = require('../src/wa/app');
  const service = new WhatsappService({ loadBaileys: fakeBaileys, minGapMs: 0, maxGapMs: 0 });
  const waServer = createApp({ service, token: process.env.WA_INTERNAL_TOKEN, isReady: () => true }).listen(WAP, '127.0.0.1');

  const hash = await bcrypt.hash('caller123', 10);
  const user = async (login) => db.value(
    `INSERT INTO users (name, login_id, password_hash, role, page_access, require_approval)
     VALUES ($1,$1,$2,'admin','{mycalls,customers,whatsapp,followups}',FALSE) RETURNING id`, [login, hash]);
  const ownerId = await user('owner1');
  await user('other1');
  const customer = async (name, mobile, assigned) => db.value(
    `INSERT INTO customers (username, mobile, assigned_to, status) VALUES ($1,$2,$3,'inactive') RETURNING id`, [name, mobile, assigned]);
  const custId = await customer('IntCust1', '9876500001', ownerId);
  await customer('IntDnc1', '9876500002', ownerId);
  await db.query("UPDATE customers SET do_not_contact = TRUE WHERE username = 'IntDnc1'");

  const admin = client(); await admin.login('admin', 'admin123');
  const owner = client(); await owner.login('owner1', 'caller123');
  const other = client(); await other.login('other1', 'caller123');

  console.log('--- TeleCMI');
  let text;
  await admin.post('/settings/calling/accounts', { label: 'Main', app_id: '1111112', secret: 'SECRET-XYZ' });
  let page = (await admin.req('/settings/calling')).text;
  const hook = (page.match(/\/telecmi\/webhook\/[a-f0-9]{48}/) || [])[0];
  check('account saved, webhook address shown', !!hook);
  check('same webhook address every time', (await admin.req('/settings/calling')).text.includes(hook));
  check('server IP shown for whitelisting', page.includes('203.0.113.7'));
  check('secret never shown, only its end', !page.includes('SECRET-XYZ') && page.includes('••••-XYZ'));
  await admin.post('/settings/calling/accounts', { label: 'Second', app_id: '2222223', secret: 'OTHER-SECRET' });
  check('one address serves every account', ((await admin.req('/settings/calling')).text.match(/\/telecmi\/webhook\/[a-f0-9]{48}/g) || []).every((u) => u === hook));
  tc.answer = { code: 200 };
  text = await admin.flash(`/settings/calling/accounts/${await db.value("SELECT id FROM telecmi_accounts WHERE app_id='1111112'")}/test`, {}, '/settings/calling');
  check('account test asks TeleCMI', /accepted the App ID/.test(text) && tc.calls.at(-1).path === '/v2/balance' && tc.calls.at(-1).json.appid === 1111112);
  text = await admin.flash(`/settings/calling/accounts/${await db.value("SELECT id FROM telecmi_accounts WHERE app_id='1111112'")}/delete`, {}, '/settings/calling');
  check('an active account cannot be removed', /Switch the account off/.test(text));
  tc.answer = { code: 200, msg: 'Call initiated', request_id: 'REQ-1' };
  const stored = await db.row("SELECT * FROM telecmi_accounts WHERE app_id = '1111112'");
  check('secret stored encrypted', stored.secret_enc.startsWith('v1:') && !stored.secret_enc.includes('SECRET'));
  check('caller cannot open calling settings', (await owner.req('/settings/calling')).status === 403);

  text = await owner.flash('/calls/call', { username: 'IntCust1' });
  check('no agent ID: clear message', /agent ID is not set/.test(text));
  await admin.post(`/users/${ownerId}/telecmi`, { telecmi_agent_id: '5001_1111112', telecmi_password: 'agent-pass' });
  const tried = JSON.parse((await admin.post('/users/telecmi-test', { user_id: String(ownerId), telecmi_agent_id: '5001_1111112', telecmi_password: '' })).text);
  check('test login accepted with the saved password', tried.ok && /5001_1111112/.test(tried.message));
  const changed = JSON.parse((await admin.post('/users/telecmi-test', { user_id: String(ownerId), telecmi_agent_id: '5002_1111112', telecmi_password: '' })).text);
  check('saved password is not tried on another ID', !changed.ok);
  await admin.post(`/users/${ownerId}/telecmi`, { telecmi_agent_id: '5001_1111112', telecmi_password: '' });
  check('blank password keeps the saved one', !!(await db.value('SELECT telecmi_password_enc FROM users WHERE id=$1', [ownerId])));
  await admin.post(`/users/${await db.value("SELECT id FROM users WHERE login_id='other1'")}/telecmi`, { telecmi_agent_id: '5001_1111112', telecmi_password: '' });
  const usersPage = (await admin.req('/users')).text;
  check('Users page shows account and shared ID', usersPage.includes('5001_1111112') && /Same ID as (owner1|other1)/.test(usersPage) && usersPage.includes('Main'));
  await admin.post(`/users/${ownerId}/update`, { name: 'owner1', role: 'admin', page_access: ['mycalls', 'customers', 'whatsapp', 'followups'] });
  check('editing a user without TeleCMI fields keeps the ID', (await db.value('SELECT telecmi_agent_id FROM users WHERE id=$1', [ownerId])) === '5001_1111112');
  await admin.post('/users/create', { name: 'New Agent', login_id: 'agent9', password: 'agent999', role: 'admin', telecmi_agent_id: '5009_1111112' });
  check('agent ID set while creating a user', (await db.value("SELECT telecmi_agent_id FROM users WHERE login_id='agent9'")) === '5009_1111112');
  check('caller cannot test logins', (await owner.post('/users/telecmi-test', { telecmi_agent_id: '1', telecmi_password: 'x' })).status === 403);

  tc.calls.length = 0;
  text = await owner.flash('/calls/call', { username: 'IntCust1' });
  const dial = tc.calls.find((c) => c.path === '/v2/webrtc/click2call');
  check('own customer: call placed', /Call placed/.test(text));
  check('correct TeleCMI payload', dial && dial.json.user_id === '5001_1111112' && dial.json.secret === 'SECRET-XYZ' && dial.json.to === 919876500001 && dial.json.webrtc === true && dial.json.followme === false);
  check('number not shown to caller', !text.includes('9876500001'));
  check('contact saved first', tc.calls.some((c) => c.path === '/v3/contact/add'));

  tc.calls.length = 0;
  text = await other.flash('/calls/call', { username: 'IntCust1' });
  check("another caller's customer refused", /not assigned to you/.test(text) && tc.calls.length === 0 && !text.includes('9876500001'));
  text = await owner.flash('/calls/call', { username: 'IntDnc1' });
  check('Do Not Contact refused', /Do Not Contact/.test(text) && tc.calls.length === 0);

  await other.post('/calling/remark', { username: 'IntCust1', action_type: 'Interested' });
  await other.post('/followups', { username: 'IntCust1', action_type: 'Do Not Contact' });
  check("another caller cannot add remarks", (await db.value("SELECT COUNT(*)::int FROM followups WHERE username='IntCust1'")) === 0
    && !(await db.value('SELECT do_not_contact FROM customers WHERE id=$1', [custId])));
  await owner.post('/calling/remark', { username: 'IntCust1', action_type: 'Interested' });
  check('owner can add a remark', (await db.value("SELECT COUNT(*)::int FROM followups WHERE username='IntCust1'")) === 1);

  tc.answer = { code: 407, msg: 'bad secret SECRET-XYZ' };
  text = await owner.flash('/calls/call', { username: 'IntCust1' });
  const bad = await db.row("SELECT * FROM calls WHERE status='failed' ORDER BY id DESC LIMIT 1");
  check('refusal reported and logged without secret', /did not accept the app secret/.test(text) && bad && !bad.note.includes('SECRET-XYZ'));
  tc.answer = { code: 200, request_id: 'REQ-1' };

  const send = (url, body) => fetch(`http://127.0.0.1:${WEB}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  check('webhook wrong token 404', (await send('/telecmi/webhook/nope', { type: 'cdr' })).status === 404);
  check('webhook bad body 400', (await send(hook, '{oops')).status === 400);
  check('webhook large body refused', (await send(hook, { x: 'a'.repeat(70000) })).status === 413);
  await send(hook, { type: 'cdr', request_id: 'REQ-1', status: 'answered', answeredsec: 42, hangup_reason: 'NORMAL', filename: 'rec1.mp3' });
  await send(hook, { type: 'cdr', request_id: 'REQ-1', status: 'missed', answeredsec: 0 });
  const done = await db.row("SELECT * FROM calls WHERE provider_ref='REQ-1' ORDER BY id DESC LIMIT 1");
  check('call record saved from webhook', done.status === 'answered' && done.duration_sec === 42 && done.recording_url === 'rec1.mp3');
  await db.query("UPDATE calls SET provider_ref = 'OTHER', status='initiated', duration_sec=0 WHERE id=$1", [done.id]);
  await send(hook, { type: 'cdr', user: '5001_1111112', to: 919876500001, direction: 'outbound', status: 'answered', answeredsec: 7 });
  check('call matched by agent + number', (await db.value('SELECT duration_sec FROM calls WHERE id=$1', [done.id])) === 7);

  const fd = new FormData(); fd.append('x', '1');
  check('multipart cannot skip CSRF', (await admin.req(`/settings/calling/accounts/${stored.id}/delete`, { method: 'POST', body: fd })).status === 403);
  const exp = (await admin.req('/backup/export/settings')).text;
  check('settings export has no secrets', !/delete_pin|telecmi_|SECRET-XYZ/.test(exp));

  console.log('--- WhatsApp');
  await admin.post('/whatsapp/numbers', { label: 'Retention 1', daily_cap: '3' });
  const sid = await db.value('SELECT id FROM whatsapp_sessions');
  await admin.post(`/whatsapp/numbers/${sid}`, { label: 'Retention 1', daily_cap: '3', user_id: String(ownerId) });
  await admin.post('/whatsapp/templates', { name: 'Hello', language: 'en', body: 'Hello {1}' });
  await admin.post('/whatsapp/templates', { name: 'Hello', language: 'hi', body: 'नमस्ते {1}' });
  const tid = await db.value("SELECT id FROM whatsapp_templates WHERE language='en'");
  check('caller cannot manage numbers', (await owner.req('/whatsapp/numbers')).status === 403);
  check('wa service refuses without token', (await fetch(`http://127.0.0.1:${WAP}/internal/sessions/${sid}`)).status === 401);

  await admin.post(`/whatsapp/numbers/${sid}/connect`);
  const sock = wa.sockets.at(-1);
  sock.ev.emit('connection.update', { qr: 'test-qr-string' }); await wait(200);
  const st = JSON.parse((await admin.req(`/whatsapp/numbers/${sid}/state.json`)).text);
  check('QR shown as image', st.status === 'qr' && String(st.image).startsWith('data:image/png'));
  sock.auth.creds.me = { id: sock.user.id };
  sock.ev.emit('creds.update'); sock.ev.emit('connection.update', { connection: 'open' }); await wait(300);
  check('number connected', (await db.value('SELECT status FROM whatsapp_sessions WHERE id=$1', [sid])) === 'connected');
  const key = await db.value("SELECT value FROM whatsapp_auth_keys WHERE key='creds'");
  check('login stored encrypted', key && key.startsWith('v1:') && !key.includes('noiseKey'));
  await sock.auth.keys.set({ 'pre-key': { 7: { public: Buffer.from('a'), private: Buffer.from('b') } } });
  const got = await sock.auth.keys.get('pre-key', ['7', '8']);
  check('signal keys round-trip', Buffer.from(got['7'].private).toString() === 'b' && got['8'] === null);

  const chatPage = (await owner.req('/whatsapp/customer/IntCust1')).text;
  check('send page: number masked', chatPage.includes('98******01') && !chatPage.includes('9876500001'));
  check("another caller's customer page refused", (await other.req('/whatsapp/customer/IntCust1')).status === 403);
  const sendForm = { session_id: String(sid), template_id: String(tid), value: 'Ravi' };
  text = await owner.flash('/whatsapp/customer/IntCust1', sendForm, '/whatsapp/customer/IntCust1');
  check('template sent', /Message sent/.test(text) && wa.sent.at(-1)?.text === 'Hello Ravi' && wa.sent.at(-1)?.jid === '919876500001@s.whatsapp.net');
  text = await owner.flash('/whatsapp/customer/IntCust1', sendForm);
  check('same message twice refused', /already went to this contact/.test(text) && wa.sent.length === 1);
  await other.post('/whatsapp/customer/IntCust1', sendForm);
  check('other caller cannot send', wa.sent.length === 1);
  text = await owner.flash('/whatsapp/customer/IntDnc1', sendForm);
  check('Do Not Contact cannot be messaged', /Do Not Contact/.test(text) && wa.sent.length === 1);

  sock.ev.emit('messages.update', [{ key: { id: 'MSG-1' }, update: { status: 4 } }]);
  sock.ev.emit('messages.update', [{ key: { id: 'MSG-1' }, update: { status: 2 } }]); await wait(200);
  check('delivery status only moves up', (await db.value("SELECT delivery_status FROM whatsapp_messages WHERE provider_message_id='MSG-1'")) === 4);

  const incoming = (id, body) => ({ type: 'notify', messages: [{ key: { remoteJid: '919876500001@s.whatsapp.net', id }, message: { conversation: body }, messageTimestamp: Math.ceil(Date.now() / 1000) }] });
  sock.ev.emit('messages.upsert', incoming('IN-1', 'yes please')); await wait(300);
  sock.ev.emit('messages.upsert', incoming('IN-1', 'yes please')); await wait(200);
  check('reply stored once, linked to customer', (await db.value("SELECT COUNT(*)::int FROM whatsapp_messages WHERE provider_message_id='IN-1' AND customer_id=$1", [custId])) === 1);
  const inbox = (await owner.req('/whatsapp')).text;
  const chat = (inbox.match(/\/whatsapp\/chat\/(\d+)/) || [])[1];
  check('inbox shows reply to owner, number hidden', inbox.includes('yes please') && !inbox.includes('9876500001'));
  check('other caller sees nothing', !(await other.req('/whatsapp')).text.includes('yes please') && (await other.req(`/whatsapp/chat/${chat}`)).status === 404);
  check('history page opens', (await owner.req('/whatsapp/history')).status === 200);
  const custUrl = '/whatsapp/customer/IntCust1';
  check('inbox chat opens the customer chat', (await owner.req(`/whatsapp/chat/${chat}`)).location === custUrl);
  const same = async () => [(await owner.req(custUrl)).text, (await owner.req(`${custUrl}/dialog`)).text];
  await db.query('DELETE FROM whatsapp_session_users');
  check('chat page and pop-up both offer a reply, even with no number assigned', (await same()).every((h) => h.includes('class="wa-reply"') && !h.includes('To start a chat you need')));
  await db.query('INSERT INTO whatsapp_session_users (session_id, user_id) VALUES ($1,$2)', [sid, ownerId]);
  check('with a number assigned, both offer reply and template', (await same()).every((h) => h.includes('class="wa-reply"') && h.includes('class="wa-send"')));
  const json = await fetch(`http://127.0.0.1:${WEB}/whatsapp/chat/0`, { method: 'POST', headers: { accept: 'application/json' } });
  check('reply without a token refused', json.status === 403);
  text = await owner.flash(`/whatsapp/chat/${chat}`, { text: 'Thank you' }, custUrl);
  check('reply sent', /Reply sent/.test(text) && wa.sent.at(-1).text === 'Thank you');

  check('inbox search and needs-reply filter', (await owner.req('/whatsapp?q=yes+please')).text.includes('/whatsapp/chat/') && !(await owner.req('/whatsapp?q=nothing-like-this')).text.includes('/whatsapp/chat/') && (await owner.req('/whatsapp?needs=1&staff=999')).status === 200);
  check('history filters', (await owner.req('/whatsapp/history?direction=in&q=yes')).text.includes('yes please'));
  await db.query('DELETE FROM whatsapp_session_users');
  text = await owner.flash(`/whatsapp/chat/${chat}`, { text: 'Anything else?' });
  check('reply still works after the number is unassigned', /Reply sent/.test(text));
  text = await owner.flash(`/whatsapp/chat/${chat}`, { text: 'One more' });
  check('daily limit enforced', /Daily limit reached/.test(text) && wa.sent.length === 3);
  await db.query('UPDATE whatsapp_sessions SET daily_cap = 100 WHERE id = $1', [sid]);
  sock.ev.emit('messages.upsert', incoming('IN-2', 'STOP')); await wait(300);
  check('STOP adds to do-not-contact', (await db.value("SELECT source FROM whatsapp_opt_outs WHERE number='919876500001'")) === 'reply');
  text = await owner.flash(`/whatsapp/chat/${chat}`, { text: 'hello?' });
  check('opted-out contact cannot be messaged', /do-not-contact list/.test(text) && wa.sent.length === 3);

  const row = (messageId) => db.row('SELECT delivery_status, delivery_error FROM whatsapp_messages WHERE provider_message_id = $1', [messageId]);
  const refusal = { status: 0, messageStubParameters: ['463'] };
  const sendDirect = (body) => service.sendText(Number(sid), { to: '9876500009', text: body, isReply: true });
  wa.beforeReturn = async (s, key) => { s.ev.emit('messages.update', [{ key, update: refusal }]); await wait(150); };
  let out = await sendDirect('refused before it was saved');
  wa.beforeReturn = null;
  let saved = await row(out.messageId);
  check('a refusal that arrives before the message is saved shows', saved.delivery_status === 0 && saved.delivery_error === '463');
  out = await sendDirect('refused inside the echo');
  sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { id: out.messageId, fromMe: true }, ...refusal }] });
  await wait(300);
  saved = await row(out.messageId);
  check('a refusal folded into our own message shows', saved.delivery_status === 0 && saved.delivery_error === '463');
  out = await sendDirect('plain echo');
  sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { id: out.messageId, fromMe: true }, status: 0, messageStubParameters: [] }] });
  await wait(300);
  check('an ordinary echo is not read as a refusal', (await row(out.messageId)).delivery_status === 1);

  const failedHistory = (await admin.req('/whatsapp/history')).text;
  check('history says why a message failed', failedHistory.includes('Refused: can'));
  const banner = async () => (await admin.req('/whatsapp/numbers')).text;
  check('one refused contact raises no alarm', !(await banner()).includes('Start chats') && !(await banner()).includes('cannot start new chats'));
  for (const n of ['919876500021', '919876500022']) {
    await db.query(`INSERT INTO whatsapp_messages (session_id, direction, remote_jid, number, conversation_key, body, provider_message_id, delivery_status, delivery_error, message_at)
      VALUES ($1,'out','x',$2,$2,'hi',$2,0,'463',NOW())`, [sid, n]);
  }
  const warned = await banner();
  check('three refused contacts warn the Super Admin', warned.includes('cannot start new chats right now') && /Can(&#39;|')t start chats/.test(warned));
  await db.query('INSERT INTO whatsapp_opt_outs (number, source) VALUES ($1, $2)', ['919876500033', 'manual']);
  const screens = [];
  for (const p of ['/', '/customers', '/customers/IntCust1', '/calling', '/calling/my?all=1', '/followups', '/assign', '/new-clients', '/reports', '/whatsapp', '/whatsapp/history', '/whatsapp/numbers', '/whatsapp/customer/IntCust1', '/whatsapp/customer/IntCust1/dialog']) {
    if (/(91)?9876500\d{3}/.test((await admin.req(p)).text)) screens.push(p);
  }
  check('Super Admin never sees a whole number', !screens.length, screens.join(', '));
  check('masked like Ringline', require('../src/lib/customers').maskMobile('9876500001') === '98******01');

  const press = () => admin.flash(`/whatsapp/numbers/${sid}/connect`, {}, '/whatsapp/numbers');
  wa.lock = { isActive: true, timeEnforcementEnds: new Date(Date.now() + 3_600_000), enforcementType: 'WEB_COMPANION_ONLY' };
  let said = await press();
  let card = await banner();
  check('a restriction from WhatsApp shows on the number', /status was updated/.test(said) && card.includes('restricting this number from starting new chats until') && card.includes('WEB_COMPANION_ONLY'));
  wa.lock = new Error('timed out');
  said = await press();
  check('an unanswered check keeps the last answer', /did not answer/.test(said) && (await banner()).includes('restricting this number'));
  wa.lock = { isActive: false, enforcementType: 'DEFAULT' };
  await press();
  card = await banner();
  check('a lifted restriction clears', card.includes('reports no current restriction') && !card.includes('restricting this number'));
  sock.ev.emit('connection.update', { reachoutTimeLock: { isActive: true, enforcementType: 'DEFAULT' } });
  await wait(300);
  check('an announced restriction is recorded', (await db.value('SELECT restriction_active FROM whatsapp_sessions WHERE id = $1', [sid])) === true);
  wa.lock = { isActive: false, enforcementType: 'DEFAULT' };
  await sendDirect('refusal triggers a check');
  sock.ev.emit('messages.update', [{ key: { id: `MSG-${wa.n}`, fromMe: true }, update: refusal }]);
  await wait(300);
  check('a 463 refusal asks WhatsApp again', (await db.value('SELECT restriction_active FROM whatsapp_sessions WHERE id = $1', [sid])) === false);

  const printed = [];
  const catcher = {};
  for (const level of ['log', 'info', 'warn', 'error']) catcher[level] = (...a) => printed.push(a);
  require('../src/wa/quiet-libsignal').install(catcher);
  const keys = { _chains: {}, currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('secret') } }, indexInfo: {} };
  catcher.info('Closing session:', keys);
  catcher.warn('Session already closed', keys);
  catcher.info('Removing old closed session:', keys);
  catcher.log('ordinary line', { a: 1 });
  check('session keys are not printed', printed.length === 4 && !require('util').inspect(printed, { depth: 9 }).includes('privKey') && printed[0][0] === 'Closing session:' && printed[3][1].a === 1);

  for (const p of ['/whatsapp/numbers', '/whatsapp/templates', `/whatsapp/numbers/${sid}/link`, '/settings', '/calls', '/calling', `/customers/IntCust1`]) {
    check(`page opens ${p}`, (await admin.req(p)).status === 200);
  }
  // A form inside a form is dropped by the browser: its button then submits the outer one.
  const nested = [];
  for (const p of ['/', '/customers', '/customers/IntCust1', '/calling', '/calling/my?all=1', '/calls', '/upload', '/add-data', '/reports', '/followups', '/cadence', '/assign', '/callers', '/approvals', '/backup', '/users', '/settings', '/settings/calling', '/security', '/whatsapp', '/whatsapp/history', '/whatsapp/numbers', '/whatsapp/templates', '/new-clients']) {
    let depth = 0;
    for (const m of (await admin.req(p)).text.matchAll(/<form\b|<\/form>/g)) {
      depth += m[0] === '</form>' ? -1 : 1;
      if (depth > 1 || depth < 0) { nested.push(p); break; }
    }
  }
  check('no page has a form inside a form', !nested.length, nested.join(', '));
  const expired = await fetch(`http://127.0.0.1:${WEB}/language`, { method: 'POST', redirect: 'manual', headers: { accept: 'text/html', referer: `http://127.0.0.1:${WEB}/calling`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf_token=old' });
  check('an out-of-date browser form goes back to its page', expired.status === 303 && ['/calling', '/login'].includes(expired.headers.get('location')));
  const mine = (await owner.req('/calling/my?all=1')).text;
  check('WhatsApp is out of the menu, inbox reachable from My Calls', !/class="nav-item[^"]*" href="\/whatsapp"/.test(mine) && mine.includes('href="/whatsapp"'));
  const detail = (await admin.req('/customers/IntCust1')).text;
  check('Call and WhatsApp open as pop-ups', detail.includes('data-dial="IntCust1"') && /href="\/whatsapp\/customer\/IntCust1" data-wa/.test(detail));
  const popup = await owner.req('/whatsapp/customer/IntCust1/dialog');
  check('send pop-up is a fragment with the number masked', popup.status === 200 && !popup.text.includes('<html') && !popup.text.includes('9876500001'));
  check("pop-up refused for another caller's customer", (await other.req('/whatsapp/customer/IntCust1/dialog')).status === 403);
  const asJson = await fetch(`http://127.0.0.1:${WEB}/language`, { headers: { accept: 'application/json' } });
  check('server still answers', asJson.status === 404);

  text = await admin.flash(`/whatsapp/numbers/${sid}/delete`, {}, '/whatsapp/numbers');
  check('a connected number must be logged out first', /Log the phone out/.test(text));
  await admin.post(`/whatsapp/numbers/${sid}/logout`);
  check('Super Admin warned about an unlinked number', (await admin.req('/')).text.includes('was unlinked from its phone'));
  await admin.post(`/whatsapp/numbers/${sid}/delete`);
  check('removing a number keeps history, drops login', (await db.value('SELECT COUNT(*)::int FROM whatsapp_auth_keys')) === 0
    && (await db.value('SELECT COUNT(*)::int FROM whatsapp_messages')) > 0);

  service.shutdown(); waServer.close(); mock.close();
  const fail = results.filter((r) => !r).length;
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
