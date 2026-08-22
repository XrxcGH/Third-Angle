/*
 * Content gate.
 *
 * Every fixed string on the public site is a slot with a default in
 * src/content.js and an optional override in the database. Two ways that can
 * rot, both silent:
 *
 *   A template asks for a key nobody registered. The heading renders empty and
 *   the page still looks deliberate, so nothing tells you.
 *
 *   A slot is registered, the template that used it is rewritten, and the field
 *   stays in the editor forever, editable and connected to nothing.
 *
 * This walks the templates and the registry and asserts they agree in both
 * directions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const content = require(path.join(ROOT, 'src', 'content.js'));

/** Every .ejs and .js that could ask for a slot, as [path, source]. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ejs|js)$/.test(e.name)) out.push([rel, readFileSync(path.join(ROOT, rel), 'utf8')]);
    }
  };
  walk('views');
  walk('src');
  return out;
}

const SRC = sources();

/*
 * Two families are built from a variable rather than written out: the three
 * theme buttons and the five titleblock rows. They are asserted as families
 * instead of being exempted, so a missing member still fails.
 */
const DYNAMIC = [
  { pattern: /c\(`site\.theme\.\$\{opt\}`\)/, keys: ['site.theme.system', 'site.theme.light', 'site.theme.dark'] },
  {
    pattern: /c\(`home\.tb\$\{n\}\.(k|v)`\)/,
    keys: [1, 2, 3, 4, 5].flatMap((n) => [`home.tb${n}.k`, `home.tb${n}.v`]),
  },
];

/** Literal keys asked for anywhere, as key -> the files that ask. */
function asked() {
  const map = new Map();
  for (const [file, src] of SRC) {
    if (file.endsWith(path.join('src', 'content.js'))) continue;
    for (const m of src.matchAll(/\b(?:c|cr|cf|ci)\('([a-z0-9.]+)'\)/g)) {
      if (!map.has(m[1])) map.set(m[1], []);
      map.get(m[1]).push(file);
    }
    for (const m of src.matchAll(/content\.value\('([a-z0-9.]+)'\)/g)) {
      if (!map.has(m[1])) map.set(m[1], []);
      map.get(m[1]).push(file);
    }
  }
  for (const d of DYNAMIC) {
    if (SRC.some(([, src]) => d.pattern.test(src))) for (const k of d.keys) if (!map.has(k)) map.set(k, ['(built from a variable)']);
  }
  return map;
}

const ASKED = asked();

test('every key a template asks for is registered', () => {
  for (const [key, files] of ASKED) {
    assert.ok(content.BY_KEY.has(key), `${key} is used in ${files[0]} and is not in src/content.js`);
  }
});

test('every registered key is actually used', () => {
  // A field in the editor that changes nothing is worse than no field: someone
  // edits it, saves, checks the page, and finds their change did not take.
  const unused = content.SLOTS.map((s) => s.key).filter((k) => !ASKED.has(k));
  assert.deepEqual(unused, [], `registered and never read: ${unused.join(', ')}`);
});

test('keys are unique, and every slot belongs to a page in the dropdown', () => {
  const keys = content.SLOTS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate key in the registry');
  const pages = new Set(content.PAGES.map((p) => p.slug));
  for (const s of content.SLOTS) {
    assert.ok(pages.has(s.page), `${s.key} is filed under "${s.page}", which is not a page`);
  }
  for (const p of content.PAGES) {
    assert.ok(content.SLOTS.some((s) => s.page === p.slug), `the ${p.slug} page has no fields`);
  }
});

test('a slot that must not be empty has something to fall back to', () => {
  for (const s of content.SLOTS) {
    if (s.required) assert.ok(s.def.trim(), `${s.key} is required and its default is empty`);
    if (s.kind === 'flag') assert.match(s.def, /^[01]$/, `${s.key} is a flag with default ${s.def}`);
  }
});

test('the four kinds are the only kinds', () => {
  const kinds = new Set(['line', 'text', 'rich', 'image', 'flag']);
  for (const s of content.SLOTS) assert.ok(kinds.has(s.kind), `${s.key} has kind ${s.kind}`);
});

test('an unknown key throws rather than rendering nothing', () => {
  // The whole point of a closed key set. A typo in a template must fail loudly
  // in development, not produce a page with a missing heading in production.
  assert.throws(() => content.value('home.not.a.real.key'), /unknown content key/);
});

test('no template still carries a hardcoded heading', () => {
  // The conversion is only finished if the templates stopped holding copy.
  // h1 and h2 are the ones that would be noticed last, because a page with a
  // wrong-but-plausible heading reads as intentional.
  for (const [file, src] of SRC) {
    if (!file.startsWith(path.join('views', 'pages'))) continue;
    for (const m of src.matchAll(/<h[12][^>]*>([^<%][^<]*)</g)) {
      const text = m[1].trim();
      if (!text || !/[A-Za-z]{3}/.test(text)) continue;
      assert.fail(`${file} still has a literal heading: ${text}`);
    }
  }
});
