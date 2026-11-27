'use strict';

// Postgres-backed Baileys auth state (ported from Ringline). Every value is
// encrypted: together they are equivalent to a private key for the account.

const db = require('../db');
const secrets = require('../lib/crypto');

const CREDS = 'creds';

async function useDbAuthState(sessionId, b) {
  const { BufferJSON, initAuthCreds, proto } = b;
  const serialize = (v) => secrets.encrypt(JSON.stringify(v, BufferJSON.replacer));
  const parse = (s) => JSON.parse(secrets.decrypt(s), BufferJSON.reviver);

  // Baileys writes many keys at once, so one upsert covers them all.
  const upsert = (keys, values) => db.query(
    `INSERT INTO whatsapp_auth_keys (session_id, key, value)
     SELECT $1, k, v FROM unnest($2::text[], $3::text[]) AS t(k, v)
     ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [sessionId, keys, values]
  );

  // An unreadable creds row (wrong key) must stop the session: falling back to
  // fresh credentials would silently unlink the phone.
  const saved = await db.row('SELECT value FROM whatsapp_auth_keys WHERE session_id = $1 AND key = $2', [sessionId, CREDS]);
  const creds = saved ? parse(saved.value) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const rows = await db.rows(
            'SELECT key, value FROM whatsapp_auth_keys WHERE session_id = $1 AND key = ANY($2::text[])',
            [sessionId, ids.map((id) => `${type}-${id}`)]
          );
          const byKey = new Map(rows.map((r) => [r.key, r.value]));
          const data = {};
          for (const id of ids) {
            data[id] = null;
            const stored = byKey.get(`${type}-${id}`);
            if (!stored) continue;
            try {
              let value = parse(stored);
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              data[id] = value;
            } catch { /* one unreadable Signal key behaves like a missing one */ }
          }
          return data;
        },
        set: async (data) => {
          const keys = []; const values = []; const remove = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) { keys.push(key); values.push(serialize(value)); } else remove.push(key);
            }
          }
          if (keys.length) await upsert(keys, values);
          if (remove.length) {
            await db.query('DELETE FROM whatsapp_auth_keys WHERE session_id = $1 AND key = ANY($2::text[])', [sessionId, remove]);
          }
        },
      },
    },
    saveCreds: () => upsert([CREDS], [serialize(creds)]),
  };
}

const deleteSessionAuth = (sessionId) => db.query('DELETE FROM whatsapp_auth_keys WHERE session_id = $1', [sessionId]);

module.exports = { useDbAuthState, deleteSessionAuth };
