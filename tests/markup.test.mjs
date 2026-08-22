/*
 * The renderers, and the round trip through the admin.
 *
 * Both bugs asserted here were silent data corruption: the page still rendered,
 * nothing was logged, and the damage was written back into the stored text, so
 * it could not be undone by fixing the renderer afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const markup = require('../src/markup.js');

/* ------------------------------------------------------------- line endings */

test('a form-posted body keeps its paragraphs', () => {
  /*
   * The HTML form specification requires a browser to submit textarea content
   * with CRLF line breaks, whatever the user typed. A splitter written /\n{2,}/
   * never fires on that, because a carriage return sits between the two
   * newlines. Every body saved from the admin collapsed into a single paragraph
   * of <br> breaks, and the collapsed text was what got stored back, so the
   * next save could not recover it.
   */
  const crlf = 'First paragraph.\r\n\r\nSecond paragraph.';
  const lf = 'First paragraph.\n\nSecond paragraph.';
  assert.equal(markup.paragraphs(crlf), markup.paragraphs(lf));
  assert.equal((markup.paragraphs(crlf).match(/<p>/g) || []).length, 2);
  assert.equal(markup.paragraphs(crlf).includes('<br>'), false);
});

test('a single newline is still a line break, not a paragraph', () => {
  assert.equal(markup.paragraphs('a\r\nb'), '<p>a<br>b</p>');
});

test('the rich renderer survives CRLF too', () => {
  const crlf = markup.richText('## Head\r\n\r\n- one\r\n- two\r\n\r\nTail :: value');
  const lf = markup.richText('## Head\n\n- one\n- two\n\nTail :: value');
  assert.equal(crlf, lf);
  assert.match(crlf, /<h2>Head<\/h2>/);
  assert.match(crlf, /<li>one<\/li>/);
  assert.match(crlf, /class="res-row"/);
});

/* ------------------------------------------------------------------ escaping */

test('neither renderer can emit a tag it was not asked for', () => {
  const attack = '<img src=x onerror=alert(1)>';
  assert.equal(markup.paragraphs(attack).includes('<img'), false);
  assert.equal(markup.richText(attack).includes('<img'), false);
  assert.match(markup.paragraphs(attack), /&lt;img/);
});

test('the rich renderer only links to http(s) or to this site', () => {
  // A javascript: or data: href in a link is the one construct that turns an
  // editorial page into an XSS vector.
  assert.equal(markup.richText('[x](javascript:alert(1))').includes('href="javascript'), false);
  assert.equal(markup.richText('[x](data:text/html,<script>)').includes('href="data:'), false);
  assert.match(markup.richText('[x](https://example.com)'), /href="https:\/\/example\.com"/);
  assert.match(markup.richText('[x](/work)'), /href="\/work"/);
});

/* -------------------------------------------------------------- round trip */

test('what the seed stores is what the admin would store', () => {
  /*
   * The seed used to write raw HTML into body_md while the admin's renderer
   * escapes everything it is given. Opening any seeded project in the editor
   * and pressing Save, without touching a field, published the literal tags as
   * visible text on the public page.
   */
  const seed = readFileSync(path.join(ROOT, 'scripts', 'seed.js'), 'utf8');
  const bodies = [...seed.matchAll(/body_md:\s*\[([\s\S]*?)\]\.join/g)].map((m) => m[1]);
  assert.ok(bodies.length >= 6, `expected several seeded bodies, found ${bodies.length}`);
  for (const body of bodies) {
    assert.equal(/<\/?(p|div|br|span|strong)\b/.test(body), false,
      'a seeded body_md contains HTML. body_md is plain text; body_html is what carries markup.');
  }
});

test('the seed renders through the shared renderer, not a private copy', () => {
  const seed = readFileSync(path.join(ROOT, 'scripts', 'seed.js'), 'utf8');
  assert.match(seed, /require\('\.\.\/src\/markup'\)/);
  assert.match(seed, /markup\.paragraphs\(p\.summary_md\)/);
  assert.match(seed, /markup\.paragraphs\(p\.body_md\)/);
  assert.equal(/`<p>\$\{/.test(seed), false, 'the seed must not hand-build HTML around unescaped text');
});

test('no route requires a script from scripts/', () => {
  /*
   * The page editor used to call require('../../scripts/seed-pages.js') to
   * reach its renderer. Requiring a script runs it: every page save re-ran the
   * environment assertion, the migration and the seeding loop, and would
   * recreate a page the operator had deliberately deleted.
   */
  const dir = path.join(ROOT, 'src', 'routes');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/require\(['"][^'"]*scripts\//.test(src), false,
      `src/routes/${f} requires a script, which executes it`);
  }
});

test('the admin normalises line endings before storing them', () => {
  // Otherwise body_md accumulates the CRLF the browser posts and the next
  // splitter written against \n walks into the same trap.
  const admin = readFileSync(path.join(ROOT, 'src', 'routes', 'admin.js'), 'utf8');
  for (const field of ['summary_md', 'body_md']) {
    assert.match(
      admin,
      new RegExp(`${field}: markup\\.normaliseNewlines`),
      `${field} is stored without normalising line endings`
    );
  }
});
