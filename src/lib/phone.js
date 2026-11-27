'use strict';

// Digits only; a bare 10-digit Indian mobile gets the 91 prefix.
function normalizeNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
}

// For server logs: never write a whole customer number.
function maskNumber(num) {
  const s = String(num || '');
  if (s.length < 5) return '****';
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}

module.exports = { normalizeNumber, maskNumber };
