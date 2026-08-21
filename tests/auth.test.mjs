import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
