'use strict';

// The one place the web app calls the WhatsApp process.

const base = () => (process.env.WA_SERVICE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');

async function call(method, path, body, timeout = 10_000) {
  const token = process.env.WA_INTERNAL_TOKEN;
  if (!token) throw new Error('WhatsApp is not set up on this server (WA_INTERNAL_TOKEN).');
  let res;
  try {
    res = await fetch(`${base()}/internal${path}`, {
      method,
      headers: { 'x-wa-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError'
      ? 'The WhatsApp service took too long. Check the chat before sending again.'
      : 'The WhatsApp service is not reachable.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `The WhatsApp service answered ${res.status}.`);
  return json;
}

module.exports = {
  state: (id) => call('GET', `/sessions/${id}`),
  connect: (id) => call('POST', `/sessions/${id}/connect`, null, 20_000),
  logout: (id) => call('POST', `/sessions/${id}/logout`, null, 20_000),
  // Sends wait in the number's queue, a few seconds apart.
  send: (id, message) => call('POST', `/sessions/${id}/send`, message, 60_000),
};
