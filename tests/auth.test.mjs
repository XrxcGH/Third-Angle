import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const a = require('../src/auth.js');

test('password hashing round trips and rejects wrong input', () => {
  const h = a.hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(a.verifyPassword('correct horse battery staple', h), true);
  assert.equal(a.verifyPassword('Correct horse battery staple', h), false);
  assert.equal(a.verifyPassword('', h), false);
});

test('password verify never throws on malformed stored values', () => {
  // timingSafeEqual throws on a length mismatch, so a naive implementation
  // turns a corrupt row into a 500 on the login page.
  for (const bad of ['', 'not-a-hash', 'scrypt$x$y$z', 'scrypt$1$2$3$aa$bb', null, undefined, 42, {}]) {
    assert.doesNotThrow(() => a.verifyPassword('x', bad), `threw on ${JSON.stringify(bad)}`);
    assert.equal(a.verifyPassword('x', bad), false);
  }
});

test('two hashes of the same password differ, so the salt is real', () => {
  assert.notEqual(a.hashPassword('same'), a.hashPassword('same'));
});

test('TOTP matches the RFC 6238 test vector', () => {
  // RFC 6238 publishes 8 digit codes. At T=59 with SHA1 the code is 94287082,
  // so a 6 digit implementation must produce the last six: 287082.
  const secret = a.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(a.totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(a.totpAt(secret, Math.floor(1111111109 / 30)), '081804'); // 07081804
  assert.equal(a.totpAt(secret, Math.floor(1234567890 / 30)), '005924'); // 14050471 -> see note
});

test('base32 round trips', () => {
  const buf = Buffer.from('12345678901234567890');
  assert.deepEqual(a.base32Decode(a.base32Encode(buf)), buf);
});

test('TOTP accepts one step of clock skew and rejects three', () => {
  const s = a.generateTotpSecret();
  const now = Date.now();
  const c = Math.floor(now / 30_000);
  assert.equal(a.verifyTotp(s, a.totpAt(s, c), now), true);
  assert.equal(a.verifyTotp(s, a.totpAt(s, c - 1), now), true);
  assert.equal(a.verifyTotp(s, a.totpAt(s, c + 1), now), true);
  assert.equal(a.verifyTotp(s, a.totpAt(s, c - 3), now), false);
});

test('TOTP rejects malformed tokens without throwing', () => {
  const s = a.generateTotpSecret();
  for (const bad of ['abc', '', null, undefined, '12345', '1234567', {}, 123456]) {
    assert.doesNotThrow(() => a.verifyTotp(s, bad));
    assert.equal(a.verifyTotp(s, bad), false);
  }
});

test('CSRF tokens are bound to the session and reject tampering', () => {
  const t = a.csrfToken('session-abc');
  assert.equal(a.checkCsrf('session-abc', t), true);
  assert.equal(a.checkCsrf('session-xyz', t), false);
  assert.equal(a.checkCsrf('session-abc', t.slice(0, -1) + 'A'), false);
  // Must not throw on a length mismatch.
  assert.doesNotThrow(() => a.checkCsrf('session-abc', 'short'));
  assert.equal(a.checkCsrf('session-abc', 'short'), false);
  assert.equal(a.checkCsrf('session-abc', null), false);
});

/* ------------------------------------------------- sign in, recorded */

test('a successful sign in resets the lockout without erasing the failures', () => {
  /*
   * The lockout used to clear itself by DELETING the failed rows, which meant
   * the record of an attack was destroyed by the owner's next sign in:
   * somebody could spend a week guessing, lock the account repeatedly, and
   * leave nothing behind the moment the real operator logged in. The counter
   * now reads from the last success instead, so both properties hold at once.
   */
  const email = `lockout-${Date.now()}@example.test`;
  const ip = '203.0.113.77';
  const db = require('../src/db.js');
  const count = () => db.get(
    'SELECT COUNT(*) AS n FROM login_attempt WHERE ip = ? AND email IS ?', ip, email).n;

  try {
    for (let i = 0; i < 10; i++) a.recordAttempt(email, ip, false);
    assert.equal(a.isRateLimited(email, ip).limited, true, 'ten failures must lock');
    assert.equal(count(), 10);

    a.recordAttempt(email, ip, true);
    assert.equal(a.isRateLimited(email, ip).limited, false,
      'a success must clear the lockout');
    assert.equal(count(), 11, 'and must not delete the history it cleared');

    // Failures after the success count again, from zero.
    for (let i = 0; i < 9; i++) a.recordAttempt(email, ip, false);
    assert.equal(a.isRateLimited(email, ip).limited, false, 'nine is under the limit');
    a.recordAttempt(email, ip, false);
    assert.equal(a.isRateLimited(email, ip).limited, true, 'the tenth since the success locks');
  } finally {
    db.run('DELETE FROM login_attempt WHERE ip = ?', ip);
  }
});

test('sign in activity is readable, newest first, successes and failures alike', () => {
  const ip = '198.51.100.200';
  const db = require('../src/db.js');
  try {
    a.recordAttempt('a@example.test', ip, false);
    a.recordAttempt('b@example.test', ip, true);
    const rows = a.signInActivity(5).filter((r) => r.ip === ip);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].email, 'b@example.test', 'newest first');
    assert.equal(rows[0].ok, 1);
    assert.equal(rows[1].ok, 0);
    // The reader is bounded, so a caller cannot ask for the whole table.
    assert.ok(a.signInActivity(10_000).length <= 100);
  } finally {
    db.run('DELETE FROM login_attempt WHERE ip = ?', ip);
  }
});

test('signing in and out are written to the audit log', () => {
  /*
   * Every content change was already audited and the one event that would tell
   * somebody they had been broken into was not recorded anywhere a person
   * could read.
   */
  const src = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  const login = src.slice(src.indexOf("router.post('/login'"), src.indexOf("router.post('/logout'"));
  assert.match(login, /logChange\([^)]*'session'[^)]*'insert'/,
    'a sign in must be audited');
  const logout = src.slice(src.indexOf("router.post('/logout'"), src.indexOf("router.post('/logout'") + 400);
  assert.match(logout, /logChange\([^)]*'session'[^)]*'delete'/,
    'a sign out must be audited');
  // And before the session is destroyed, or the identity is already gone.
  assert.ok(logout.indexOf('logChange') < logout.indexOf('destroySession'),
    'the audit line must run while the session still has an identity');
});
