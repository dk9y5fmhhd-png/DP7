'use strict';

// POST /telecmi/webhook/:token — one address for every account. TeleCMI sends
// several events per call; the final per-leg summary has type "cdr". The code
// in the address keeps strangers from posting fake call records.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { tokenMatches } = require('../lib/telecmi');

const router = express.Router();
const LIMIT_PER_MINUTE = 1000;
let windowStart = 0;
let seen = 0;

const text = (v) => (v === undefined || v === null ? '' : String(v));
const last10 = (v) => text(v).replace(/\D/g, '').slice(-10);

// Which account a message is about: its app id, given outright or at the end of
// the agent's ID ("5001_33338690"). With one account there is nothing to tell.
async function accountFor(p) {
  const accounts = await db.rows('SELECT id, app_id FROM telecmi_accounts');
  const named = [p.appid, p.app_id].map(text);
  const agents = [p.user, p.team].map(text);
  return accounts.find((a) => named.includes(a.app_id) || agents.some((x) => x.endsWith(`_${a.app_id}`)))
    || (accounts.length === 1 ? accounts[0] : null);
}

// Matches a call record to the click-to-call that started it: first by id, then
// by the same agent and number within the last two hours.
async function matchCall(accountId, p) {
  const refs = [p.request_id, p.requestid, p.call_id, p.callid, p.cmiuuid, p.conversation_uuid]
    .map(text).filter(Boolean);
  if (refs.length) {
    const byRef = await db.row(
      `SELECT id FROM calls WHERE provider = 'telecmi' AND ($1::int IS NULL OR account_id = $1) AND provider_ref = ANY($2::text[]) ORDER BY id DESC LIMIT 1`,
      [accountId, refs]
    );
    if (byRef) return byRef.id;
  }
  const number = last10(p.direction === 'inbound' ? p.from : p.to);
  const agent = text(p.user);
  if (number.length !== 10 || !agent) return null;
  const guess = await db.row(
    `SELECT k.id FROM calls k
       JOIN users u ON u.id = k.caller_id
       JOIN customers c ON c.id = k.customer_id
      WHERE ($1::int IS NULL OR k.account_id = $1) AND u.telecmi_agent_id = $2
        AND RIGHT(regexp_replace(c.mobile, '\\D', '', 'g'), 10) = $3
        AND k.status = 'initiated' AND k.called_at > NOW() - INTERVAL '2 hours'
      ORDER BY k.called_at DESC LIMIT 1`,
    [accountId, agent, number]
  );
  return guess ? guess.id : null;
}

router.post(
  '/webhook/:token',
  (req, res, next) => {
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); seen = 0; }
    if (++seen > LIMIT_PER_MINUTE) return res.status(429).json({ status: 'error' });
    next();
  },
  express.json({ limit: '64kb' }),
  express.urlencoded({ extended: false, limit: '64kb' }),
  async (req, res) => {
    try {
      if (!tokenMatches(req.params.token)) return res.status(404).json({ status: 'error' });
      const p = req.body && typeof req.body === 'object' ? req.body : {};
      const account = await accountFor(p);
      const accountId = account ? account.id : null;

      await db.query('INSERT INTO telecmi_webhook_logs (account_id, payload) VALUES ($1,$2)', [accountId, JSON.stringify(p)]);
      if (accountId) await db.query('UPDATE telecmi_accounts SET last_webhook_at = NOW() WHERE id = $1', [accountId]);

      if (p.type === 'cdr') {
        const id = await matchCall(accountId, p);
        if (id) {
          const seconds = Math.min(Math.max(parseInt(p.answeredsec, 10) || 0, 0), 86_400);
          // A call has one record per leg: never let a later one erase talk time.
          await db.query(
            `UPDATE calls
                SET status = CASE WHEN status = 'answered' THEN status ELSE $2 END,
                    duration_sec = GREATEST(duration_sec, $3),
                    hangup_reason = COALESCE(NULLIF($4, ''), hangup_reason),
                    recording_url = COALESCE(NULLIF($5, ''), recording_url),
                    updated_at = NOW()
              WHERE id = $1`,
            [id, text(p.status).slice(0, 40) || 'completed', seconds,
              text(p.hangup_reason).slice(0, 100), text(p.filename).slice(0, 300)]
          );
        }
      }
      res.json({ status: 'success' });
    } catch (err) {
      console.error('[telecmi webhook]', err.message);
      res.status(500).json({ status: 'error' });
    }
  }
);

// Unreadable bodies get a plain answer, not the app's HTML error page.
router.use((err, _req, res, _next) => res.status(err.status || 400).json({ status: 'error' }));

module.exports = router;
