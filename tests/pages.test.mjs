/*
 * The pages added for the professional profile, education, the photo collage
 * and the document library, plus the capitalisation rule that ties them
 * together.
 *
 * Text-level and unit assertions, so the suite stays browser-free. The browser
 * level checks are the screenshot and overflow sweep, which cannot run in CI on
 * a free tier box.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const labels = require('../src/labels.js');
const collage = require('../src/collage.js');
const settings = require('../src/settings.js');
const github = require('../src/github.js');

/* ------------------------------------------------------- capitalisation */

test('title case follows the stated rule rather than capitalising everything', () => {
  // The rule is in src/labels.js: first and last word always, short articles,
  // conjunctions and prepositions lowercase in between.
  assert.equal(labels.titleCase('open in a new tab'), 'Open in a New Tab');
  assert.equal(labels.titleCase('read the resume'), 'Read the Resume');
  assert.equal(labels.titleCase('beyond the bench'), 'Beyond the Bench');
  // A minor word that lands last is still capitalised.
  assert.equal(labels.titleCase('what I am working on'), 'What I Am Working On');
});

test('title case does not flatten a name that owns its own capitals', () => {
  for (const name of ['iD Tech', 'PhotonVision', 'GitHub', 'LinkedIn', 'McMaster', 'PDFs']) {
    assert.equal(labels.titleCase(name), name, `${name} was rewritten`);
  }
  assert.equal(labels.titleCase('cad drawings'), 'CAD Drawings');
  assert.equal(labels.titleCase('the pdf and the cv'), 'The PDF and the CV');
});

test('every stored enum has one label, used everywhere', () => {
  /*
   * Before src/labels.js each template printed enum values with its own
   * .replace(), so 'case-study' appeared as "case-study", "case study" and
   * "Case Study" on three different screens.
   */
  assert.equal(labels.label('tier', 'case-study'), 'Case Study');
  assert.equal(labels.label('status', 'in-progress'), 'In Progress');
  assert.equal(labels.label('mediaKind', 'cad_render'), 'CAD Render');
  assert.equal(labels.label('docRole', 'cv'), 'CV');
  // An unknown value is title cased rather than shown raw or dropped.
  assert.equal(labels.label('status', 'brand-new-value'), 'Brand New Value');
});

test('no template prints a raw enum value', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { walk(rel); continue; }
      if (!e.name.endsWith('.ejs')) continue;
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      // The ad hoc rewrites this file exists to replace.
      for (const m of src.matchAll(/\.(status|tier|kind|weight|origin|visibility)\s*\.replace\(/g)) {
        offenders.push(`${rel}: ${m[0]}`);
      }
    }
  };
  walk('views');
  assert.deepEqual(offenders, [], `use label() instead:\n${offenders.join('\n')}`);
});

/* -------------------------------------------------------------- collage */

test('an extreme aspect ratio is clamped for layout and kept for the image', () => {
  // A 6:1 panorama would take a whole row on its own and a 1:4 portrait would
  // become a sliver. Both are real photographs somebody will upload.
  const wide = collage.tile({ id: 1, width: 6000, height: 1000, storage_key: 'k', mime: 'image/webp' });
  const tall = collage.tile({ id: 2, width: 1000, height: 4000, storage_key: 'k', mime: 'image/webp' });
  assert.equal(wide.aspect, collage.MAX_ASPECT);
  assert.equal(wide.trueAspect, 6);
  assert.equal(wide.clamped, true);
  assert.equal(tall.aspect, collage.MIN_ASPECT);
  assert.equal(tall.clamped, true);

  const normal = collage.tile({ id: 3, width: 1600, height: 1200, storage_key: 'k', mime: 'image/webp' });
  assert.equal(normal.aspect, normal.trueAspect);
  assert.equal(normal.clamped, false);
});

test('a photograph with no dimensions cannot break a row', () => {
  // albumPhotos filters these out in SQL, and the tile falls back to square
  // rather than to NaN if one ever reaches here.
  const t = collage.tile({ id: 4, width: null, height: null, storage_key: 'k', mime: 'image/webp' });
  assert.equal(Number.isFinite(t.aspect), true);
  assert.equal(t.aspect, 1);
});

test('the row height falls as the album grows', () => {
  const heights = [2, 6, 15, 60].map(collage.rowHeight);
  for (let i = 1; i < heights.length; i++) {
    assert.ok(heights[i] < heights[i - 1], 'a longer album must use a shorter row');
  }
});

test('the collage is packed by CSS, not by a stored order', () => {
  /*
   * The whole point: nothing here computes a row. A server that decided row
   * breaks would have to assume a viewport width it does not know, and the
   * layout would be wrong at every other width.
   */
  const src = read('src', 'collage.js');
  assert.equal(/row(s)?\s*=\s*\[/.test(src), false, 'collage.js must not build rows');
  const css = read('public', 'css', 'app.css');
  assert.match(css, /flex-basis: calc\(var\(--ar\)/);
  assert.match(css, /flex-grow: var\(--ar\)/);
  // The hovered tile grows and its neighbours give up the width.
  assert.match(css, /\.collage-item:hover[\s\S]{0,120}flex-grow: calc\(var\(--ar\) \* var\(--tile-hover\)\)/);
});

test('the last row is not stretched across the whole width', () => {
  // Without the filler, flex-grow makes the final one or two photographs
  // enormous and a wall of tidy rows ends in a billboard.
  const css = read('public', 'css', 'app.css');
  const filler = css.slice(css.indexOf('.collage::after'), css.indexOf('.collage-item {'));
  assert.match(filler, /flex-grow: \d+/);
  assert.match(filler, /flex-basis: 0/);
});

/* ------------------------------------------------------------- settings */

test('an unknown setting key throws rather than writing a row nobody reads', () => {
  assert.throws(() => settings.setSetting('pdf_veiwer', true), /Unknown setting/);
  assert.throws(() => settings.getSetting('nonsense'), /Unknown setting/);
});

test('every setting has a default, so a fresh install renders', () => {
  for (const key of settings.KEYS) {
    const def = settings.DEFINITIONS[key];
    assert.ok('default' in def, `${key} has no default`);
    assert.ok(def.label && def.help, `${key} has no label or help text`);
    assert.ok(['bool', 'text'].includes(def.type), `${key} has an unknown type`);
  }
});

test('an unchecked box turns a setting off', () => {
  // A checkbox that is not ticked is simply not submitted. Reading only what
  // arrived would make a switch impossible to turn off.
  const before = settings.getSetting('linkedin_badge');
  settings.saveFromForm({ linkedin_badge: '1' });
  assert.equal(settings.getSetting('linkedin_badge'), true);
  settings.saveFromForm({});
  assert.equal(settings.getSetting('linkedin_badge'), false);
  settings.setSetting('linkedin_badge', before);
});

/* ------------------------------------------- the policy the switches move */

test('the Content Security Policy opens only for what is switched on', () => {
  const mw = require('../src/middleware.js');
  const capture = () => {
    const headers = {};
    mw.securityHeaders({}, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
    return headers['Content-Security-Policy'];
  };

  const savedBadge = settings.getSetting('linkedin_badge');
  const savedPdf = settings.getSetting('pdf_viewer');
  try {
    settings.setSetting('linkedin_badge', false);
    settings.setSetting('pdf_viewer', false);
    const closed = capture();
    assert.match(closed, /script-src 'self';/);
    assert.match(closed, /object-src 'none'/);
    assert.match(closed, /frame-src 'none'/);
    assert.equal(closed.includes('linkedin.com'), false);

    settings.setSetting('pdf_viewer', true);
    const withPdf = capture();
    /*
     * Both directives, not one. Chrome renders a PDF <object> through its
     * internal viewer and checks frame-src as well as object-src, so allowing
     * only object-src still refused to load it and the page silently fell back.
     */
    assert.match(withPdf, /object-src 'self'/);
    assert.match(withPdf, /frame-src [^;]*'self'/);
    assert.equal(withPdf.includes('linkedin.com'), false, 'the PDF switch must not open LinkedIn');

    settings.setSetting('linkedin_badge', true);
    const withBadge = capture();
    assert.match(withBadge, /script-src 'self' https:\/\/platform\.linkedin\.com/);
    assert.match(withBadge, /frame-src [^;]*https:\/\/www\.linkedin\.com/);
  } finally {
    settings.setSetting('linkedin_badge', savedBadge);
    settings.setSetting('pdf_viewer', savedPdf);
  }
});

/* --------------------------------------------------------------- github */

test('repositories rank by stars, then recency, with forks and archives last', () => {
  const ranked = github.rankRepos([
    { name: 'archived', stars: 99, archived: true, fork: false, pushedAt: '2026-08-01' },
    { name: 'fork', stars: 50, archived: false, fork: true, pushedAt: '2026-08-01' },
    { name: 'popular', stars: 10, archived: false, fork: false, pushedAt: '2026-01-01' },
    { name: 'recent', stars: 10, archived: false, fork: false, pushedAt: '2026-08-20' },
  ]);
  assert.deepEqual(ranked.map((r) => r.name), ['recent', 'popular', 'fork', 'archived']);
});

test('only the fields the page renders are kept from a GitHub response', () => {
  // A full user object is about forty fields of URLs. Storing the rest would
  // put data in the cache that nobody chose to publish.
  const shaped = github.shapeProfile({
    login: 'x', name: 'X', public_repos: 1, html_url: 'u',
    email: 'private@example.com', two_factor_authentication: true,
  });
  assert.equal('email' in shaped, false);
  assert.equal('two_factor_authentication' in shaped, false);
  assert.equal(shaped.login, 'x');
});

test('the language mix is a share of the repositories, and adds up', () => {
  const mix = github.languageMix([
    { language: 'Java' }, { language: 'Java' }, { language: 'JavaScript' }, { language: null },
  ]);
  assert.deepEqual(mix.map((m) => m.language), ['Java', 'JavaScript']);
  assert.equal(mix[0].share, 67);
  assert.equal(mix.reduce((n, m) => n + m.count, 0), 3, 'a repository with no language is not counted');
});

/* ------------------------------------------------------------ templates */

test('the contact form exists once, as a partial', () => {
  /*
   * Two pages carry it. A copied form is how one of them ends up without a
   * honeypot or a stamp six months later, and the failure is silent: the form
   * still submits, it just stops being defended.
   */
  const partial = read('views', 'partials', 'contact-form.ejs');
  assert.match(partial, /name="t"/, 'the signed stamp is missing');
  assert.match(partial, /class="honeypot"/, 'the honeypot is missing');

  for (const page of ['contact.ejs', 'professional.ejs']) {
    const src = read('views', 'pages', page);
    assert.match(src, /include\('\.\.\/partials\/contact-form'/, `${page} does not use the partial`);
    assert.equal(/name="company"/.test(src), false, `${page} has its own copy of the form`);
  }
});

test('the personal page renders albums and never a stored order', () => {
  const src = read('views', 'pages', 'personal.ejs');
  assert.match(src, /class="collage"/);
  assert.match(src, /--ar: <%= t\.aspect %>/);
  // Focusable, or the wall cannot be explored from a keyboard.
  assert.match(src, /tabindex="0"/);
});

test('the document library pins the resume and the CV by role', () => {
  const routes = read('src', 'routes', 'public.js');
  assert.match(routes, /doc_role === 'resume' \|\| d\.doc_role === 'cv'/);
  const view = read('views', 'pages', 'documents.ejs');
  // Every document offers both: read it here, or take it away.
  assert.match(view, /\/view" target="_blank"/);
  assert.match(view, /\/download">/);
});

test('a download is named after the document, not after its storage key', () => {
  // A reviewer who downloads the resume should not end up with
  // a7cb5788cb9189b2d941431c9fc5b163.pdf in their downloads folder.
  const routes = read('src', 'routes', 'public.js');
  assert.match(routes, /attachment; filename="\$\{documents\.slugify\(doc\.title\)\}\.pdf"/);
});

test('the inline PDF response carries its own restrictive policy', () => {
  const routes = read('src', 'routes', 'public.js');
  const handler = routes.slice(
    routes.indexOf("router.get('/documents/:slug/view'"),
    routes.indexOf("router.get('/documents/:slug/download'")
  );
  assert.match(handler, /default-src 'none'; sandbox/);
  assert.match(handler, /nosniff/);
  // And the whole path is behind the switch.
  assert.match(handler, /settings\.getSetting\('pdf_viewer'\)/);
});

test('the LinkedIn badge is off by default and says why', () => {
  assert.equal(settings.DEFINITIONS.linkedin_badge.default, false);
  const src = read('views', 'pages', 'professional.ejs');
  // The card renders whether or not the badge is on, so the panel is never
  // empty for a visitor running a blocker.
  assert.match(src, /linkedin\.com\/in\/<%= linkedin\.handle %>/);
  assert.match(src, /settings\.linkedin_badge/);
});

test('the GitHub avatar is proxied rather than hotlinked', () => {
  // img-src is 'self', and telling GitHub the address of every visitor to
  // render one 56px square is a poor trade.
  const src = read('views', 'pages', 'professional.ejs');
  assert.match(src, /src="\/avatar\/github\.png"/);
  // Comments stripped: the reason it is NOT hotlinked names the host.
  const markup = src.replace(/<%#[\s\S]*?%>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/avatars\.githubusercontent\.com/.test(markup), false);
});
