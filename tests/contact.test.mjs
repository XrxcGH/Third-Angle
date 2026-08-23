/*
 * Contact form and singleton pages.
 *
 * No captcha, deliberately: it would need a vendor account and would be the
 * only third party script on a site whose CSP currently allows none. Three
 * cheap server side checks do the work instead, so these tests are the only
 * thing standing behind them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contact = require('../src/contact.js');
const repo = require('../src/repo.js');
const db = require('../src/db.js');
// The renderer moved to src/markup.js. Importing it from the seed script ran
// the script: assertEnvironment, migrate, and the seeding loop all fired just to
// reach one function.
const { richText: render } = require('../src/markup.js');

/* A stamp older than the minimum, so the speed check is satisfied. */
function agedStamp(secondsAgo) {
  const crypto = require('node:crypto');
  const secret = process.env.SESSION_SECRET || 'dev-only-insecure-secret';
  const t = (Date.now() - secondsAgo * 1000).toString(36);
  const sig = crypto.createHmac('sha256', secret).update(t).digest('base64url').slice(0, 24);
  return `${t}.${sig}`;
}

const good = () => ({
  t: agedStamp(10),
  name: 'Jane Reviewer',
  email: 'jane@example.com',
  subject: 'Question',
  message: 'This is a genuine message of sufficient length.',
});

test('a well formed message passes', () => {
  const r = contact.validate(good(), '1.2.3.4');
  assert.equal(r.ok, true, r.errors.join(' '));
});

test('the honeypot rejects, and nothing is stored', () => {
  const before = contact.listMessages().length;
  const r = contact.validate({ ...good(), company: 'Acme' }, '1.2.3.4');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'honeypot');
  assert.equal(contact.listMessages().length, before, 'a honeypot hit was stored');
});

test('a form submitted faster than a human could type is rejected', () => {
  const r = contact.validate({ ...good(), t: agedStamp(0) }, '1.2.3.4');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-fast');
});

test('a forged or unsigned timestamp is rejected', () => {
  for (const t of [
    'abc.deadbeefdeadbeefdeadbe',           // wrong signature
    Date.now().toString(36),                 // no signature at all
    '',
    undefined,
    'notbase36.' + 'x'.repeat(24),
    agedStamp(10).replace(/.$/, 'A'),        // tampered signature
  ]) {
    const r = contact.validate({ ...good(), t }, '1.2.3.4');
    assert.equal(r.ok, false, `accepted stamp ${JSON.stringify(t)}`);
    assert.equal(r.reason, 'bad-stamp');
  }
});

test('an ancient form is rejected rather than accepted forever', () => {
  const r = contact.validate({ ...good(), t: agedStamp(60 * 60 * 24) }, '1.2.3.4');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('missing or malformed fields are refused with a usable message', () => {
  const cases = [
    [{ name: '' }, /name/i],
    [{ email: 'not-an-email' }, /email/i],
    [{ email: '' }, /email/i],
    [{ message: 'short' }, /more/i],
  ];
  for (const [patch, pattern] of cases) {
    const r = contact.validate({ ...good(), ...patch }, '1.2.3.4');
    assert.equal(r.ok, false, `accepted ${JSON.stringify(patch)}`);
    assert.ok(r.errors.some((e) => pattern.test(e)), `no matching message for ${JSON.stringify(patch)}`);
  }
});

test('validate never throws, whatever it is handed', () => {
  for (const body of [{}, null, undefined, { name: {} }, { message: [] }, { t: 42 }]) {
    assert.doesNotThrow(() => contact.validate(body || {}, '1.2.3.4'));
  }
});

test('input is truncated rather than stored unbounded', () => {
  const r = contact.validate({ ...good(), name: 'x'.repeat(5000), message: 'y'.repeat(50_000) }, '1.2.3.4');
  assert.ok(r.values.name.length <= contact.LIMITS.name);
  assert.ok(r.values.message.length <= contact.LIMITS.body);
});

test('the per-IP limit fires and does not punish a different address', () => {
  const ip = '203.0.113.99';
  db.run('DELETE FROM message WHERE ip = ?', ip);
  try {
    for (let i = 0; i < contact.PER_IP_PER_HOUR; i++) {
      const r = contact.validate(good(), ip);
      assert.equal(r.ok, true, `submission ${i + 1} was rejected early`);
      contact.store(r.values, { ip });
    }
    const blocked = contact.validate(good(), ip);
    assert.equal(blocked.ok, false, 'the limit never fired');
    assert.equal(blocked.reason, 'rate-limited');

    // A different visitor must not be caught by someone else's flood.
    assert.equal(contact.validate(good(), '203.0.113.100').ok, true);
  } finally {
    db.run('DELETE FROM message WHERE ip IN (?, ?)', ip, '203.0.113.100');
  }
});

/* ------------------------------------------------------------------ pages */

test('the page renderer escapes markup before adding anything back', () => {
  const html = render('<script>alert(1)</script>\n\n**bold** and <b>raw</b>');
  assert.ok(!html.includes('<script>'), 'a script tag survived');
  assert.ok(!html.includes('<b>raw</b>'), 'raw markup survived');
  assert.ok(html.includes('&lt;script&gt;'), 'the script tag was not escaped');
  assert.ok(html.includes('<strong>bold</strong>'), 'bold was not rendered');
});

test('the page renderer only linkifies http and site-relative URLs', () => {
  assert.match(render('[x](https://example.com)'), /<a href="https:\/\/example\.com">x<\/a>/);
  assert.match(render('[x](/work)'), /<a href="\/work">x<\/a>/);
  // javascript: and data: must not become links.
  const bad = render('[x](javascript:alert(1))');
  assert.ok(!/<a /.test(bad), 'a javascript: URL became a link');
});

test('page slugs are a closed set, so a URL cannot be invented', () => {
  assert.ok(repo.PAGE_SLUGS.includes('resume'));
  assert.equal(repo.getPage('nope'), null);
  assert.equal(repo.getPageForEdit('../../etc/passwd'), null);
  assert.throws(() => repo.savePage('arbitrary', { title: 'x', body_md: '', body_html: '' }), /Unknown page/);
});

test('the old resume address still resolves, permanently', () => {
  /*
   * The separate resume page is gone: the PDF is one of the documents, pinned
   * at the top of /documents with a reader, a download, and search inside it.
   * The address is on applications and in email signatures, which cannot be
   * edited afterwards, so it redirects rather than 404s.
   */
  const routes = readFileSync(path.join(ROOT, 'src', 'routes', 'public.js'), 'utf8');
  assert.match(routes, /router\.get\('\/resume', \(req, res\) => res\.redirect\(301, '\/documents'\)\)/);
  assert.match(routes, /\\\/resume\\\/\[A-Za-z0-9_\.-\]\+\\\.pdf/);
});
