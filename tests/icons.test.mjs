/*
 * Discipline icons.
 *
 * Hand drawn rather than bought, because no stock pack contains this
 * vocabulary: every one offers a gear, a lightbulb, and a rocket, all three of
 * which are on the ban list. Tier 1 of the motion system, so the assertions
 * here are mostly about what is NOT present: no JavaScript, no runtime, no
 * autonomous animation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ejs = require('ejs');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TPL_PATH = path.join(ROOT, 'views', 'partials', 'icon.ejs');
const TPL = readFileSync(TPL_PATH, 'utf8');
const CSS = readFileSync(path.join(ROOT, 'public', 'css', 'icons.css'), 'utf8');

const DISCIPLINES = [
  'mechanical', 'electrical', 'controls', 'software',
  'fabrication', 'documentation', 'business', 'teaching',
];

const render = (name, size = 24) =>
  ejs.render(TPL, { name, size }, { filename: TPL_PATH });

test('every discipline has its own icon, none silently falls back', () => {
  const shapes = new Map();
  for (const name of DISCIPLINES) {
    const svg = render(name);
    assert.match(svg, new RegExp(`class="ti ti-${name}"`), `${name} did not get its own class`);

    // The fallback is two concentric circles. If a discipline renders that,
    // the icon is missing and nothing else would tell us.
    const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '');
    assert.ok(
      !/^\s*<circle cx="12" cy="12" r="8"\/>/.test(body),
      `${name} rendered the fallback mark`
    );

    // And each must be visually distinct, not the same paths reclassed.
    const key = body.replace(/\s+/g, '');
    assert.ok(!shapes.has(key), `${name} is identical to ${shapes.get(key)}`);
    shapes.set(key, name);
  }
});

test('an unknown name renders the projection mark, never a broken box', () => {
  const svg = render('not-a-discipline');
  assert.match(svg, /<circle cx="12" cy="12" r="8"/);
  assert.match(svg, /<\/svg>/);
});

test('icons are well formed SVG and inherit currentColor', () => {
  for (const name of [...DISCIPLINES, 'unknown']) {
    const svg = render(name).trim();
    assert.match(svg, /^<svg /, `${name} does not start with an svg element`);
    assert.match(svg, /<\/svg>$/, `${name} is not closed`);
    assert.equal(
      (svg.match(/<svg/g) || []).length,
      (svg.match(/<\/svg>/g) || []).length,
      `${name} has unbalanced svg tags`
    );
    // currentColor is what makes them theme for free in both palettes.
    assert.match(svg, /stroke="currentColor"/, `${name} hardcodes a stroke colour`);
    // Decorative: the adjacent text label carries the meaning.
    assert.match(svg, /aria-hidden="true"/, `${name} is not hidden from assistive tech`);
    assert.match(svg, /focusable="false"/, `${name} is focusable`);
    assert.ok(!/#[0-9a-fA-F]{3,6}/.test(svg), `${name} contains a hardcoded hex colour`);
  }
});

test('the size argument is honoured and defaults sanely', () => {
  assert.match(render('electrical', 40), /width="40" height="40"/);
  assert.match(render('electrical'), /width="24" height="24"/);
  // viewBox never changes, so every icon shares one coordinate system.
  for (const name of DISCIPLINES) {
    assert.match(render(name), /viewBox="0 0 24 24"/, `${name} uses a different grid`);
  }
});

test('no icon animates on its own, which is what avoids WCAG 2.2.2', () => {
  // Nothing may auto-animate past five seconds. The cheapest way to guarantee
  // that is to have no keyframe animation at all: every transition is driven
  // by hover or focus on a parent.
  assert.ok(!/@keyframes/.test(CSS), 'a keyframe animation appeared');
  assert.ok(!/animation\s*:/.test(CSS), 'an animation shorthand appeared');
  assert.ok(/\.icon-host:hover/.test(CSS), 'no hover driven state');
  assert.ok(/\.icon-host:focus-visible/.test(CSS), 'keyboard users get no equivalent state');
});

test('reduced motion collapses duration AND delay', () => {
  const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(block, 'no reduced-motion block');
  assert.match(block[1], /transition-duration:\s*1ms/);
  // Without killing the delay too, a "reduced" icon still animates in
  // sequence, just invisibly fast, which is worse than not handling it.
  assert.match(block[1], /transition-delay:\s*0ms/);
});

test('transitions are enumerated, never the all shorthand', () => {
  assert.ok(
    !/transition:\s*all/.test(CSS),
    'transition: all is unpredictable and costs more than naming the properties'
  );
});

test('the icon layer ships zero JavaScript', () => {
  // The entire point of tier 1. A WASM runtime for eight 24 pixel marks would
  // be the tail wagging the dog.
  for (const name of DISCIPLINES) {
    const svg = render(name);
    assert.ok(!/<script/i.test(svg), `${name} contains a script tag`);
    assert.ok(!/on[a-z]+\s*=/i.test(svg), `${name} contains an inline event handler`);
  }
  assert.ok(CSS.length < 12_000, `icons.css is ${CSS.length} bytes, larger than expected`);
});
