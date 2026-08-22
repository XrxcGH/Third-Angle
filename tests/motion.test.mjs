/*
 * Motion gate.
 *
 * The motion layer is the one part of this site that can make content
 * disappear. A scroll reveal starts an element at opacity 0 and relies on a
 * browser feature to finish the job; if that feature is missing, or the reader
 * has asked for less motion, the same rule leaves text invisible with no error
 * anywhere. Every assertion below is that failure, written down.
 *
 * The browser-level check is scratchpad motioncheck.mjs, which scrolls thirteen
 * pages at five positions and asserts that nothing entirely inside the window
 * is ever less than fully opaque. This file is the part that can run in CI in
 * milliseconds with no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const MOTION = read('public', 'css', 'motion.css');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const CODE = strip(MOTION);

/** The text of every at-rule block whose prelude matches, braces balanced. */
function blocks(css, preludeRe) {
  const out = [];
  for (const m of css.matchAll(preludeRe)) {
    const open = css.indexOf('{', m.index);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { out.push(css.slice(open + 1, i)); break; } }
    }
  }
  return out;
}

const NO_PREFERENCE = blocks(CODE, /@media\s*\(prefers-reduced-motion:\s*no-preference\)/g).join('\n');

test('the motion layer is actually loaded, on both layouts', () => {
  for (const layout of ['layout.ejs', 'layout-admin.ejs']) {
    assert.match(
      read('views', layout),
      /<link rel="stylesheet" href="\/static\/css\/motion\.css">/,
      `${layout} does not load motion.css`
    );
  }
});

test('nothing that starts an element invisible sits outside a no-preference query', () => {
  // The failure this prevents: a reader with reduced motion turned on gets a
  // page of blank space, because the reveal set opacity 0 and then the same
  // preference stopped anything from setting it back.
  const reveals = [...CODE.matchAll(/animation:\s*(rise-in|fade-in)[^;]*;/g)];
  assert.ok(reveals.length >= 3, `expected several reveals, found ${reveals.length}`);
  for (const r of reveals) {
    assert.ok(
      NO_PREFERENCE.includes(r[0]),
      `a reveal is outside @media (prefers-reduced-motion: no-preference): ${r[0]}`
    );
  }
});

test('every scroll-driven reveal is also behind an @supports for the feature', () => {
  // A browser without scroll-driven animations applies `animation-name` and
  // `fill: both` happily, ignores `animation-timeline`, and runs the animation
  // once on a time basis. Without the guard that is a page that flashes its
  // content in and then, on an unsupported timeline, may never arrive.
  const supported = blocks(CODE, /@supports\s*\(animation-timeline:\s*(view|scroll)\(\)\)/g).join('\n');
  // The declaration, not the @supports prelude: a declaration ends in `);`.
  for (const m of CODE.matchAll(/animation-timeline:\s*(?:view|scroll)\([^)]*\);/g)) {
    assert.ok(supported.includes(m[0]), `outside @supports: ${m[0]}`);
  }
  assert.ok(supported.length > 0, 'no @supports block found at all');
});

test('a reveal range can never outlast the element being fully on screen', () => {
  // A bare percentage is a percentage of the element's own height, so a tall
  // section is still fading in while it is being read. A bare length is worse
  // for a short one: a 60px tile is fully visible after 60px of scrolling and
  // would still be at a third of its opacity. Only the minimum of the two is
  // correct, and the invariant is that nothing fully on screen is transparent.
  const ranges = [...CODE.matchAll(/animation-range:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(ranges.length >= 2, 'expected the reveal ranges to be declared');
  for (const r of ranges) {
    if (/^\d+\s+\d+px$/.test(r)) continue;               // the header settle, a fixed scroll distance
    assert.match(r, /min\(100%,\s*\d+px\)/, `range does not cap at fully-entered: ${r}`);
  }
});

test('entrances move with `translate`, interactions with `transform`', () => {
  // Both are transforms in the visual sense and separate properties in the
  // cascade. Sharing one would mean a card that is still arriving cannot also
  // be pressed: the animation holds the value and the interaction is dropped.
  const rise = CODE.match(/@keyframes rise-in\s*\{[^}]*\}[^}]*\}/);
  assert.ok(rise, 'no rise-in keyframes');
  assert.match(rise[0], /translate:/);
  assert.equal(/transform:/.test(rise[0]), false, 'rise-in animates transform, which collides with hover and press');
});

test('nothing animates on its own', () => {
  // WCAG 2.2.2 applies to anything that moves for more than five seconds
  // without the reader starting it. The simplest way to be exempt is to own no
  // loops at all: every animation here is driven by a pointer, a page load, or
  // the reader's own scrolling.
  for (const f of ['motion.css', 'app.css', 'icons.css', 'admin.css']) {
    const css = strip(read('public', 'css', f));
    assert.equal(/infinite|alternate\b/.test(css), false, `${f} declares a looping animation`);
  }
});

test('page transitions are opt-in per reader preference', () => {
  assert.match(NO_PREFERENCE, /@view-transition\s*\{\s*navigation:\s*auto;\s*\}/,
    '@view-transition must sit inside the no-preference query');
});

test('reduced motion is answered, and paper is answered too', () => {
  const reduce = blocks(CODE, /@media\s*\(prefers-reduced-motion:\s*reduce\)/g).join('\n');
  assert.match(reduce, /animation-duration:\s*1ms\s*!important/);
  assert.match(reduce, /transition-duration:\s*1ms\s*!important/);
  assert.match(reduce, /scroll-behavior:\s*auto\s*!important/);

  // Paper does not scroll, so a page printed mid-reveal would print half
  // transparent. This is the one place opacity is forced back.
  const print = blocks(CODE, /@media\s*print/g).join('\n');
  assert.match(print, /opacity:\s*1\s*!important/);
  assert.match(print, /animation:\s*none\s*!important/);
});

test('smooth scrolling is a preference, not a default', () => {
  assert.match(NO_PREFERENCE, /scroll-behavior:\s*smooth/);
  // And an anchored jump still has to clear the sticky header.
  assert.match(CODE, /scroll-padding-top:\s*calc\(var\(--header-h\)/);
});
