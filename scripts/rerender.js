'use strict';

/*
 * Re-render every cached HTML column from its markdown.
 *
 *   node scripts/rerender.js          report what has drifted
 *   node scripts/rerender.js --write  fix it
 *
 * Why this exists.
 *
 * Rich text is stored twice: the markdown somebody wrote, and the HTML it
 * renders to, so a page render is a read rather than a parse. That is a cache,
 * and a cache can go stale — which it did. A pass over the copy edited the seed
 * files and the *_md columns and never regenerated the *_html columns, so five
 * project pages and the feed carried on serving the previous wording while the
 * admin editor showed the new one. Nothing failed; the site was simply a
 * version behind, invisibly, for anyone who was not comparing the two.
 *
 * This is the repair, and it is idempotent: run it after any change that
 * touches markdown outside the admin, and after any migration that alters the
 * renderer. tests/markup.test.mjs asserts there is nothing left to do.
 *
 * See DESIGN.md, R11.
 */

const db = require('../src/db');
const markup = require('../src/markup');

db.assertEnvironment();

const WRITE = process.argv.includes('--write');

/*
 * table, primary key, the markdown/HTML column pairs, and THE RENDERER.
 *
 * The renderer is per table and it is not a detail. Project bodies, notes, and
 * the now block are escaped and paragraphed, never parsed as markup — see the
 * comment on renderInline in src/routes/admin.js — while a page is rich text.
 * Re-rendering all four with the same function would quietly convert a project
 * body into a format the editor does not write and cannot round trip: a line
 * beginning with a hyphen would become a list, and a backtick would become a
 * code span, neither of which the admin would produce from the same source.
 *
 * Each entry names the same function the write path uses. If a write path
 * changes renderer, this list has to change with it.
 */
const CACHES = [
  ['project', 'id', [['summary_md', 'summary_html'], ['body_md', 'body_html']], markup.paragraphs],
  ['note', 'id', [['body_md', 'body_html']], markup.paragraphs],
  ['now_page', 'id', [['body_md', 'body_html']], markup.paragraphs],
  ['page', 'slug', [['body_md', 'body_html']], markup.richText],
];

let checked = 0;
let stale = 0;

for (const [table, pk, pairs, render] of CACHES) {
  const cols = pairs.flat().join(', ');
  const rows = db.all(`SELECT ${pk} AS pk, ${cols} FROM ${table}`);
  for (const row of rows) {
    for (const [md, html] of pairs) {
      checked += 1;
      const source = row[md] || '';
      /*
       * An empty source renders to an empty string, not to the renderer's
       * output for '': a column that was never filled in must stay empty
       * rather than acquiring an empty paragraph.
       */
      const want = source.trim() ? render(source) : '';
      if ((row[html] || '') === want) continue;
      stale += 1;
      console.log(`${table}.${html} #${row.pk}`);
      if (WRITE) db.run(`UPDATE ${table} SET ${html} = ? WHERE ${pk} = ?`, want, row.pk);
    }
  }
}

if (stale && WRITE) {
  /* The search index carries the rendered text, so it is stale for exactly the
     same rows. */
  require('../src/repo').reindexAll();
  console.log('search index rebuilt');
}

console.log(`${checked} cached columns checked, ${stale} ${WRITE ? 'rewritten' : 'stale'}.`);
if (stale && !WRITE) {
  console.log('Run with --write to fix.');
  process.exitCode = 1;
}
