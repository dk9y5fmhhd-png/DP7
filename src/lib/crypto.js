'use strict';

// AES-256-GCM for secrets kept in the database (TeleCMI secrets and agent
// passwords, WhatsApp logins). Changing CREDENTIALS_ENCRYPTION_KEY makes every
// stored value unreadable, so treat it as permanent.

const crypto = require('crypto');

function key() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY || '';
  if (raw.length < 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is missing or shorter than 32 characters.');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

const isConfigured = () => (process.env.CREDENTIALS_ENCRYPTION_KEY || '').length >= 32;

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

function decrypt(stored) {
  const [version, iv, tag, body] = String(stored).split(':');
  if (version !== 'v1') throw new Error('Stored secret has an unknown format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body || '', 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isConfigured };
