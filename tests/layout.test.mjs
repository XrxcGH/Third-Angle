/*
 * Layout gate.
 *
 * Every assertion here corresponds to a defect that shipped and was invisible
 * in the place people look. None of them throw an error, log a warning or fail
 * a build: they render, and the page is simply wrong. That is exactly the class
 * of bug that needs a test rather than a review.
 *
 * These parse the CSS and the templates as text, deliberately, so the suite
 * stays browser-free and runs in milliseconds. The browser-level check is the
 * screenshot sweep, which cannot live in CI on a free tier box.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const css = (f) => readFileSync(path.join(ROOT, 'public', 'css', f), 'utf8');
const APP = css('app.css');
const ADMIN = css('admin.css');

/** Every .ejs under views/, as [relativePath, source]. */
function templates() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ejs')) out.push([rel, readFileSync(path.join(ROOT, rel), 'utf8')]);
    }
  };
  walk('views');
  return out;
}

/* ------------------------------------------------------------ the gutter */

test('no template kills the page gutter with a padding shorthand on .wrap', () => {
  /*
   * .wrap sets padding-inline. An inline `padding: <y> 0` is a shorthand, and
   * an inline style outranks a class, so it reset the horizontal padding to
   * zero. The 404 and 500 pages did exactly this: on a 320px phone the heading
   * sat flush against the edge of the screen, and on desktop those two pages
   * were the only ones whose left edge did not line up with the rest of the
   * site. Nothing errors; the page simply loses its margins.
   */
  const offenders = [];
  // `wrap` as a whole class token. \bwrap\b also matches `table-wrap`, which
  // is a different class that legitimately zeroes its own padding.
  const hasWrapClass = (attr) => attr.split(/\s+/).includes('wrap');
  for (const [file, src] of templates()) {
    for (const tag of src.match(/<[a-z][^>]*>/gi) || []) {
      const cls = /class="([^"]*)"/.exec(tag);
      const style = /style="([^"]*)"/.exec(tag);
      if (!cls || !style || !hasWrapClass(cls[1])) continue;
      if (/(^|;)\s*padding\s*:/.test(style[1])) offenders.push(`${file}: ${style[1].trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    'use padding-block, or the .pad-top / .pad-page-lg classes, so the gutter survives:\n' + offenders.join('\n'));
});

/* ------------------------------------------------------- responsive grids */

test('every auto-fill grid track can collapse below its own floor', () => {
  /*
   * repeat(auto-fill, minmax(280px, 1fr)) cannot go narrower than 280px, so on
   * a 320px screen with gutters the track is wider than the column and the
   * whole document scrolls sideways. min(280px, 100%) lets the last step
   * collapse to the container. The document grid was 300px, which overflowed
   * every phone in portrait.
   */
  const bad = [];
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [name, sheet] of [['app.css', strip(APP)], ['admin.css', strip(ADMIN)]]) {
    for (const m of sheet.matchAll(/minmax\(\s*(\d+)(px|rem)\s*,/g)) {
      bad.push(`${name}: minmax(${m[1]}${m[2]}, ...) has a hard floor; wrap it in min()`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

/* -------------------------------------------------- the shared form layer */

test('form controls are defined where the public site can reach them', () => {
  /*
   * .panel, .field, .btn and .row2 lived only in admin.css, which the public
   * layout does not load. The public contact form therefore rendered as bare
   * user-agent widgets: inline labels beside default-width inputs anchored to
   * the left of a full width panel. It looked like a stylesheet had failed to
   * load, because one had.
   */
  for (const sel of ['.panel', '.field', '.btn', '.row2', '.flash', '.input']) {
    assert.ok(
      new RegExp('(^|,|\\s)' + sel.replace('.', '\\.') + '[\\s,{]').test(APP),
      `${sel} must be defined in app.css: the public layout never loads admin.css`
    );
  }
});

test('a text input fills its column instead of sitting at its default width', () => {
  const rule = APP.slice(APP.indexOf('.input,'), APP.indexOf('.input:hover'));
  assert.match(rule, /width:\s*100%/, 'inputs must fill their field');
  assert.match(rule, /max-width:\s*100%/, 'and must not overflow it');
  assert.match(rule, /min-width:\s*0/, 'and must be allowed to shrink inside a grid track');
});

test('input type is at least 16px, or iOS zooms the viewport on focus', () => {
  // And never zooms back out. The page is then stuck at 1.3x with the layout
  // clipped, on the one form a recruiter actually uses.
  const rule = APP.slice(APP.indexOf('.input,'), APP.indexOf('.input:hover'));
  assert.match(rule, /font-size:\s*max\(1rem,\s*16px\)/);
});

/* --------------------------------------------------------------- overflow */

test('a wide table is given a scroll container rather than the document', () => {
  assert.match(APP, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/,
    '.table-wrap must scroll horizontally');
  const admins = templates().filter(([f]) => f.includes(path.join('views', 'admin')));
  const withTables = admins.filter(([, src]) => src.includes('<table'));
  assert.ok(withTables.length >= 5, 'expected several admin tables to check');
  for (const [file, src] of withTables) {
    assert.ok(src.includes('table-wrap'),
      `${file} renders a table with no .table-wrap: it will push the page sideways on a phone`);
  }
});

test('the sticky footer keeps a short page from ending half way up', () => {
  assert.match(APP, /body\s*\{[^}]*min-height:\s*100dvh/, 'body needs a full viewport floor');
  assert.match(APP, /body\s*\{[^}]*flex-direction:\s*column/);
  assert.match(APP, /body\s*>\s*main\s*\{[^}]*flex:\s*1 0 auto/);
});

/* ----------------------------------------------------------------- header */

test('the header stops being one row before it runs out of room', () => {
  // Brand, six nav links and a three state theme control needed 409px. On a
  // 320px phone every page on the site carried a horizontal scrollbar.
  assert.match(APP, /\.site-header \.bar\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(APP, /@media \(max-width: 720px\)[\s\S]{0,400}\.nav\s*\{[^}]*flex:\s*1 0 100%/);
});

test('--header-h is defined, not merely defaulted', () => {
  // scroll-margin-top is derived from it so a focused card is never tucked
  // under the sticky bar. It was only ever a fallback value inside calc().
  const tokens = css('tokens.css');
  assert.match(tokens, /--header-h:\s*\d+px/, 'tokens.css must define --header-h');
  assert.match(APP, /scroll-margin-top:\s*calc\(var\(--header-h/);
  // And restated where the bar is two rows tall, or the offset is a lie.
  assert.match(APP, /@media \(max-width: 720px\)[\s\S]{0,200}--header-h:/);
});

/* ------------------------------------------------------------ the measure */

test('a divider is page width and a measure is text width, never the same box', () => {
  // .section carries a full width rule; .prose caps at 68ch. An element with
  // both stopped its rule at 68ch while every other rule on the page ran the
  // full width, which reads as a broken render rather than as a section break.
  assert.match(APP, /\.section\.prose\s*\{[^}]*max-width:\s*none/);
  assert.match(APP, /\.section\.prose\s*>\s*\*\s*\{[^}]*max-width:\s*68ch/);
});

/* --------------------------------------------------------- inline handlers */

test('no template carries an inline event handler', () => {
  // The CSP sets script-src-attr 'none', so an onclick or onfocus is silently
  // dead and logs a violation. There is no inline script anywhere by design,
  // which is also why the policy needs no nonce.
  const offenders = [];
  for (const [file, src] of templates()) {
    const withoutComments = src.replace(/<%#[\s\S]*?%>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of withoutComments.matchAll(/\son[a-z]+\s*=\s*"/g)) {
      offenders.push(`${file}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
