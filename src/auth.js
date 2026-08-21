'use strict';

/*
 * Authentication for exactly one admin.
 *
 * Zero new dependencies: scrypt, HMAC, random bytes and timing-safe compare
 * are all in node:crypto, and TOTP is thirty lines of HMAC. Adding a native
 * argon2 build to a project whose entire point is "no native dependencies on
 * the ARM target" would be a poor trade for a marginal KDF improvement.
 *
 * Threat model, stated so the controls can be judged against it: a personal
 * portfolio with one operator, no user accounts, no payments and no third party
 * data. The realistic attacks are credential stuffing and drive-by scanning,
 * not a targeted adversary with a GPU cluster. Passkeys were considered and
 * declined for V1: four credential paths is four lockout risks for one person.
 */

const crypto = require('node:crypto');
const { get, all, run, nowIso } = require('./db');

/* ---------------------------------------------------------------- password */

// OWASP's current scrypt guidance is N=2^17, r=8, p=1. maxmem must be raised
// to match, or Node throws rather than running slowly.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    // Constant time, and length-checked first because timingSafeEqual throws
    // on a length mismatch rather than returning false.
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- TOTP */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Verify a 6 digit code. A one step window either side absorbs clock skew,
 * which is the usual cause of a legitimate code being rejected.
 */
function verifyTotp(secret, token, atMs = Date.now()) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const counter = Math.floor(atMs / 30_000);
  for (let w = -1; w <= 1; w++) {
    const expected = totpAt(secret, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(t))) return true;
  }
  return false;
}

function totpUri(secret, account, issuer = 'Third Angle') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
         `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------------------------------------------------------------- sessions */

const SESSION_DAYS = 14;

function createSession(userId, { userAgent, ip } = {}) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  run(
    'INSERT INTO session (id, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
    id, userId, nowIso(), expires, userAgent || null, ip || null
  );
  return { id, expires };
}

function getSession(id) {
  if (!id) return null;
  const row = get(
    `SELECT s.id, s.expires_at, u.id AS user_id, u.email, u.name, u.active, u.must_change_password
       FROM session s JOIN user u ON u.id = s.user_id
      WHERE s.id = ?`,
    id
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) { destroySession(id); return null; }
  if (!row.active) return null;
  return row;
}

function destroySession(id) {
  if (id) run('DELETE FROM session WHERE id = ?', id);
}

function purgeExpiredSessions() {
  run('DELETE FROM session WHERE expires_at < ?', nowIso());
}

/* ------------------------------------------------------------ rate limiting
 * Two tiers, per the threat model: a tight limit on one account from one
 * address, and a looser daily limit on an address hammering many accounts.
 * No permanent lockout, because the only person who can be locked out is the
 * owner, and a permanent lockout would be the more likely incident.
 */

const PER_PAIR_LIMIT = 10;     // consecutive failures for (email, ip)
const PER_PAIR_WINDOW_MIN = 15;
const PER_IP_LIMIT = 100;      // failures per ip per day
const PER_IP_WINDOW_MIN = 60 * 24;

function recordAttempt(email, ip, ok) {
  run('INSERT INTO login_attempt (email, ip, ok, at) VALUES (?, ?, ?, ?)', email || null, ip, ok ? 1 : 0, nowIso());
}

function isRateLimited(email, ip) {
  const since = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

  const pair = get(
    `SELECT COUNT(*) AS n FROM login_attempt
      WHERE ok = 0 AND ip = ? AND email IS ? AND at > ?`,
    ip, email || null, since(PER_PAIR_WINDOW_MIN)
  );
  if (pair && pair.n >= PER_PAIR_LIMIT) return { limited: true, scope: 'account', retryMinutes: PER_PAIR_WINDOW_MIN };

  const perIp = get(
    'SELECT COUNT(*) AS n FROM login_attempt WHERE ok = 0 AND ip = ? AND at > ?',
    ip, since(PER_IP_WINDOW_MIN)
  );
  if (perIp && perIp.n >= PER_IP_LIMIT) return { limited: true, scope: 'address', retryMinutes: PER_IP_WINDOW_MIN };

  return { limited: false };
}

/** A successful login clears the account tier so a fumbled password is not sticky. */
function clearAttempts(email, ip) {
  run('DELETE FROM login_attempt WHERE ok = 0 AND ip = ? AND email IS ?', ip, email || null);
}

/* -------------------------------------------------------------------- CSRF
 * Synchroniser token bound to the session id via HMAC, so it needs no server
 * side storage and cannot be forged without the secret.
 */

function csrfToken(sessionId) {
  const secret = process.env.SESSION_SECRET || 'dev-only-insecure-secret';
  return crypto.createHmac('sha256', secret).update(String(sessionId || 'anon')).digest('base64url');
}

function checkCsrf(sessionId, token) {
  const expected = csrfToken(sessionId);
  const given = String(token || '');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/* ------------------------------------------------------------------- users */

function findUserByEmail(email) {
  return get('SELECT * FROM user WHERE email = ? AND active = 1', String(email || '').toLowerCase().trim());
}

function countUsers() {
  return get('SELECT COUNT(*) AS n FROM user').n;
}

function createUser({ email, name, password }) {
  const res = run(
    `INSERT INTO user (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    String(email).toLowerCase().trim(), name, hashPassword(password), nowIso()
  );
  return Number(res.lastInsertRowid);
}

function setTotpSecret(userId, secret, confirmed = 0) {
  run('UPDATE user SET totp_secret = ?, totp_confirmed = ? WHERE id = ?', secret, confirmed ? 1 : 0, userId);
}

function recordLogin(userId) {
  run('UPDATE user SET last_login_at = ? WHERE id = ?', nowIso(), userId);
}

module.exports = {
  hashPassword, verifyPassword,
  generateTotpSecret, verifyTotp, totpAt, totpUri, base32Encode, base32Decode,
  createSession, getSession, destroySession, purgeExpiredSessions,
  recordAttempt, isRateLimited, clearAttempts,
  csrfToken, checkCsrf,
  findUserByEmail, countUsers, createUser, setTotpSecret, recordLogin,
};
