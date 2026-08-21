/*
 * Structured data and social cards.
 *
 * A link to this site is usually met somewhere else first: a recruiter's
 * Slack, a LinkedIn message, a search result. These assertions cover the part
 * of the site that only ever renders somewhere you cannot see it.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const seo = require('../src/seo.js');

let server;
let base;

before(async () => {
  const app = require('../server.js');
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => { if (server) server.close(); });

const parseLd = (html) => {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'no JSON-LD block');
  return JSON.parse(m[1]);
};

test('every page carries valid JSON-LD with a stable person identity', async () => {
  for (const p of ['/', '/work', '/work/summit-push', '/disciplines/controls']) {
    const html = await (await fetch(base + p)).text();
    let data;
    assert.doesNotThrow(() => { data = parseLd(html); }, `${p} JSON-LD does not parse`);

    assert.equal(data['@context'], 'https://schema.org');
    assert.ok(Array.isArray(data['@graph']) && data['@graph'].length, `${p} graph is empty`);
    for (const node of data['@graph']) {
      assert.ok(node['@type'], `${p} has a graph node with no @type`);
    }

    const person = data['@graph'].find((n) => n['@type'] === 'Person');
    assert.ok(person, `${p} has no Person node`);
    // The stable @id reused across every page is what lets a search engine
    // merge this site, LinkedIn and GitHub into one entity rather than three.
    assert.ok(person['@id'].endsWith('#eric-dean'), 'Person @id is not stable');
    assert.ok(person.sameAs.some((u) => u.includes('github.com/XrxcGH')));
    assert.ok(person.sameAs.some((u) => u.includes('linkedin.com/in/edean07')));
  }
});

test('a software-led project is typed as code, a document-led one is not', async () => {
  const nodeFor = async (slug) => {
    const data = parseLd(await (await fetch(`${base}/work/${slug}`)).text());
    return data['@graph'].find((n) => n['@id'] && n['@id'].includes('/work/'));
  };

  const soft = await nodeFor('frc-robot-template');
  assert.equal(soft['@type'], 'SoftwareSourceCode');
  assert.ok(soft.codeRepository, 'software project has no codeRepository');

  // Claiming everything is software would be wrong, and the whole argument of
  // this portfolio is that most of it is not.
  const doc = await nodeFor('wrrf-workspace');
  assert.equal(doc['@type'], 'CreativeWork');
});

test('breadcrumbs are positioned and complete', async () => {
  const data = parseLd(await (await fetch(base + '/work/summit-push')).text());
  const crumbs = data['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
  assert.ok(crumbs, 'no BreadcrumbList');
  crumbs.itemListElement.forEach((item, i) => {
    assert.equal(item.position, i + 1, 'breadcrumb positions are not sequential from 1');
    assert.ok(item.name && item.item, 'breadcrumb missing name or item');
    assert.match(item.item, /^https?:\/\//, 'breadcrumb item is not an absolute URL');
  });
});

test('social cards are absolute, correctly sized, and actually render', async () => {
  const html = await (await fetch(base + '/work/summit-push')).text();
  const img = /<meta property="og:image" content="([^"]+)"/.exec(html);
  assert.ok(img, 'no og:image');
  // Several platforms will not resolve a relative image URL.
  assert.match(img[1], /^https?:\/\//, 'og:image is not absolute');
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta property="og:image:height" content="630">/);
  assert.match(html, /<meta property="og:image:alt"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);

  const res = await fetch(img[1]);
  assert.equal(res.status, 200, 'og:image does not render');
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bytes = (await res.arrayBuffer()).byteLength;
  // Under 300 KB, the practical ceiling before some platforms drop the preview.
  assert.ok(bytes > 1000 && bytes < 300_000, `og image is ${bytes} bytes`);
});

test('two different pages get two different cards', async () => {
  const grab = async (p) =>
    /<meta property="og:image" content="([^"]+)"/.exec(await (await fetch(base + p)).text())[1];
  assert.notEqual(await grab('/work/summit-push'), await grab('/work/pumpkinlib'));
});

test('an unknown card key falls back rather than 404ing a crawler', async () => {
  // A crawler can reach the image before it reaches the page that registered
  // it, so a miss must degrade to the default card.
  const res = await fetch(`${base}/og/${'a'.repeat(16)}.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('a malformed card key is rejected rather than touching the filesystem', async () => {
  for (const key of ['../../server', 'not-hex-at-all', 'aaaa', 'a'.repeat(64)]) {
    const res = await fetch(`${base}/og/${encodeURIComponent(key)}.png`);
    assert.equal(res.status, 404, `key "${key}" returned ${res.status}`);
  }
});

test('the card generator wraps and escapes rather than producing broken SVG', () => {
  const svg = seo.ogSvg({
    title: 'A very long project title that will certainly need to wrap onto several lines',
    subtitle: 'With <script>alert(1)</script> & an ampersand',
    eyebrow: 'Test',
  });
  assert.match(svg, /^<svg xmlns=/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(!svg.includes('<script>'), 'markup was not escaped into the SVG');
  assert.ok(svg.includes('&amp;'), 'ampersand was not escaped');

  // Wrapping must terminate and respect its line cap rather than overflowing.
  const lines = seo.wrap('one two three four five six seven eight nine ten', 12, 3);
  assert.ok(lines.length <= 3, `wrap returned ${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= 12, `line too long: ${l}`);
  assert.deepEqual(seo.wrap('', 20, 2), []);
  assert.deepEqual(seo.wrap(null, 20, 2), []);
});

test('card keys are content addressed, so editing a title makes a new URL', () => {
  const a = seo.ogKey({ title: 'One' });
  const b = seo.ogKey({ title: 'One' });
  const c = seo.ogKey({ title: 'Two' });
  assert.equal(a, b, 'same content produced different keys');
  assert.notEqual(a, c, 'different content produced the same key');
  assert.match(a, /^[0-9a-f]{16}$/);
});
