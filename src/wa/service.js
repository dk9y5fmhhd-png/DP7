'use strict';

// Owns the WhatsApp sockets: linking, sending, receiving, delivery status.
// Ported from Ringline's whatsapp-web.service.ts.

const pino = require('pino');
const db = require('../db');
const { normalizeNumber, maskNumber } = require('../lib/phone');
const { isOptOutMessage } = require('./opt-out');
const { NO_CONFIRMATION, STALE_PENDING_MINUTES } = require('./delivery-error');
const { useDbAuthState, deleteSessionAuth } = require('./auth-state');

const MAX_PENDING_SENDS = 5;
const REMEMBERED_UPDATES = 200;
const RESTRICTION_TIMEOUT_MS = 8_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
// 'qr' is left out: a session only showing a QR was never linked.
const RESUME = ['connected', 'connecting', 'reconnecting'];

class WaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digitsOf = (jid) => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');

// A number is blocked if it opted out, or any customer with it is Do Not Contact.
async function blockedReason(number) {
  if (await db.value('SELECT 1 FROM whatsapp_opt_outs WHERE number = $1', [number])) {
    return 'This contact is on the WhatsApp do-not-contact list.';
  }
  const dnc = await db.value(
    `SELECT 1 FROM customers WHERE do_not_contact
       AND RIGHT(regexp_replace(mobile, '\\D', '', 'g'), 10) = RIGHT($1, 10) LIMIT 1`,
    [number]
  );
  return dnc ? 'This customer is marked "Do Not Contact".' : null;
}

// What to store for an incoming message, or null for protocol noise.
function describeContent(c) {
  if (!c || c.protocolMessage || c.senderKeyDistributionMessage || c.reactionMessage) return null;
  const text = (body, mediaType = null) => ({ body: body ?? null, mediaType });
  if (typeof c.conversation === 'string') return text(c.conversation);
  if (c.extendedTextMessage) return text(c.extendedTextMessage.text);
  if (c.imageMessage) return text(c.imageMessage.caption, 'image');
  if (c.videoMessage) return text(c.videoMessage.caption, 'video');
  if (c.audioMessage) return text(null, 'audio');
  if (c.documentMessage) return text(c.documentMessage.caption ?? c.documentMessage.fileName, 'document');
  if (c.stickerMessage) return text(null, 'sticker');
  if (c.buttonsResponseMessage) return text(c.buttonsResponseMessage.selectedDisplayText);
  if (c.listResponseMessage) return text(c.listResponseMessage.title);
  return text(null, 'other');
}

class WhatsappService {
  // loadBaileys is injectable so tests can run without contacting WhatsApp.
  constructor({ loadBaileys = () => import('@whiskeysockets/baileys'), minGapMs = 3_000, maxGapMs = 8_000 } = {}) {
    this.loadBaileys = loadBaileys;
    this.minGapMs = minGapMs;
    this.maxGapMs = maxGapMs;
    this.live = new Map();
    this.attempts = new Map();
    this.timers = new Map();
    this.queues = new Map();
    this.pending = new Map();
    this.lastSentAt = new Map();
    this.recentUpdates = new Map();
    this.sweepTimer = null;
    this.logger = pino({ level: 'warn' });
  }

  async init() {
    await this.sweepStale();
    this.sweepTimer = setInterval(() => this.sweepStale(), 60_000);
    this.sweepTimer.unref();
    const rows = await db.rows(
      'SELECT id FROM whatsapp_sessions WHERE deleted_at IS NULL AND status = ANY($1::text[])', [RESUME]
    );
    console.log(`[wa] resuming ${rows.length} session(s)`);
    for (const { id } of rows) {
      await this.start(id).catch(async (err) => {
        console.error(`[wa] session ${id} failed to start: ${err.message}`);
        await this.setStatus(id, 'disconnected');
      });
    }
  }

  shutdown() {
    clearInterval(this.sweepTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    for (const live of this.live.values()) { live.closing = true; live.sock.end(undefined); }
    this.live.clear();
  }

  async requireSession(id) {
    const s = await db.row('SELECT * FROM whatsapp_sessions WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!s) throw new WaError(404, 'WhatsApp number not found.');
    return s;
  }

  setStatus(id, status) {
    return db.query('UPDATE whatsapp_sessions SET status = $2, updated_at = NOW() WHERE id = $1', [id, status]);
  }

  clearTimer(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  // The QR is a short-lived pairing secret: only returned while a scan is pending.
  async state(id) {
    const s = await this.requireSession(id);
    return { status: s.status, qr: s.status === 'qr' ? this.live.get(id)?.qr ?? null : null };
  }

  async connect(id) {
    await this.requireSession(id);
    if (!this.live.has(id)) { this.attempts.delete(id); await this.start(id); }
    const state = await this.state(id);
    if (state.status !== 'connected') return state;
    return { ...state, restrictionChecked: await this.checkRestriction(id) };
  }

  // Asks WhatsApp whether it is currently limiting this number. False when it
  // could not be asked; the last answer then stays on record.
  async checkRestriction(id) {
    const sock = this.live.get(id)?.sock;
    if (!sock?.fetchAccountReachoutTimelock) return false;
    let timer;
    try {
      const answer = await Promise.race([
        sock.fetchAccountReachoutTimelock(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), RESTRICTION_TIMEOUT_MS); }),
      ]);
      await this.saveRestriction(id, answer);
      return true;
    } catch (err) {
      console.warn(`[wa] restriction check for session ${id} failed: ${err.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async saveRestriction(id, state) {
    const active = Boolean(state?.isActive);
    const until = active && state.timeEnforcementEnds && !Number.isNaN(state.timeEnforcementEnds.getTime())
      ? state.timeEnforcementEnds : null;
    const type = active ? String(state.enforcementType ?? '').slice(0, 64) || null : null;
    console.log(`[wa] session ${id} restriction: ${active ? `${type} until ${until ? until.toISOString() : 'unknown'}` : 'none reported'}`);
    await db.query(
      `UPDATE whatsapp_sessions SET restriction_active = $2, restriction_type = $3, restriction_until = $4,
              restriction_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, active, type, until]
    );
  }

  async logout(id) {
    await this.requireSession(id);
    const live = this.live.get(id);
    let unlinkedOnPhone = false;
    if (live) {
      live.closing = true;
      try { await live.sock.logout(); unlinkedOnPhone = true; } catch { live.sock.end(undefined); }
      this.live.delete(id);
    }
    this.clearTimer(id);
    await deleteSessionAuth(id);
    await this.setStatus(id, 'logged_out');
    return { unlinkedOnPhone };
  }

  async start(id) {
    this.clearTimer(id);
    const b = await this.loadBaileys();
    const { state, saveCreds } = await useDbAuthState(id, b);
    let version;
    try { version = (await b.fetchLatestBaileysVersion()).version; } catch { /* bundled version */ }

    const sock = b.makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: b.makeCacheableSignalKeyStore(state.keys, this.logger) },
      logger: this.logger,
      browser: b.Browsers.ubuntu('DP7'),
      syncFullHistory: false,
      markOnlineOnConnect: false, // the phone keeps getting notifications
    });
    const live = { sock, creds: state.creds, qr: null, closing: false };
    this.live.set(id, live);
    await this.setStatus(id, 'connecting');

    const guard = (what, p) => p.catch((err) => console.error(`[wa] ${what} for session ${id}: ${err.message}`));
    sock.ev.on('creds.update', () => guard('saving credentials', saveCreds()));
    sock.ev.on('connection.update', (u) => guard('connection.update', this.onConnection(id, live, u, b)));
    sock.ev.on('messages.upsert', (e) => guard('messages.upsert', this.onIncoming(id, live, e, b)));
    sock.ev.on('messages.update', (u) => guard('messages.update', this.onStatus(id, u)));
  }

  async onConnection(id, live, update, b) {
    if (this.live.get(id) !== live) return; // a newer socket took over
    // WhatsApp also announces a restriction on its own, sometimes just before
    // it ends the session.
    if (update.reachoutTimeLock) await this.saveRestriction(id, update.reachoutTimeLock);
    if (update.qr) { live.qr = update.qr; await this.setStatus(id, 'qr'); }
    if (update.connection === 'open') {
      live.qr = null;
      this.attempts.delete(id);
      const phone = digitsOf(live.sock.user?.id ?? '');
      await db.query(
        `UPDATE whatsapp_sessions SET status = 'connected', phone_number = $2, connected_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id, phone || null]
      );
      console.log(`[wa] session ${id} connected`);
      this.checkRestriction(id); // not awaited: it never rejects
    }
    if (update.connection !== 'close' || live.closing) return;

    live.qr = null;
    this.live.delete(id);
    const code = update.lastDisconnect?.error?.output?.statusCode;
    const R = b.DisconnectReason;
    if (code === R.loggedOut) { await deleteSessionAuth(id); return this.setStatus(id, 'logged_out'); }
    if (code === R.connectionReplaced) {
      // Reconnecting would make two copies fight and WhatsApp end both.
      console.error(`[wa] session ${id}: another process is using this login. Not reconnecting.`);
      return this.setStatus(id, 'replaced');
    }
    if (code === R.restartRequired) return this.start(id); // normal right after a QR scan
    if (!live.creds.me) return this.setStatus(id, 'qr_expired');

    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    await this.setStatus(id, 'reconnecting');
    console.warn(`[wa] session ${id} dropped (code ${code}); retry ${attempt} in ${delay}ms`);
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      this.start(id).catch((err) => console.error(`[wa] reconnect of ${id} failed: ${err.message}`));
    }, delay));
  }

  async onIncoming(id, live, event, b) {
    // Baileys can fold a refusal into the echo of our own message, in which
    // case no 'messages.update' arrives for it.
    const refused = event.messages.filter(
      (m) => m.key?.fromMe && m.status === 0 && m.messageStubParameters?.length
    );
    if (refused.length) {
      await this.onStatus(id, refused.map((m) => ({
        key: m.key, update: { status: 0, messageStubParameters: m.messageStubParameters },
      })));
    }
    if (event.type !== 'notify') return; // 'append' is history backfill
    for (const m of event.messages) {
      const jid = m.key?.remoteJid;
      const messageId = m.key?.id;
      if (!m.message || !jid || !messageId || m.key.fromMe) continue;
      if (/@(g\.us|broadcast|newsletter)$/.test(jid)) continue; // one-to-one chats only
      const d = describeContent(b.normalizeMessageContent(m.message));
      if (!d) continue;

      const number = await this.resolveNumber(live.sock, m.key);
      const customerId = number ? await db.value(
        `SELECT id FROM customers WHERE RIGHT(regexp_replace(mobile, '\\D', '', 'g'), 10) = RIGHT($1, 10)
          ORDER BY last_deposit DESC NULLS LAST, id DESC LIMIT 1`, [number]
      ) : null;
      const at = m.messageTimestamp ? new Date(b.toNumber(m.messageTimestamp) * 1000) : new Date();
      // The unique (session, provider id) pair makes a redelivery a no-op.
      await db.query(
        `INSERT INTO whatsapp_messages
           (session_id, customer_id, direction, remote_jid, number, conversation_key, body, media_type, provider_message_id, message_at)
         VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (session_id, provider_message_id) DO NOTHING`,
        [id, customerId, jid, number, number ?? jid, d.body, d.mediaType, messageId, at]
      );
      if (isOptOutMessage(d.body)) {
        if (!number) console.warn('[wa] an opt-out came from a contact whose number is unknown; add it by hand.');
        else {
          await db.query(
            `INSERT INTO whatsapp_opt_outs (number, source, trigger_text) VALUES ($1,'reply',$2) ON CONFLICT (number) DO NOTHING`,
            [number, String(d.body).slice(0, 200)]
          );
        }
      }
    }
  }

  // WhatsApp often reports a contact by an opaque LID instead of the number.
  async resolveNumber(sock, key) {
    const jids = [key.remoteJidAlt, key.remoteJid].filter(Boolean);
    const phone = jids.find((j) => j.endsWith('@s.whatsapp.net'));
    if (phone) return digitsOf(phone) || null;
    const lid = jids.find((j) => j.endsWith('@lid'));
    if (lid) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
        if (pn) return digitsOf(pn) || null;
      } catch (err) { console.warn(`[wa] LID lookup failed: ${err.message}`); }
    }
    return null;
  }

  // WhatsApp can answer before the sent message is saved, so each update is
  // also kept for a while and applied again right after the insert.
  async onStatus(id, updates) {
    for (const u of updates) {
      if (typeof u.update?.status !== 'number' || !u.key?.id || u.key.fromMe === false) continue;
      const key = `${id}:${u.key.id}`;
      this.recentUpdates.set(key, [...(this.recentUpdates.get(key) ?? []), u.update]);
      if (this.recentUpdates.size > REMEMBERED_UPDATES) {
        this.recentUpdates.delete(this.recentUpdates.keys().next().value);
      }
      await this.applyStatus(id, u.key.id, u.update);
    }
  }

  // Statuses repeat and arrive out of order, so they only ever move up. A
  // refusal (0) is recorded only for a message that is still pending.
  async applyStatus(id, messageId, update) {
    const { status } = update;
    if (status <= 0) {
      const code = String(update.messageStubParameters?.[0] ?? '').slice(0, 64);
      const changed = await db.query(
        `UPDATE whatsapp_messages SET delivery_status = 0, delivery_error = $3, updated_at = NOW()
          WHERE session_id = $1 AND provider_message_id = $2 AND direction = 'out' AND delivery_status = 1`,
        [id, messageId, code || null]
      );
      if (code === '463' && changed.rowCount) this.checkRestriction(id);
    } else {
      await db.query(
        `UPDATE whatsapp_messages SET delivery_status = $1, delivery_error = NULL, updated_at = NOW()
          WHERE session_id = $2 AND provider_message_id = $3 AND direction = 'out' AND delivery_status < $1`,
        [status, id, messageId]
      );
    }
  }

  async sweepStale() {
    try {
      await db.query(
        `UPDATE whatsapp_messages SET delivery_status = 0, delivery_error = $1, updated_at = NOW()
          WHERE direction = 'out' AND delivery_status = 1 AND message_at < NOW() - make_interval(mins => $2)`,
        [NO_CONFIRMATION, STALE_PENDING_MINUTES]
      );
    } catch (err) { console.error(`[wa] stale sweep failed: ${err.message}`); }
  }

  // Sends on one number run one after another, so pacing and the daily limit
  // cannot race each other.
  sendText(id, input) {
    const waiting = this.pending.get(id) ?? 0;
    if (waiting >= MAX_PENDING_SENDS) {
      return Promise.reject(new WaError(429, 'Too many messages are waiting on this number. Try again in a minute.'));
    }
    this.pending.set(id, waiting + 1);
    const run = (this.queues.get(id) ?? Promise.resolve())
      .then(() => this.sendNow(id, input))
      .finally(() => this.pending.set(id, Math.max(0, this.pending.get(id) - 1)));
    this.queues.set(id, run.then(() => {}, () => {}));
    return run;
  }

  async sendNow(id, input) {
    const session = await this.requireSession(id);
    const live = this.live.get(id);
    if (!live || session.status !== 'connected') throw new WaError(409, 'This number is not connected right now.');

    const to = normalizeNumber(input.to);
    const text = String(input.text || '').trim();
    if (!/^\d{8,15}$/.test(to)) throw new WaError(400, 'This mobile number looks incomplete.');
    if (!text || text.length > 4000) throw new WaError(400, 'A message needs 1 to 4000 characters.');

    // Free refusals come before the limit count, pacing and WhatsApp itself.
    const blocked = await blockedReason(to);
    if (blocked) throw new WaError(409, blocked);
    if (!input.isReply && await db.value(
      `SELECT 1 FROM whatsapp_messages WHERE direction = 'out' AND number = $1 AND body = $2
         AND delivery_status > 0 AND message_at >= NOW() - INTERVAL '24 hours' LIMIT 1`, [to, text]
    )) {
      throw new WaError(409, 'The same message already went to this contact in the last 24 hours.');
    }
    const sentToday = await db.value(
      `SELECT COUNT(*)::int FROM whatsapp_messages WHERE session_id = $1 AND direction = 'out'
         AND message_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [id]
    );
    if (sentToday >= session.daily_cap) {
      throw new WaError(429, `Daily limit reached for this number (${session.daily_cap}). It resets at 00:00 UTC.`);
    }

    // A human does not send at machine speed.
    const gap = this.minGapMs + Math.random() * (this.maxGapMs - this.minGapMs);
    const since = Date.now() - (this.lastSentAt.get(id) ?? 0);
    if (since < gap) await sleep(gap - since);

    let found;
    try { [found] = (await live.sock.onWhatsApp(`${to}@s.whatsapp.net`)) ?? []; } catch (err) {
      console.warn(`[wa] number check for ${maskNumber(to)} failed: ${err.message}`);
      throw new WaError(502, 'Could not reach WhatsApp to check the number. Try again shortly.');
    }
    if (!found?.exists) throw new WaError(400, 'This number is not on WhatsApp.');

    let providerId;
    try {
      providerId = (await live.sock.sendMessage(found.jid, { text }))?.key?.id;
    } catch (err) {
      console.warn(`[wa] send to ${maskNumber(to)} failed: ${err.message}`);
      throw new WaError(502, 'WhatsApp did not accept the message. Try again shortly.');
    } finally {
      this.lastSentAt.set(id, Date.now());
    }
    if (!providerId) throw new WaError(502, 'WhatsApp did not confirm the message.');

    await db.query(
      `INSERT INTO whatsapp_messages
         (session_id, customer_id, direction, remote_jid, number, conversation_key, body, provider_message_id,
          delivery_status, message_at, sent_by, sent_by_name, created_by, updated_by)
       VALUES ($1,$2,'out',$3,$4,$4,$5,$6,1,NOW(),$7,$8,$7,$7)
       ON CONFLICT (session_id, provider_message_id) DO NOTHING`,
      [id, input.customerId || null, found.jid, to, text, providerId, input.sentBy || null, input.sentByName || null]
    );
    for (const update of this.recentUpdates.get(`${id}:${providerId}`) ?? []) {
      await this.applyStatus(id, providerId, update);
    }
    return { messageId: providerId };
  }
}

module.exports = { WhatsappService, WaError };
