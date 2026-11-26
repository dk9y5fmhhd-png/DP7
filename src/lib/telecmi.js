'use strict';

// TeleCMI click-to-call. Keys Settings me daalte hain; na ho to call
// "manual" mark hota hai aur caller ko number dikhaya jaata hai (masked).
//
// TeleCMI ka click-to-call endpoint:
//   POST https://rest.telecmi.com/v2/c2c
//   { app_id, secret, from: agent_number, to: customer_number }

const db = require('../db');

async function config() {
  const rows = await db.rows("SELECT key, value FROM settings WHERE key LIKE 'telecmi_%'");
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return {
    appId: cfg.telecmi_app_id || '',
    secret: cfg.telecmi_secret || '',
    agent: cfg.telecmi_agent || '',
    enabled: Boolean(cfg.telecmi_app_id && cfg.telecmi_secret && cfg.telecmi_agent),
  };
}

// Number ko E.164 me badlo (India default)
function e164(mobile, cc) {
  const digits = String(mobile || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) return '+' + digits;
  if (digits.length === 10) return '+91' + digits;
  return '+' + (cc || '91') + digits;
}

async function clickToCall({ customer, callerId }) {
  const cfg = await config();
  const to = e164(customer.mobile);

  if (!to) {
    return { ok: false, provider: 'manual', message: 'Customer ka mobile number nahi hai.' };
  }

  if (!cfg.enabled) {
    // Keys nahi hain — call log karo, caller khud dial kare
    const log = await db.row(
      `INSERT INTO calls (customer_id, username, caller_id, provider, status, note)
       VALUES ($1,$2,$3,'manual','initiated',$4) RETURNING id, called_at`,
      [customer.id, customer.username, callerId, 'TeleCMI keys not set — manual dial']
    );
    return {
      ok: true,
      provider: 'manual',
      callId: log.id,
      message: 'TeleCMI not set up — number shown, dial manually:',
      dial: to,
    };
  }

  try {
    const body = new URLSearchParams({
      app_id: cfg.appId,
      secret: cfg.secret,
      from: cfg.agent,
      to,
    });
    const res = await fetch('https://rest.telecmi.com/v2/c2c', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text rakho */ }

    const ok = res.ok && !(json && json.status && String(json.status).toLowerCase() === 'error');
    const ref = (json && (json.call_id || json.ref_id || json.id)) || null;

    const log = await db.row(
      `INSERT INTO calls (customer_id, username, caller_id, provider, provider_ref, status, note, raw)
       VALUES ($1,$2,$3,'telecmi',$4,$5,$6,$7) RETURNING id`,
      [customer.id, customer.username, callerId, ref,
        ok ? 'initiated' : 'failed', ok ? 'TeleCMI click-to-call' : 'TeleCMI error', json || { raw: text.slice(0, 500) }]
    );

    return {
      ok,
      provider: 'telecmi',
      callId: log.id,
      message: ok ? 'Call laga diya — phone uthaiye.' : 'TeleCMI ne call reject kiya. Settings me keys check split it:',
    };
  } catch (err) {
    await db.query(
      `INSERT INTO calls (customer_id, username, caller_id, provider, status, note)
       VALUES ($1,$2,$3,'telecmi','failed',$4)`,
      [customer.id, customer.username, callerId, 'Network error: ' + err.message]
    );
    return { ok: false, provider: 'telecmi', message: 'TeleCMI se baat nahi hui: ' + err.message };
  }
}

module.exports = { config, clickToCall, e164 };

