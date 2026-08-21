/*
 * Route smoke tests, run against the real app in-process.
 *
 * These exist because the most common failure in a server-rendered app is a
 * template referencing a local the route does not pass, which throws only at
 * render time and only on that one page. Nothing but actually rendering every
 * page catches it.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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

const PUBLIC_PAGES = [
  '/', '/work', '/work?d=electrical', '/work?d=nonexistent-discipline',
  '/disciplines', '/disciplines/controls', '/log', '/now', '/attributions',
  '/search', '/search?q=swerve', '/search?q=elctrical',
  '/feed.xml', '/feed.json', '/sitemap.xml', '/robots.txt',
  '/.well-known/security.txt', '/healthz',
  '/licenses/Literata-OFL.txt',
];

test('every public page renders', async () => {
  // Machine endpoints are legitimately short. Exempting them by name keeps the
  // check meaningful for the pages where a near-empty body means a broken
  // render, rather than loosening the threshold for everything.
  const TERSE = new Set(['/healthz', '/robots.txt', '/.well-known/security.txt']);
  for (const p of PUBLIC_PAGES) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, `${p} returned ${res.status}`);
    const body = await res.text();
    const min = TERSE.has(p) ? 2 : 200;
    assert.ok(body.length >= min, `${p} returned only ${body.length} bytes`);
  }
});

test('every published project page renders', async () => {
  const repo = require('../src/repo.js');
  for (const p of repo.listProjects()) {
    const res = await fetch(`${base}/work/${p.slug}`);
    assert.equal(res.status, 200, `/work/${p.slug} returned ${res.status}`);
  }
});

test('every discipline page renders', async () => {
  const repo = require('../src/repo.js');
  for (const f of repo.listFacets('discipline')) {
    const res = await fetch(`${base}/disciplines/${f.slug}`);
    assert.equal(res.status, 200, `/disciplines/${f.slug} returned ${res.status}`);
  }
});

test('unknown paths 404 rather than 500', async () => {
  for (const p of ['/nope', '/work/nope', '/disciplines/nope', '/licenses/nope.txt', '/media/nope.webp']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, `${p} returned ${res.status}`);
  }
});

test('hostile input on public pages never 500s', async () => {
  const nasty = [
    '/search?q=' + encodeURIComponent('"'),
    '/search?q=' + encodeURIComponent('C++'),
    '/search?q=' + encodeURIComponent('a:b^c NEAR('),
    '/search?q=' + 'x'.repeat(500),
    '/work?d=' + encodeURIComponent('<script>alert(1)</script>'),
    '/work?d[]=array',
  ];
  for (const p of nasty) {
    const res = await fetch(base + p);
    assert.ok(res.status < 500, `${p} returned ${res.status}`);
  }
});

test('a malformed cookie does not take the site down', async () => {
  for (const cookie of ['theme=100%', 'x=%E0%A4%A; theme=dark', 'a=%%%']) {
    const res = await fetch(base + '/', { headers: { cookie } });
    assert.equal(res.status, 200, `cookie "${cookie}" returned ${res.status}`);
  }
});

test('the theme cookie is honoured server side, with no inline script', async () => {
  const dark = await (await fetch(base + '/', { headers: { cookie: 'theme=dark' } })).text();
  assert.match(dark, /<html lang="en" data-theme="dark">/);

  const light = await (await fetch(base + '/', { headers: { cookie: 'theme=light' } })).text();
  assert.match(light, /data-theme="light"/);

  // No cookie means no attribute at all, so prefers-color-scheme decides.
  const system = await (await fetch(base + '/')).text();
  assert.ok(!system.includes('data-theme='), 'system state should emit no attribute');

  // A junk value must fall back to system rather than being echoed.
  const junk = await (await fetch(base + '/', { headers: { cookie: 'theme=<script>' } })).text();
  assert.ok(!junk.includes('data-theme='), 'junk theme cookie leaked into the attribute');

  /*
   * The whole no-flash theme design depends on there being no script to RUN
   * before first paint, which is also why the CSP needs no nonce.
   *
   * A `<script type="application/ld+json">` block is data, not executable
   * script: the parser never hands it to the JavaScript engine, so it cannot
   * affect paint. It is excluded here deliberately rather than by loosening
   * the assertion, so a genuinely executable inline script still fails.
   */
  const inlineScripts = [...system.matchAll(/<script\b([^>]*)>/g)]
    .map((m) => m[1])
    .filter((attrs) => !/\bsrc=/.test(attrs))
    .filter((attrs) => !/type\s*=\s*["']application\/ld\+json["']/.test(attrs));
  assert.deepEqual(inlineScripts, [], 'an executable inline script appeared');
});

test('security headers are present on every response', async () => {
  const res = await fetch(base + '/');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'no CSP');
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'inline script allowed');
  // Without style-src-attr the CSP blocks every inline style attribute in the
  // templates, and the page renders structurally correct and visually broken.
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('admin is closed to anonymous visitors', async () => {
  for (const p of ['/admin', '/admin/projects', '/admin/media', '/admin/facets', '/admin/notes']) {
    const res = await fetch(base + p, { redirect: 'manual' });
    assert.equal(res.status, 303, `${p} returned ${res.status}`);
    assert.match(res.headers.get('location') || '', /\/admin\/login/);
  }
});

test('admin mutations reject a missing CSRF token', async () => {
  for (const p of ['/admin/projects/save', '/admin/facets/save', '/admin/notes/save']) {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=x',
      redirect: 'manual',
    });
    // 303 to login (no session) or 403 (session but no token). Never 200.
    assert.ok([303, 403].includes(res.status), `${p} returned ${res.status}`);
  }
});

test('the feeds are well formed and carry entries', async () => {
  const atom = await (await fetch(base + '/feed.xml')).text();
  assert.match(atom, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(atom, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.ok(atom.includes('<entry>'), 'atom feed has no entries');
  // Unescaped content would make the document invalid, and project bodies
  // contain markup.
  assert.ok(!/<content type="html"><[a-z]/.test(atom), 'entry content is not escaped');

  const json = await (await fetch(base + '/feed.json')).json();
  assert.equal(json.version, 'https://jsonfeed.org/version/1.1');
  assert.ok(json.items.length > 0);
  for (const i of json.items) {
    assert.ok(i.id && i.url && i.title, 'feed item missing required fields');
  }
});

test('media serving refuses traversal and unknown extensions', async () => {
  for (const p of [
    '/media/../../package.json',
    '/media/..%2F..%2Fserver.js',
    '/media/%2e%2e/%2e%2e/src/db.js',
    '/media/anything.js',
    '/media/anything.html',
  ]) {
    const res = await fetch(base + p);
    assert.ok(res.status === 404, `${p} returned ${res.status}`);
  }
});
