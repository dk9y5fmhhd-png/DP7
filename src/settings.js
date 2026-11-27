'use strict';

const db = require('./db');

const CACHE_MS = 15_000;
let cache = { at: 0, settings: null, levels: null };

async function load(force) {
  if (!force && cache.settings && Date.now() - cache.at < CACHE_MS) return cache;
  const [settingRows, levelRows] = await Promise.all([
    db.rows('SELECT key, value FROM settings'),
    db.rows('SELECT id, name, min_amount, max_amount, sort FROM levels ORDER BY sort, id'),
  ]);
  const settings = {};
  for (const r of settingRows) settings[r.key] = r.value;
  cache = { at: Date.now(), settings, levels: levelRows };
  return cache;
}

function invalidate() {
  cache = { at: 0, settings: null, levels: null };
}

async function all() {
  const c = await load();
  return { ...c.settings };
}

async function get(key, fallback = null) {
  const c = await load();
  if (!(key in c.settings)) return fallback;
  const v = c.settings[key];
  return v === null || v === undefined ? fallback : v;
}

async function getNumber(key, fallback) {
  const v = await get(key, fallback);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function set(key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
  invalidate();
}

async function setMany(obj) {
  for (const [k, v] of Object.entries(obj)) await set(k, v);
}

async function levels() {
  const c = await load();
  return c.levels.map((l) => ({
    id: l.id,
    name: l.name,
    min: Number(l.min_amount),
    max: l.max_amount === null ? null : Number(l.max_amount),
    sort: l.sort,
  }));
}

// Replaces the whole band list in one transaction. Bands that clients already
// point at are matched by id when present, otherwise a new row is created.
async function saveLevels(list) {
  const clean = list
    .filter((l) => l && String(l.name || '').trim() !== '')
    .map((l, i) => ({
      id: l.id ? Number(l.id) : null,
      name: String(l.name).trim().slice(0, 40),
      min: Number(l.min) || 0,
      max: l.max === null || l.max === undefined || String(l.max).trim() === '' ? null : Number(l.max),
      sort: i + 1,
    }));

  for (const b of clean) {
    if (b.max !== null && b.max < b.min) {
      throw new Error(`"${b.name}" has a maximum smaller than its minimum.`);
    }
  }
  const sorted = [...clean].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.max === null) throw new Error(`"${prev.name}" has no maximum, so no band can follow it.`);
    if (sorted[i].min <= prev.max) {
      throw new Error(`"${sorted[i].name}" overlaps with "${prev.name}".`);
    }
  }

  await db.tx(async (client) => {
    const keepIds = clean.filter((b) => b.id).map((b) => b.id);
    if (keepIds.length) {
      await client.query('DELETE FROM levels WHERE id <> ALL($1::int[])', [keepIds]);
    } else {
      await client.query('DELETE FROM levels');
    }
    for (const b of clean) {
      if (b.id) {
        await client.query(
          'UPDATE levels SET name=$2, min_amount=$3, max_amount=$4, sort=$5 WHERE id=$1',
          [b.id, b.name, b.min, b.max, b.sort]
        );
      } else {
        await client.query(
          'INSERT INTO levels (name, min_amount, max_amount, sort) VALUES ($1,$2,$3,$4)',
          [b.name, b.min, b.max, b.sort]
        );
      }
    }
  });
  invalidate();
}

module.exports = { all, get, getNumber, set, setMany, levels, saveLevels, invalidate };

