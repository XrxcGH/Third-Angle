/*
 * Contrast gate. Risk R4.
 *
 * This test exists because axe-core reports colour-contrast as "incomplete"
 * rather than as a violation whenever foreground opacity or an overlapping
 * element is involved. An opacity-based dim therefore passes the exact tool
 * meant to catch it, and CI would report green on a broken page.
 *
 * So the dim state is a token swap, and every token pair the design actually
 * uses is asserted here, in BOTH themes, with no browser involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CSS = readFileSync(path.join(ROOT, 'public', 'css', 'tokens.css'), 'utf8');

/* ---- WCAG 2.x relative luminance and contrast ratio ---- */

function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `not a 6 digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const r = srgbToLinear((n >> 16) & 255);
  const g = srgbToLinear((n >> 8) & 255);
  const b = srgbToLinear(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---- read the tokens straight out of the stylesheet ----
 * Parsing the real CSS rather than a duplicated JSON copy, so the two can
 * never drift apart. Blocks are matched by their selector.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function block(selectorFragment) {
  // Anchored to the start of a line, so the fragment has to BE the selector
  // rather than merely appear inside one. A bare indexOf matched anywhere,
  // including inside another rule's selector list: the print block groups
  // :root[data-theme="dark"] with two other selectors, so an unanchored search
  // would eventually read the print palette, assert the wrong values, and still
  // report green.
  const selector = selectorFragment.replace(/\s*\{\s*$/, '');
  const re = new RegExp('^[ \\t]*' + escapeRe(selector) + '\\s*\\{', 'm');
  const m = re.exec(CSS);
  assert.ok(m, `selector not found at the start of a line in tokens.css: ${selectorFragment}`);
  const i = m.index;
  const open = CSS.indexOf('{', i);
  let depth = 0;
  let end = open;
  for (let j = open; j < CSS.length; j++) {
    if (CSS[j] === '{') depth++;
    else if (CSS[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  const body = CSS.slice(open + 1, end);
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const light = block(':root {');
const dark = block(':root[data-theme="dark"]');

const THEMES = [['light', light], ['dark', dark]];

/* ---- the pairs the design actually uses ----
 * AA: 4.5:1 body text, 3:1 large text, and non-text UI boundaries (SC 1.4.11).
 */
const TEXT_PAIRS = [
  ['text-body', 'canvas'], ['text-body', 'surface'],
  ['text-strong', 'canvas'], ['text-strong', 'surface'],
  ['text-muted', 'canvas'], ['text-muted', 'surface'],
  ['accent-ink', 'canvas'], ['accent-ink', 'surface'],
  ['copper', 'canvas'], ['patina', 'canvas'],
  // The dim state. This is the whole point of the file.
  ['dim-text', 'canvas'], ['dim-text', 'dim-surface'],
  ['dim-title', 'canvas'], ['dim-title', 'dim-surface'],
  // Discipline labels are used on text, not only on decorative dots.
  ['ch-mechanical', 'canvas'], ['ch-electrical', 'canvas'],
  ['ch-controls', 'canvas'], ['ch-software', 'canvas'],
  ['ch-fabrication', 'canvas'], ['ch-documentation', 'canvas'],
  ['ch-business', 'canvas'], ['ch-teaching', 'canvas'],
];

const NON_TEXT_PAIRS = [
  ['accent', 'canvas'],
  ['accent', 'surface'],
];

for (const [name, t] of THEMES) {
  test(`${name}: body and label text meets WCAG AA 4.5:1`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      assert.ok(t[fg], `${name} missing token --${fg}`);
      assert.ok(t[bg], `${name} missing token --${bg}`);
      const r = contrast(t[fg], t[bg]);
      assert.ok(
        r >= 4.5,
        `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs 4.5:1 (${t[fg]} on ${t[bg]})`
      );
    }
  });

  test(`${name}: UI boundaries meet WCAG AA 3:1 non-text`, () => {
    for (const [fg, bg] of NON_TEXT_PAIRS) {
      const r = contrast(t[fg], t[bg]);
      assert.ok(r >= 3, `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs 3:1`);
    }
  });

  test(`${name}: label text on the accent solid is ink, never white`, () => {
    // White on hazard orange measures about 3.3:1 and fails. This assertion is
    // what stops the next person building an orange button with white text.
    const onAccent = contrast(t['on-accent'], t.accent);
    assert.ok(onAccent >= 4.5, `${name}: --on-accent on --accent is ${onAccent.toFixed(2)}:1`);
    const white = contrast('#FFFFFF', t.accent);
    assert.ok(
      white < 4.5,
      `${name}: white now passes on --accent (${white.toFixed(2)}:1). ` +
      'If the accent changed, re-derive --on-accent rather than deleting this test.'
    );
  });

  test(`${name}: the dim state is genuinely dimmer than normal text`, () => {
    // A dim token that is not actually dimmer means the interaction reads as
    // broken rather than as focus.
    const normal = contrast(t['text-body'], t.canvas);
    const dim = contrast(t['dim-text'], t.canvas);
    assert.ok(dim < normal, `${name}: --dim-text (${dim.toFixed(2)}) is not dimmer than --text-body (${normal.toFixed(2)})`);
  });
}

test('dark mode avoids pure black and pure white, which cause halation', () => {
  assert.notEqual(dark.canvas.toUpperCase(), '#000000');
  assert.notEqual(dark['text-body'].toUpperCase(), '#FFFFFF');
});

test('color-scheme is declared on :root, or light-dark() silently fails', () => {
  // Without this the dark theme returns the light value forever, with no error.
  assert.match(CSS, /:root\s*\{[^}]*color-scheme:\s*light dark/);
});

test('the two dark blocks are identical, or the toggle and the OS disagree', () => {
  // One dark palette is defined twice: once under prefers-color-scheme for the
  // un-stamped default state, once under [data-theme="dark"] for the explicit
  // toggle. Drift between them is invisible until someone flips the toggle on
  // a light OS and gets a different page.
  const media = block(':root:not([data-theme="light"])');
  const keys = new Set([...Object.keys(media), ...Object.keys(dark)]);
  for (const k of keys) {
    assert.equal(
      (dark[k] || '').toLowerCase(),
      (media[k] || '').toLowerCase(),
      `--${k} differs: [data-theme="dark"] has ${dark[k]}, the media query has ${media[k]}`
    );
  }
});

/* ---- the print palette ----
 * Everything on the page takes its colour from a token, and app.css forces
 * white paper. Without a print block the reader's theme tokens went onto that
 * paper: dark theme printing produced #D9DED6 body text on white, which renders
 * and is not readable. Nobody opens print preview, so this is asserted instead.
 */
const print = block('@media print');

function printBlock() {
  // The palette lives one level in, under the grouped :root selector.
  const start = CSS.indexOf('@media print');
  assert.ok(start >= 0, 'tokens.css has no @media print block');
  const body = CSS.slice(start);
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

test('print: ink on paper meets AA, whatever theme the reader had on screen', () => {
  const t = printBlock();
  for (const fg of ['text-body', 'text-strong', 'text-muted', 'dim-text', 'dim-title', 'accent-ink']) {
    assert.ok(t[fg], `print palette is missing --${fg}`);
    const r = contrast(t[fg], t.canvas);
    assert.ok(r >= 4.5, `print: --${fg} on paper is ${r.toFixed(2)}:1, needs 4.5:1`);
  }
});

test('print: every discipline channel stays legible on paper', () => {
  const t = printBlock();
  for (const k of Object.keys(t)) {
    if (!k.startsWith('ch-')) continue;
    const r = contrast(t[k], t.canvas);
    assert.ok(r >= 4.5, `print: --${k} on paper is ${r.toFixed(2)}:1, needs 4.5:1`);
  }
});

test('print: the palette covers every token the screen palettes define', () => {
  // A token defined on screen and forgotten here keeps the reader's theme
  // value on paper, which is the exact failure this block exists to close.
  const t = printBlock();
  const colourTokens = Object.keys(light);
  const missing = colourTokens.filter((k) => !(k in t));
  assert.deepEqual(missing, [], `print palette is missing: ${missing.join(', ')}`);
});

/* ---- the search hit highlight ----
 * <mark> shipped with the user-agent yellow, which belongs to no palette and
 * put near-black text on a saturated yellow block over the dark canvas.
 */
test('the search highlight is a token pair and reads in both themes', () => {
  for (const [name, t] of THEMES) {
    assert.ok(t['mark-bg'] && t['mark-ink'], `${name} is missing the --mark-* pair`);
    const r = contrast(t['mark-ink'], t['mark-bg']);
    assert.ok(r >= 4.5, `${name}: --mark-ink on --mark-bg is ${r.toFixed(2)}:1, needs 4.5:1`);
  }
});

test('no stylesheet outside tokens.css names a colour', () => {
  // DESIGN.md: nothing else defines a colour. app.css used to carry #fff and
  // #000 in its print block, which is how the dark-theme printing bug survived.
  const files = ['app.css', 'admin.css', 'icons.css', 'motion.css'];
  for (const f of files) {
    const css = readFileSync(path.join(ROOT, 'public', 'css', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = css.match(/#[0-9A-Fa-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/g) || [];
    assert.deepEqual(literals, [], `${f} defines a colour directly: ${literals.join(', ')}`);
  }
});

test('every weight token the component layer uses exists in all three palettes', () => {
  // The dark palette lowers each weight to correct the optical gain of light
  // text on a dark ground. A component that reaches for a token no palette
  // defines silently falls back to the browser default and skips that
  // correction, which is what a row of hardcoded 600s used to do.
  const app = readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
  const used = [...new Set([...app.matchAll(/var\((--w-[a-z]+)\)/g)].map((m) => m[1]))];
  assert.ok(used.length >= 3, `app.css uses only ${used.length} weight tokens, which cannot be right`);

  const weights = (selector) => {
    const i = CSS.search(new RegExp('^[ \\t]*' + escapeRe(selector) + '\\s*\\{', 'm'));
    assert.ok(i >= 0, `no block for ${selector}`);
    const open = CSS.indexOf('{', i);
    let depth = 0, end = open;
    for (let j = open; j < CSS.length; j++) {
      if (CSS[j] === '{') depth++;
      else if (CSS[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    const out = {};
    for (const m of CSS.slice(open + 1, end).matchAll(/(--w-[a-z]+)\s*:\s*(\d+)\s*;/g)) out[m[1]] = Number(m[2]);
    return out;
  };

  const palettes = {
    light: weights(':root'),
    dark: weights(':root[data-theme="dark"]'),
    'dark media query': weights(':root:not([data-theme="light"])'),
  };

  for (const [name, w] of Object.entries(palettes)) {
    for (const token of used) {
      assert.ok(token in w, `${name} palette is missing ${token}, which app.css uses`);
    }
  }

  // And the correction has to actually go the right way.
  for (const token of used) {
    assert.ok(
      palettes.dark[token] < palettes.light[token],
      `${token} is ${palettes.dark[token]} on dark and ${palettes.light[token]} on light. ` +
      'Light text on a dark ground gains optical weight, so the dark value must be lower.'
    );
  }
});

test('a hardcoded font weight in the component layer is a bug, not a style', () => {
  // The whole point of the tokens above. Enumerated exception: none.
  const app = readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const admin = readFileSync(path.join(ROOT, 'public', 'css', 'admin.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [name, css] of [['app.css', app], ['admin.css', admin]]) {
    const hard = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(hard, [], `${name} hardcodes font-weight: ${hard.join(', ')}`);
  }
});
