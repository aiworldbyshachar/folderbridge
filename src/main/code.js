'use strict';
// Connection codes: every device that shares the same code can see and decrypt
// each other's folder. Ambiguous characters (0/O, 1/I/L) are left out.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatCode(code) {
  const n = normalizeCode(code);
  return (n.match(/.{1,4}/g) || []).join('-');
}

function isValidCode(code) {
  return normalizeCode(code).length >= 8;
}

function generateCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return formatCode(s);
}

module.exports = { normalizeCode, formatCode, isValidCode, generateCode };
