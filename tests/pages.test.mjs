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
const repo = require('../src/repo.js');

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
  // personalPhotos filters these out in SQL, and the tile falls back to square
  // rather than to NaN if one ever reaches here.
  const t = collage.tile({ id: 4, width: null, height: null, storage_key: 'k', mime: 'image/webp' });
  assert.equal(Number.isFinite(t.aspect), true);
  assert.equal(t.aspect, 1);
});

test('a longer wall reads as more tiles across', () => {
  // The wall's whole shape comes from this one number: a wall of twelve should
  // be a feature at four across, a wall of two hundred a mosaic at ten.
  const widths = [2, 6, 15, 60, 200].map(collage.across);
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] > widths[i - 1], 'a longer wall must read as more tiles across');
  }
});

/* A synthetic library with the shapes a real one has, so the packer is measured
   against portraits, landscapes, squares, and panoramas rather than one shape. */
function wall(n) {
  const shapes = [[3, 2], [2, 3], [4, 3], [1, 1], [16, 9], [3, 4], [12, 5], [5, 12], [2, 3], [3, 2], [9, 16]];
  return Array.from({ length: n }, (_, i) => {
    const [w, h] = shapes[(i * 5) % shapes.length];
    return { id: i + 1, storage_key: `k${i}`, width: w * 100, height: h * 100, mime: 'image/webp' };
  });
}

test('every slot is inside the wall and none of them overlap', () => {
  const { tiles } = collage.layout(wall(72));
  for (const t of tiles) {
    assert.ok(t.left >= -0.001 && t.top >= -0.001, `slot ${t.id} starts outside the wall`);
    assert.ok(t.left + t.slotWidth <= 100.001, `slot ${t.id} runs past the right edge`);
    assert.ok(t.top + t.slotHeight <= 100.001, `slot ${t.id} runs past the bottom edge`);
    assert.ok(t.slotWidth > 0 && t.slotHeight > 0, `slot ${t.id} is empty`);
  }
  // Pairwise, because a packing bug shows as two photographs in one place.
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i]; const b = tiles[j];
      const overlaps = a.left < b.left + b.slotWidth - 0.001
        && b.left < a.left + a.slotWidth - 0.001
        && a.top < b.top + b.slotHeight - 0.001
        && b.top < a.top + a.slotHeight - 0.001;
      assert.equal(overlaps, false, `slots ${a.id} and ${b.id} overlap`);
    }
  }
});

test('the wall is filled exactly, with no dead space', () => {
  // The recursive split partitions the rectangle by construction, so anything
  // other than 100% is a bug in the arithmetic rather than a matter of taste.
  for (const n of [1, 2, 5, 12, 40, 72, 150]) {
    const { tiles } = collage.layout(wall(n));
    const covered = tiles.reduce((sum, t) => sum + (t.slotWidth * t.slotHeight) / 100, 0);
    assert.ok(Math.abs(covered - 100) < 0.01, `a wall of ${n} covers ${covered.toFixed(2)}%`);
  }
});

test('packing never reorders the photographs', () => {
  /*
   * The split is always at a contiguous point in the list, so everything in the
   * first half is above or to the left of everything in the second. A wall that
   * reshuffles makes it impossible to point somebody at a photograph.
   */
  const { tiles } = collage.layout(wall(72));
  assert.deepEqual(tiles.map((t) => t.id), Array.from({ length: 72 }, (_, i) => i + 1));
});

test('the same wall packs the same way twice', () => {
  const a = collage.layout(wall(40)).tiles.map((t) => [t.left, t.top, t.slotWidth, t.slotHeight]);
  const b = collage.layout(wall(40)).tiles.map((t) => [t.left, t.top, t.slotWidth, t.slotHeight]);
  assert.deepEqual(a, b);
});

test('a small wall is not given a wall-sized anchor', () => {
  /*
   * The size distribution the references show is a distribution of fifty
   * photographs or more. Applied unchanged to twelve, the anchor is a third of
   * the canvas and the other eleven are pushed into the margins around it.
   */
  const small = collage.layout(wall(12)).tiles.map((t) => (t.slotWidth * t.slotHeight) / 100);
  assert.ok(Math.max(...small) / Math.min(...small) < 4,
    'a wall of twelve must be roughly even');

  const large = collage.layout(wall(72)).tiles.map((t) => (t.slotWidth * t.slotHeight) / 100);
  assert.ok(Math.max(...large) / Math.min(...large) > 8,
    'a wall of seventy-two must have real size variety');
  assert.ok(Math.max(...large) < 10,
    'no single photograph may take a tenth of a wall of seventy-two');
});

test('the only photograph on the wall is not cropped to fit a rule', () => {
  const [only] = collage.layout(wall(1)).tiles;
  assert.equal(collage.layout(wall(1)).wallAspect, only.aspect);
  assert.equal(only.crop, 1);
});

test('no photograph is packed into a strip', () => {
  // A slot far from its photograph's shape is a crop; a slot far from ANY
  // sensible shape is a post, and unreadable at any size.
  const { tiles } = collage.layout(wall(72));
  for (const t of tiles) {
    assert.ok(t.slotAspect > 0.25 && t.slotAspect < 4,
      `slot ${t.id} is ${t.slotAspect}:1, which is a strip`);
  }
});

test('the wall is packed as slots, not as rows', () => {
  /*
   * The reversal from the row layout this replaced: a row can only vary a tile
   * in one direction, because every tile in a row shares its height, and the
   * collages this page is meant to look like vary in both.
   */
  const css = read('public', 'css', 'app.css');
  assert.match(css, /\.collage \{[\s\S]{0,1800}aspect-ratio: var\(--wall-ar\)/);
  assert.match(css, /\.collage-item \{[\s\S]{0,400}position: absolute/);
  assert.equal(/flex-grow: var\(--ar\)/.test(css), false, 'the row layout must be gone');
  // The hovered tile lifts over its neighbours; nothing is laid out again.
  assert.match(css, /\.collage-item:hover[\s\S]{0,160}transform: scale\(var\(--tile-hover\)\)/);
});

test('the gap between photographs is a hairline', () => {
  /*
   * Measured on all three reference collages: one pixel at 387px wide, three at
   * 500px, zero on the densest. A comfortable gutter is the single change that
   * stops the wall reading as one surface.
   */
  const css = read('public', 'css', 'app.css');
  const decl = css.match(/--collage-gap: ([^;]+);/);
  assert.ok(decl, 'the wall must declare a gap');
  const max = decl[1].match(/(\d+)px\)?\s*$/);
  assert.ok(max && Number(max[1]) <= 5, `the gap tops out at ${decl[1]}, which is a gutter`);
});

test('a class list is term order by default, alphabetical inside a term', () => {
  /*
   * The first question a reader has of a class list is what somebody is taking
   * now, which an alphabetical list buries in the middle. And "alphabetical"
   * has to mean the column the eye actually tracks: the code is the left hand
   * column of every row, so sorting by title first produced a list that was
   * correctly sorted by a key nobody can see.
   */
  const groups = repo.coursesByStatus('ucla');
  assert.ok(groups.length, 'the UCLA record must have classes');

  const rank = (t) => {
    const v = repo.termSortValue(t);
    return v.year * 10 + v.season;
  };

  for (const g of groups) {
    let previousTerm = Infinity;
    let previousCode = null;
    for (const c of g.courses) {
      const r = rank(c.term);
      if (r < previousTerm) { previousCode = null; }         // a new term starts
      assert.ok(r <= previousTerm, `${c.code} is out of term order in ${g.status}`);
      if (previousCode !== null) {
        assert.ok(
          previousCode.localeCompare(c.code, 'en', { numeric: true, sensitivity: 'base' }) <= 0,
          `${c.code} follows ${previousCode} inside one term, which is not alphabetical`
        );
      }
      previousTerm = r;
      previousCode = c.code;
    }
  }

  // MECH&AE 1 before MECH&AE 101, not after it, which is what a plain string
  // comparison would do.
  const codes = ['MECH&AE 101', 'MECH&AE 1', 'MECH&AE M20']
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
  assert.deepEqual(codes, ['MECH&AE 1', 'MECH&AE 101', 'MECH&AE M20']);
});

test('a class list sorted by term is actually in term order', () => {
  /*
   * A school that runs on academic years writes its terms as "2024-25", not as
   * "Fall 2024". Those matched nothing, scored year zero, tied with each other,
   * and fell through to the alphabetical tie-break — so "sort by term, newest
   * first" silently returned an alphabetical list on the whole high school
   * record.
   */
  const term = (t) => repo.termSortValue(t);
  assert.equal(term('Fall 2026').year, 2026);
  assert.equal(term('2024\u201325').year, 2024);
  assert.equal(term('2024-25').year, 2024);
  assert.equal(term('2024').year, 2024);
  assert.equal(term('sometime').year, 0);
  // Newest first, and an academic year is comparable with a quarter.
  const years = ['2021\u201322', '2024\u201325', '2022\u201323'].map(term);
  years.sort((a, b) => b.year - a.year);
  assert.deepEqual(years.map((y) => y.label), ['2024\u201325', '2022\u201323', '2021\u201322']);
});

test('the personal page is one full-width wall with no stored order', () => {
  const src = read('views', 'pages', 'personal.ejs');
  // One wall, at the window width rather than the reading measure.
  assert.match(src, /class="collage collage-full"/);
  assert.equal(/album/i.test(src), false, 'the personal page must not mention albums');
  assert.match(src, /--ar: <%= t\.aspect %>/);
  // Each slot as four percentages of the wall, packed on the server.
  assert.match(src, /--l: <%= t\.left %>%/);
  assert.match(src, /--wall-ar: <%= wallAspect %>/);
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

test('no page hotlinks a third party image', () => {
  // The profile card shows the GitHub mark, drawn inline, rather than an
  // avatar fetched from another origin. img-src in the CSP is 'self' and
  // data:, and a page that hotlinked would render a broken image with nothing
  // in the server log.
  const markup = (function all(dir, acc = []) {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) all(rel, acc);
      else if (e.name.endsWith('.ejs')) acc.push(readFileSync(path.join(ROOT, rel), 'utf8'));
    }
    return acc;
  })('views').join('\n');
  assert.equal(/avatars\.githubusercontent\.com/.test(markup), false);
  assert.equal(/<img[^>]+src="https?:/.test(markup), false);
});

