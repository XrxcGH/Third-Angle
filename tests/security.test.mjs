import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { safeBackPath } = require('../src/routes/public.js');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

test('every admin address sends a signed-out visitor to the login screen', () => {
  /*
   * Enumerated from the source rather than from a hand-kept list, so a route
   * added later is covered by this test the day it is written. The guard has to
   * be the router's, not each route's: one handler that forgets it is the whole
   * admin surface open.
   */
  const src = read('src', 'routes', 'admin.js');

  // The guard is installed before any route, and it is a redirect, not a 403.
  const guard = src.slice(0, src.indexOf("router.get('/'"));
  assert.match(guard, /router\.use\(/, 'the admin router must install a guard before its routes');
  assert.match(src, /redirect\(303, [`'"]\/admin\/login/,
    'a signed out visitor must be sent to the login screen, not refused');

  // Login is the one address that must answer without a session.
  const opened = [...src.matchAll(/router\.(get|post)\(\s*'([^']+)'/g)]
    .map((m) => m[2])
    .filter((p) => !p.startsWith('/login'));
  assert.ok(opened.length > 10, 'expected the admin to have real routes to protect');
});

test('a temporary password closes the admin rather than only warning about it', () => {
  /*
   * A hand-over credential is one that has been transmitted somewhere, and it
   * is exempt from the twelve character floor a chosen password has to clear.
   * This used to be a banner, and a banner is dismissed by scrolling.
   */
  const src = read('src', 'routes', 'admin.js');
  const start = src.indexOf('OPEN_WHILE_LOCKED');
  const block = src.slice(start, start + 700);
  assert.match(block, /OPEN_WHILE_LOCKED\s*=\s*\['\/account', '\/logout'\]/,
    'only the page that replaces the password and the way out may answer');
  assert.match(block, /redirect\(303, '\/admin\/account/);
});

test('safeBackPath allows ordinary in-site paths', () => {
  for (const p of ['/', '/work', '/work?d=electrical', '/disciplines/controls']) {
    assert.equal(safeBackPath(p), p);
  }
});

test('safeBackPath refuses off-site redirects', () => {
  // '//host' and '/\host' are protocol relative and a browser follows them off
  // site. A bare startsWith('/') check lets both through.
  for (const p of [
    '//evil.com', String.raw`/\evil.com`, 'https://evil.com', 'http://evil.com',
    '//evil.com/path', 'javascript:alert(1)', '',
  ]) {
    assert.equal(safeBackPath(p), '/', `expected / for ${JSON.stringify(p)}`);
  }
});

test('safeBackPath refuses traversal, header splitting, and junk types', () => {
  assert.equal(safeBackPath('/../etc/passwd'), '/');
  assert.equal(safeBackPath('/work\r\nSet-Cookie: a=b'), '/');
  assert.equal(safeBackPath('/' + 'a'.repeat(600)), '/');
  assert.equal(safeBackPath(undefined), '/');
  assert.equal(safeBackPath(null), '/');
  assert.equal(safeBackPath(42), '/');
  assert.equal(safeBackPath({}), '/');
});

/* ------------------------------------------------------- the public repo */

test('production refuses to boot without a session secret', () => {
  /*
   * csrfToken() is an HMAC under SESSION_SECRET, and it falls back to a fixed
   * development string that is in this repository. In production that means
   * anyone can compute a valid token for a known session id and every mutating
   * admin route accepts a cross-site POST. Nothing about the running site would
   * look wrong, so the boot has to refuse instead.
   */
  const db = readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8');
  assert.match(db, /NODE_ENV === 'production'[\s\S]{0,400}SESSION_SECRET/);
  assert.match(db, /secret\.length < 32/);
});

test('HSTS is sent in production and nowhere else', () => {
  // Cached on localhost it makes local development unreachable until the
  // reader clears it by hand, so it is gated rather than unconditional.
  const mw = readFileSync(path.join(ROOT, 'src', 'middleware.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(mw, /production[\s\S]{0,200}Strict-Transport-Security/);
  const header = mw.match(/'Strict-Transport-Security',\s*'([^']*)'/);
  assert.ok(header, 'no HSTS value found');
  assert.match(header[1], /max-age=31536000/);
  assert.equal(/preload/.test(header[1]), false, 'HSTS preload is a one way door; do not send it');
});

test('a document is never served through the media route', () => {
  // /documents/:slug/view and /download check visibility. /media checks the
  // path and nothing else, so a private PDF was readable by anyone holding its
  // storage key: two paths to the same bytes, one of them unguarded.
  const media = readFileSync(path.join(ROOT, 'src', 'routes', 'media.js'), 'utf8');
  assert.match(media, /docsRoot/);
  assert.match(media, /abs === docsRoot \|\| abs\.startsWith\(docsRoot \+ path\.sep\)/);
});

test('a search excerpt is escaped before its highlight is put back', () => {
  // The excerpt is the one string rendered with <%- on a public page. plain()
  // strips HTML on the way into the index; this is the second line, at the
  // boundary where it would actually be emitted.
  const repo = readFileSync(path.join(ROOT, 'src', 'repo.js'), 'utf8');
  assert.match(repo, /snippet\(search_fts, 2, '\$\{MARK_OPEN\}'/);
  assert.match(repo, /escapeHtml\(String\(excerpt/);
  assert.equal(/snippet\([^)]*'<mark>'/.test(repo), false, 'snippet must not emit tags directly');
});
