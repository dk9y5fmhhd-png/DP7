'use strict';

// English and Hindi. The English sentence is the key; src/locales/hi.json holds
// the Hindi. A missing entry shows the English, never a blank.
//
//   _t('Hello {name}', { name })   plain text (escape with <%= %>)
//   _th('<strong>{n}</strong> rows', { n })   markup (print with <%- %>)
//   _tm(message)                   a finished system message, matched by pattern
//
// Never pass customer names, notes or other typed data through these.

const { AsyncLocalStorage } = require('async_hooks');

const LANGUAGES = { en: 'English', hi: 'हिन्दी' };
const DICTS = { en: {}, hi: require('../locales/hi.json') };

const store = new AsyncLocalStorage();
const isLang = (l) => Object.prototype.hasOwnProperty.call(LANGUAGES, l);
const current = () => store.getStore() || 'en';
const run = (lang, fn) => store.run(isLang(lang) ? lang : 'en', fn);

const has = (dict, key) => Object.prototype.hasOwnProperty.call(dict, key);
const fill = (text, vars, map = (v) => v) =>
  vars ? text.replace(/\{(\w+)\}/g, (all, n) => (has(vars, n) ? map(String(vars[n] ?? '')) : all)) : text;

function t(key, vars, lang = current()) {
  if (typeof key !== 'string') return key;
  const dict = DICTS[lang] || DICTS.en;
  return fill(has(dict, key) ? dict[key] : key, vars);
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' }[c]));
function th(key, vars, lang = current()) {
  const dict = DICTS[lang] || DICTS.en;
  return fill(has(dict, key) ? dict[key] : key, vars, escapeHtml);
}

// Turns each dictionary key with placeholders into a pattern, most specific first.
const patterns = new Map();
function patternsFor(lang) {
  if (!patterns.has(lang)) {
    const list = [];
    for (const key of Object.keys(DICTS[lang] || {})) {
      const literal = key.replace(/\{\w+\}/g, '');
      if (literal === key || literal.replace(/[^\p{L}]/gu, '').length < 6 || /<\w/.test(key)) continue;
      const names = [];
      const source = key.split(/(\{\w+\})/).map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(m[1]);
        return '([\\s\\S]*?)';
      }).join('');
      list.push({ key, names, weight: literal.length, regex: new RegExp(`^${source}$`) });
    }
    patterns.set(lang, list.sort((a, b) => b.weight - a.weight));
  }
  return patterns.get(lang);
}

function tm(message, lang = current()) {
  if (typeof message !== 'string' || lang === 'en') return message;
  if (has(DICTS[lang] || {}, message)) return DICTS[lang][message];
  for (const p of patternsFor(lang)) {
    const m = p.regex.exec(message);
    if (!m) continue;
    const vars = Object.fromEntries(p.names.map((n, i) => [n, t(m[i + 1], null, lang)]));
    return fill(DICTS[lang][p.key], vars);
  }
  return message;
}

// A string safe to place inside a <script> block.
const js = (key, vars, lang) => JSON.stringify(t(key, vars, lang)).replace(/</g, '\\u003c');

module.exports = { LANGUAGES, isLang, current, run, t, th, tm, js };
