'use strict';

const { Pool, types } = require('pg');

// DATE columns (OID 1082) ko plain 'YYYY-MM-DD' string ki tarah rakho — warna
// node-postgres JS Date banata hai aur page par "Thu Nov 19 2026 00:00:00 GMT..." chhapta hai.
types.setTypeParser(1082, (v) => v);
// NUMERIC bhi string aata hai; Number() me convert karke hi bhejte hain.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

// Railway / Heroku style URLs sometimes arrive with sslmode=require which
// node-postgres reads differently from libpq, so we normalise it here.
const connectionString = process.env.DATABASE_URL || '';
const needsSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: connectionString || undefined,
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

async function query(text, params) {
  const started = Date.now();
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('[db] query failed in', Date.now() - started, 'ms:', err.message);
    console.error('[db] sql:', text.replace(/\s+/g, ' ').trim().slice(0, 400));
    throw err;
  }
}

// Convenience: many rows
const rows = async (text, params) => (await query(text, params)).rows;
// Convenience: first row or null
const row = async (text, params) => (await query(text, params)).rows[0] || null;
// Convenience: single scalar value
const value = async (text, params) => {
  const r = await query(text, params);
  const first = r.rows[0];
  if (!first) return null;
  return first[Object.keys(first)[0]];
};

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, rows, row, value, tx };


