'use strict';

// TeleCMI click-to-call, following the Ringline integration:
//   POST /v2/webrtc/click2call { user_id, secret, to, webrtc, followme }
// Each staff member has their own TeleCMI agent ID ("5001_1111112"); the part
// after "_" is the app ID, which decides which saved account's secret is used.

const crypto = require('crypto');
const db = require('../db');
const secrets = require('./crypto');
const { normalizeNumber, maskNumber } = require('./phone');

const TIMEOUT_MS = 10_000;
const base = () => (process.env.TELECMI_API_BASE || 'https://rest.telecmi.com').replace(/\/+$/, '');

async function post(path, body, timeout = TIMEOUT_MS) {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

const appIdOf = (agentId) => /_(\d+)$/.exec(String(agentId).trim())?.[1] ?? null;

function pickAccount(accounts, agentId) {
  const appId = appIdOf(agentId);
  if (!appId) return accounts[0] || null;
  return accounts.find((a) => a.app_id === appId) || null;
}

const isEnabled = async () => Boolean(await db.value('SELECT 1 FROM telecmi_accounts WHERE is_active LIMIT 1'));

// Best effort: makes the dialer show "Client #12" instead of a raw number.
async function saveContact(agentId, password, number, customerId) {
  try {
    const login = await post('/v2/user/login', { id: agentId, password }, 5000);
    if (!login.json?.token) return console.warn(`[telecmi] contact save: login refused for agent ${agentId}`);
    const added = await post('/v3/contact/add', {
      token: login.json.token,
      contacts: [{ phone_no: number, first_name: 'Client', last_name: `#${customerId}` }],
    }, 5000);
    const code = added.json?.code;
    if (!added.ok || (code !== undefined && Number(code) !== 200)) {
      console.warn(`[telecmi] contact save: not saved for ${maskNumber(number)} (code ${code ?? added.status})`);
    }
  } catch (err) {
    console.warn(`[telecmi] contact save failed: ${err.message}`);
  }
}

async function logCall(row) {
  await db.query(
    `INSERT INTO calls (customer_id, username, caller_id, provider, provider_ref, status, note, account_id)
     VALUES ($1,$2,$3,'telecmi',$4,$5,$6,$7)`,
    [row.customer.id, row.customer.username, row.userId, row.ref || null, row.status, row.note, row.accountId]
  );
}

async function dial({ customer, user }) {
  const number = normalizeNumber(customer.mobile);
  if (number.length < 8) return { ok: false, message: 'This customer has no usable mobile number.' };

  const me = await db.row('SELECT telecmi_agent_id, telecmi_password_enc FROM users WHERE id = $1', [user.id]);
  const agentId = String(me?.telecmi_agent_id || '').trim();
  if (!agentId) {
    return { ok: false, message: 'Your TeleCMI agent ID is not set. A Super Admin adds it on the Users page.' };
  }
  const accounts = await db.rows('SELECT * FROM telecmi_accounts WHERE is_active ORDER BY id');
  if (!accounts.length) return { ok: false, message: 'TeleCMI is not set up yet (Settings → Calling).' };
  const account = pickAccount(accounts, agentId);
  if (!account) {
    return { ok: false, message: `No active TeleCMI account has app ID ${appIdOf(agentId)}. Check Settings → Calling.` };
  }

  let secret;
  try {
    secret = secrets.decrypt(account.secret_enc);
    if (me.telecmi_password_enc) {
      await saveContact(agentId, secrets.decrypt(me.telecmi_password_enc), number, customer.id);
    }
  } catch (err) {
    console.error('[telecmi] cannot read a stored secret:', err.message);
    return { ok: false, message: 'The saved TeleCMI secret cannot be read. Check the encryption key or save it again.' };
  }

  const common = { customer, userId: user.id, accountId: account.id };
  const failed = async (logged, told) => {
    const safe = String(logged).split(secret).join('••••').slice(0, 500);
    console.warn(`[telecmi] not placed: agent ${agentId} -> ${maskNumber(number)} — ${safe}`);
    await logCall({ ...common, status: 'failed', note: safe });
    return { ok: false, message: told };
  };

  let res;
  try {
    res = await post('/v2/webrtc/click2call', {
      user_id: agentId, secret, to: Number(number), webrtc: true, followme: false,
    });
  } catch (err) {
    return failed(`Network error: ${err.message}`, 'Could not reach TeleCMI. Try again.');
  }

  // TeleCMI can refuse inside a normal response: { code: 407, msg: ... }
  const code = res.json?.code !== undefined ? Number(res.json.code) : res.status;
  if (!res.ok || code !== 200) {
    const told = code === 407 ? `TeleCMI did not accept the app secret of "${account.label}".`
      : code === 404 ? `TeleCMI does not know the agent ID ${agentId}.`
        : 'TeleCMI did not place the call. Try again.';
    return failed(`code=${code} msg=${res.json?.msg ?? res.text.slice(0, 200)}`, told);
  }

  await logCall({
    ...common, status: 'initiated', note: 'TeleCMI click-to-call',
    ref: String(res.json.request_id || res.json.callid || '').slice(0, 64),
  });
  return { ok: true, message: 'Call placed — answer it in your TeleCMI app.' };
}

// The "Test login" button. Says only yes or no; the token is never kept.
async function checkLogin(agentId, password) {
  try {
    const r = await post('/v2/user/login', { id: agentId, password }, 8000);
    if (r.json?.token) return { ok: true, message: `TeleCMI accepted agent ${agentId}.` };
    return { ok: false, message: `TeleCMI did not accept this login for agent ${agentId}.` };
  } catch {
    return { ok: false, message: 'Could not reach TeleCMI just now. Try again.' };
  }
}

// The code in the webhook address is derived from the encryption key, so it can
// always be shown again and nothing extra has to be stored.
function webhookToken() {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY || '';
  if (key.length < 32) return null;
  return crypto.createHmac('sha256', key).update('telecmi-webhook').digest('hex').slice(0, 48);
}

function tokenMatches(given) {
  const expected = webhookToken();
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected || '');
  return Boolean(expected) && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Asks TeleCMI whether it accepts the app ID and secret (a balance lookup:
// nothing is dialled). Says nothing about whether a call will connect.
async function checkAccount(appId, secret) {
  try {
    const r = await post('/v2/balance', { appid: Number(appId), secret }, 8000);
    if (r.ok && Number(r.json?.code) === 200) return { ok: true, message: 'TeleCMI accepted the App ID and secret.' };
    return { ok: false, message: 'TeleCMI did not accept the App ID and secret.' };
  } catch {
    return { ok: false, message: 'Could not reach TeleCMI just now. Try again.' };
  }
}

const validAgentId = (id) => !id || /^\d+(_\d+)?$/.test(id);

// Clearing the agent ID clears the password; a blank password keeps the saved
// one only while the agent ID is unchanged.
async function saveAgent(userId, agentId, password) {
  await db.query(
    `UPDATE users
        SET telecmi_password_enc = CASE
              WHEN $2::text IS NULL THEN NULL
              WHEN $3::text IS NOT NULL THEN $3
              WHEN telecmi_agent_id IS DISTINCT FROM $2 THEN NULL
              ELSE telecmi_password_enc END,
            telecmi_agent_id = $2
      WHERE id = $1`,
    [userId, agentId || null, agentId && password ? secrets.encrypt(password) : null]
  );
}

module.exports = {
  dial, checkLogin, checkAccount, isEnabled, pickAccount, appIdOf, webhookToken, tokenMatches, validAgentId, saveAgent,
};
