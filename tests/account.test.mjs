/*
 * The account page.
 *
 * The operator has to be able to change their own address and password from
 * inside the site. Without it the only route is shell access plus
 * scripts/create-admin.js, which means a hand-over password stays whatever it
 * was set to and a compromised address cannot be moved at all.
 *
 * These tests are text-level assertions over the route file plus unit tests of
 * the validators, so the suite keeps running with no server and no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const auth = require('../src/auth.js');
const ADMIN = readFileSync(path.join(ROOT, 'src', 'routes', 'admin.js'), 'utf8');
const VIEW = readFileSync(path.join(ROOT, 'views', 'admin', 'account.ejs'), 'utf8');
const LAYOUT = readFileSync(path.join(ROOT, 'views', 'layout-admin.ejs'), 'utf8');

/* ------------------------------------------------------------- validators */

test('the password floor is one number, stated once', () => {
  assert.equal(typeof auth.MIN_PASSWORD, 'number');
  assert.ok(auth.MIN_PASSWORD >= 12);
  assert.equal(auth.passwordProblem('x'.repeat(auth.MIN_PASSWORD)), null);
  assert.match(auth.passwordProblem('x'.repeat(auth.MIN_PASSWORD - 1)), /at least/);
  // And the script that hands out a temporary one names the same rule.
  const script = readFileSync(path.join(ROOT, 'scripts', 'create-admin.js'), 'utf8');
  assert.match(script, /--temp/, 'the hand-over path must be an explicit flag');
});

test('a password long enough to matter is not rejected for being long', () => {
  assert.equal(auth.passwordProblem('a'.repeat(200)), null);
  assert.match(auth.passwordProblem('a'.repeat(600)), /longer than/);
});

test('email validation rejects the obvious and accepts the awkward', () => {
  for (const bad of ['', '   ', 'nope', 'a@b', 'a b@c.com', '@c.com', 'a@']) {
    assert.ok(auth.emailProblem(bad), `accepted ${JSON.stringify(bad)}`);
  }
  for (const ok of [
    'ericjamesdean1@gmail.com',
    'first.last+tag@sub.example.co.uk',
    "o'brien@example.org",
  ]) {
    assert.equal(auth.emailProblem(ok), null, `rejected ${ok}`);
  }
});

/* ------------------------------------------------------------------ routes */

test('every account route exists', () => {
  for (const route of [
    "router.get('/account'",
    "router.post('/account/profile'",
    "router.post('/account/password'",
    "router.post('/account/totp/start'",
    "router.post('/account/totp/confirm'",
    "router.post('/account/totp/off'",
    "router.post('/account/sessions/revoke'",
  ]) {
    assert.ok(ADMIN.includes(route), `missing ${route}`);
  }
});

test('every mutating account route is CSRF protected', () => {
  const posts = [...ADMIN.matchAll(/router\.post\('(\/account[^']*)'([^)]*)\)/g)];
  assert.ok(posts.length >= 5, 'expected several account POST routes');
  for (const [, route, args] of posts) {
    assert.match(args, /requireCsrf/, `${route} is not CSRF protected`);
  }
});

test('changing the password requires the current one', () => {
  /*
   * Even though the session is already authenticated. A session cookie is what
   * an unattended laptop leaks; the password is what stops that becoming a
   * permanent takeover.
   */
  const handler = ADMIN.slice(
    ADMIN.indexOf("router.post('/account/password'"),
    ADMIN.indexOf("router.post('/account/totp/start'")
  );
  assert.match(handler, /verifyPassword\(current, user\.password_hash\)/);
  assert.match(handler, /passwordProblem/);
  assert.match(handler, /next_ !== confirm/);
});

test('changing the password ends every other session', () => {
  // A password change that leaves older sessions alive has revoked nothing,
  // which is the whole reason someone changes a password they think was seen.
  const handler = ADMIN.slice(
    ADMIN.indexOf("router.post('/account/password'"),
    ADMIN.indexOf("router.post('/account/totp/start'")
  );
  assert.match(handler, /destroyOtherSessions\(user\.id, req\.session\.id\)/);
});

test('setting a password clears the temporary flag', () => {
  // The flag exists to force exactly this action. Leaving it set afterwards
  // would leave a permanent warning on a password that is no longer temporary.
  const src = readFileSync(path.join(ROOT, 'src', 'auth.js'), 'utf8');
  const fn = src.slice(src.indexOf('function setPassword'), src.indexOf('function listSessions'));
  assert.match(fn, /must_change_password = 0/);
});

test('turning off the second factor asks for the password', () => {
  // A borrowed session should not be able to remove the factor it bypassed.
  const handler = ADMIN.slice(
    ADMIN.indexOf("router.post('/account/totp/off'"),
    ADMIN.indexOf("router.post('/account/sessions/revoke'")
  );
  assert.match(handler, /verifyPassword\(/);
});

test('TOTP enrolment is two steps, so a lost secret cannot lock the account', () => {
  // Generating a secret and making it mandatory in one action locks the
  // operator out whenever the code never reached an authenticator, and the
  // recovery for that is shell access to the box.
  const start = ADMIN.slice(
    ADMIN.indexOf("router.post('/account/totp/start'"),
    ADMIN.indexOf("router.post('/account/totp/confirm'")
  );
  assert.match(start, /setTotpSecret\(user\.id, secret, 0\)/,
    'enrolment must store the secret unconfirmed');
  const confirm = ADMIN.slice(
    ADMIN.indexOf("router.post('/account/totp/confirm'"),
    ADMIN.indexOf("router.post('/account/totp/off'")
  );
  // verifyTotpOnce, not verifyTotp: a code is spent when it is accepted, so the
  // same six digits cannot be replayed inside their ninety second window.
  assert.match(confirm, /verifyTotpOnce\(/);
  assert.match(confirm, /setTotpSecret\(user\.id, user\.totp_secret, 1\)/);
});

test('the TOTP secret never travels in a URL', () => {
  // A secret in a query string ends up in browser history and in every proxy
  // log between the server and the screen.
  assert.equal(/redirect\([^)]*secret/i.test(ADMIN), false);
  assert.equal(/\?[a-z_]*secret=/i.test(ADMIN), false);
});

/* -------------------------------------------------- the temporary password */

test('a temporary password warns on every admin page, and does not lock it', () => {
  /*
   * A lock would defeat the point: the flag exists so a working login can be
   * handed over, and someone who cannot reach the admin cannot review it. What
   * it must not do is stay invisible.
   */
  assert.match(ADMIN, /res\.locals\.mustChangePassword/);
  assert.match(LAYOUT, /mustChangePassword/);
  assert.match(LAYOUT, /temporary password/i);
  assert.equal(
    /redirect\(303, '\/admin\/account\?first=1'\)/.test(ADMIN), false,
    'the flag must not redirect other admin routes'
  );
});

test('the account page is reachable from the admin navigation', () => {
  assert.match(LAYOUT, /href="\/admin\/account"/);
});

/* ------------------------------------------------------------- the view */

test('the account page separates the routine change from the destructive one', () => {
  // One Save button for both name and password makes the session-revoking one
  // accidental.
  const forms = [...VIEW.matchAll(/action="(\/admin\/account[^"]*)"/g)].map((m) => m[1]);
  assert.ok(forms.includes('/admin/account/profile'));
  assert.ok(forms.includes('/admin/account/password'));
  assert.notEqual(forms[0], forms[1], 'profile and password must be separate forms');
  for (const f of new Set(forms)) {
    const i = VIEW.indexOf(`action="${f}"`);
    const rest = VIEW.slice(i, i + 400);
    assert.match(rest, /name="_csrf"/, `${f} has no CSRF token`);
  }
});
