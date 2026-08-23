/*
 * What Cloudflare is allowed to keep, and who the origin thinks is asking.
 *
 * The site runs behind Cloudflare's free plan for DNS, TLS, caching and the
 * WAF, with the origin on a machine that only Cloudflare can reach. That puts
 * a shared cache and a proxy between every visitor and the app, and both of
 * them are load-bearing enough to test:
 *
 *   - a shared cache that keeps an HTML page serves one visitor's theme, and
 *     potentially one visitor's session, to the next person who asks;
 *   - a proxy that is trusted for the client address in the wrong way hands
 *     every attacker a free rate limit reset, one request header at a time.
 *
 * Neither failure is visible in a browser. Both are visible here.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mw = require('../src/middleware.js');

let server;
let base;

before(async () => {
  process.env.PORT = '0';
  const app = require('../server.js');
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

/* ---- what the edge may keep -------------------------------------------- */

test('no HTML page is storable by a shared cache', async () => {
  /*
   * The theme is a cookie the server reads to emit <html data-theme="dark"> in
   * the first byte. That is the whole reason there is no flash of the wrong
   * colours on first paint, and it is also the reason one cached copy of the
   * home page would serve one visitor's theme to everybody behind it.
   */
  const pages = ['/', '/work', '/education', '/personal', '/contact', '/search', '/now'];
  for (const p of pages) {
    const res = await fetch(base + p);
    const cc = res.headers.get('cache-control') || '';
    assert.match(cc, /private/, `${p} must not be storable by a shared cache`);
    assert.doesNotMatch(cc, /(^|[ ,])public/, `${p} must not say public`);
  }
});

test('the admin refuses to be stored at all', async () => {
  for (const p of ['/admin', '/admin/login']) {
    const res = await fetch(base + p, { redirect: 'manual' });
    assert.match(res.headers.get('cache-control') || '', /no-store/,
      `${p} is rendered against a session and must never be written down`);
  }
});

test('HTML varies by cookie, and the assets that do not, do not say so', async () => {
  /*
   * Vary is belt and braces: Cloudflare reads only Vary: Accept-Encoding, which
   * is exactly why `private` above is what actually does the work. But Vary is
   * read by browsers and by every other proxy, and left on an immutable
   * photograph it splits that cache by cookie and quietly undoes the caching.
   */
  const html = await fetch(base + '/');
  assert.match(html.headers.get('vary') || '', /Cookie/i);

  const css = await fetch(base + '/static/css/app.css');
  assert.equal(css.headers.get('vary'), null,
    'a stylesheet is the same bytes for everyone and must not be split by cookie');
});

test('the bytes that never change are cached for a year', async () => {
  const res = await fetch(base + '/og/default.png');
  assert.match(res.headers.get('cache-control') || '', /public, max-age=31536000, immutable/,
    'a content addressed URL never changes what it points at');
  assert.equal(res.headers.get('vary'), null);
});

test('the static mount writes its own cache header rather than trusting maxAge', () => {
  /*
   * This is the half of the policy that makes the site fast, and it is the half
   * that broke silently. `send` sets Cache-Control only when the response does
   * not already carry one, so the conservative default added for the HTML pages
   * above turned a year of edge caching on every font into
   * revalidate-every-time, with no error and no symptom except a slower site.
   *
   * The header is asserted from source rather than over the wire because the
   * production value is read once when server.js is loaded, and this suite
   * necessarily runs the app in test mode.
   */
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const src = readFileSync(path.join(root, 'server.js'), 'utf8');
  const mount = src.slice(src.indexOf("'/static'"), src.indexOf('mw.redirects'));
  assert.match(mount, /setHeaders:/, 'the static mount must set its own headers');
  assert.match(mount, /mw\.publicAsset\(/,
    'and it must go through the one place that decides the policy');
});

/* ---- who is asking ------------------------------------------------------ */

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers, ip: peer });

test('the real visitor address is read from Cloudflare, not from the socket', () => {
  /*
   * Behind Cloudflare every connection arrives from Cloudflare. Rate limiting
   * on the socket address limits the entire internet as one client: the first
   * person to fumble the sign in form locks out the next one.
   */
  assert.equal(mw.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(mw.clientIp(req('::1', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(mw.clientIp(req('::ffff:127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
});

test('a header from the open internet is not believed', () => {
  /*
   * CF-Connecting-IP is an ordinary request header. Anyone who finds the origin
   * and talks to it directly can write anything in it, and a rate limiter that
   * believes them has no floor: a new address per attempt is a header away.
   * Reaching the origin directly should be impossible, and this is what happens
   * on the day it is not.
   */
  assert.equal(mw.clientIp(req('198.51.100.9', { 'cf-connecting-ip': '203.0.113.7' })), '198.51.100.9');
  assert.equal(mw.clientIp(req('2001:db8::1', { 'cf-connecting-ip': '203.0.113.7' })), '2001:db8::1');
});

test('a malformed or absent Cloudflare header falls back to the socket', () => {
  assert.equal(mw.clientIp(req('127.0.0.1')), '127.0.0.1');
  assert.equal(mw.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '' })), '127.0.0.1');
  assert.equal(mw.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '   ' })), '127.0.0.1');
  /* A list is X-Forwarded-For's shape, not this header's. Anything with a
     comma in it did not come from Cloudflare, so it is not read. */
  assert.equal(mw.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7, 198.51.100.1' })), '127.0.0.1');
});

test('both rate limiters ask the same question', () => {
  /*
   * The sign in limiter and the contact form limiter each used to work out the
   * client address for themselves, which is two places to fix and one to
   * forget. There is one answer now, and this is the test that keeps it that
   * way.
   */
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  for (const f of [['src', 'routes', 'admin.js'], ['src', 'routes', 'public.js']]) {
    const src = readFileSync(path.join(root, ...f), 'utf8');
    assert.doesNotMatch(src, /req\.socket\.remoteAddress/,
      `${f.join('/')} must ask src/middleware.js who the client is, not the socket`);
  }
});
