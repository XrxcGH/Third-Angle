/*
 * Document library.
 *
 * The thing being tested is the difference between a folder and a library:
 * a folder matches filenames, a library matches what is written on page 47.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const documents = require('../src/documents.js');
const repo = require('../src/repo.js');
const db = require('../src/db.js');

const have = () => db.get('SELECT COUNT(*) AS n FROM document').n > 0;

test('only PDFs are accepted, and the message says why', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
  await assert.rejects(
    () => documents.ingest({ buffer: png, originalName: 'x.png' }),
    /PDF/i
  );
  await assert.rejects(
    () => documents.ingest({ buffer: Buffer.alloc(64, 0x41), originalName: 'x' }),
    /PDF/i
  );
});

test('slugs are derived, stripped of the extension, and never empty', () => {
  assert.equal(documents.slugify('WRRF Youth Protection Policy.pdf'), 'wrrf-youth-protection-policy');
  assert.equal(documents.slugify('05-YOUTH-PROTECTION.pdf'), '05-youth-protection');
  assert.equal(documents.slugify('   '), 'document');
  assert.equal(documents.slugify('!!!.pdf'), 'document');
});

test('page text is stored per page, so a hit can name a page number', { skip: !have() }, () => {
  const doc = db.get('SELECT id, pages FROM document ORDER BY id LIMIT 1');
  const pages = db.all('SELECT page_no, text FROM document_page WHERE document_id = ? ORDER BY page_no', doc.id);
  assert.ok(pages.length > 0, 'no page text was stored');
  for (const p of pages) {
    assert.ok(p.page_no >= 1 && p.page_no <= doc.pages, `page ${p.page_no} is outside 1..${doc.pages}`);
    assert.ok(p.text.length > 0, 'an empty page was stored rather than skipped');
  }
  // Page numbers must be unique per document, or a hit points at two places.
  const seen = new Set(pages.map((p) => p.page_no));
  assert.equal(seen.size, pages.length, 'duplicate page numbers');
});

test('searching finds document CONTENT, not just the filename', { skip: !have() }, () => {
  /*
   * The whole point of indexing per page.
   *
   * The words are taken from the text that is actually indexed rather than
   * hardcoded, and any word that also appears in a title is discarded first.
   * A fixed list of words made this test an assertion about which documents
   * happen to be uploaded: it passed on one machine, skipped on an empty
   * database, and failed on any other library while the code was fine.
   */
  const titles = db.all('SELECT title, description FROM document')
    .map((d) => `${d.title} ${d.description || ''}`.toLowerCase()).join(' ');

  const words = new Map();
  for (const row of db.all('SELECT text FROM document_page LIMIT 200')) {
    for (const w of String(row.text).toLowerCase().match(/[a-z]{5,}/g) || []) {
      if (titles.includes(w)) continue;
      words.set(w, (words.get(w) || 0) + 1);
    }
  }
  const candidates = [...words.keys()].slice(0, 12);
  if (!candidates.length) return; // a library of image-only PDFs has no text layer

  let found = 0;
  for (const w of candidates) {
    if (repo.search(w).results.some((r) => r.kind === 'document')) found += 1;
  }
  assert.ok(
    found >= Math.ceil(candidates.length / 2),
    `only ${found} of ${candidates.length} indexed content words matched a document`
  );
});

test('pageHits returns real page numbers with an excerpt', { skip: !have() }, () => {
  const doc = db.get("SELECT id FROM document WHERE slug LIKE '%solder%'");
  if (!doc) return;
  const hits = documents.pageHits(doc.id, 'solder', 5);
  assert.ok(hits.length > 0, 'no page hits');
  for (const h of hits) {
    assert.ok(Number.isInteger(h.page_no) && h.page_no >= 1);
    assert.ok(typeof h.excerpt === 'string' && h.excerpt.length > 0);
  }
});

test('pageHits never throws on hostile input', { skip: !have() }, () => {
  const doc = db.get('SELECT id FROM document ORDER BY id LIMIT 1');
  for (const q of ['%', '_', "'; DROP TABLE document_page; --", '', null, 'a'.repeat(400)]) {
    assert.doesNotThrow(() => documents.pageHits(doc.id, q), `threw on ${JSON.stringify(q)}`);
  }
  // The LIKE wildcards must not match everything: a bare % would return every
  // page of every document and look like a working search.
  assert.equal(documents.pageHits(doc.id, '%').length, 0);
  assert.equal(documents.pageHits(doc.id, '').length, 0);
});

test('one search row per document, not one per page', { skip: !have() }, () => {
  // Per-page rows were considered and rejected: a 129 page deck would return
  // 129 results for one query and bury everything else.
  for (const d of db.all('SELECT id FROM document')) {
    const rows = db.all("SELECT id FROM search_index WHERE kind = 'document' AND ref_id = ?", d.id);
    assert.equal(rows.length, 1, `document ${d.id} has ${rows.length} search rows`);
  }
});

test('a private document is excluded from search and the public list', { skip: !have() }, () => {
  const d = db.get('SELECT id, slug FROM document ORDER BY id LIMIT 1');
  db.run("UPDATE document SET visibility = 'private' WHERE id = ?", d.id);
  documents.reindex(d.id);
  try {
    const listed = documents.listDocuments().some((x) => x.id === d.id);
    assert.equal(listed, false, 'a private document appeared in the public list');
    assert.equal(documents.getDocument(d.slug), undefined, 'a private document was reachable by slug');
    assert.ok(documents.getDocument(d.slug, { includePrivate: true }), 'admin cannot see it either');

    const row = db.get("SELECT published FROM search_index WHERE kind = 'document' AND ref_id = ?", d.id);
    assert.equal(row.published, 0, 'a private document is still published in the index');
  } finally {
    db.run("UPDATE document SET visibility = 'public' WHERE id = ?", d.id);
    documents.reindex(d.id);
  }
});

test('indexed page count is reported honestly against the total', { skip: !have() }, () => {
  // A slide deck can be half photographs, and those pages have no text layer.
  // Showing the raw page count would imply a searchability that is not there.
  for (const d of documents.listDocuments({ includePrivate: true })) {
    assert.ok(Number.isInteger(d.indexed_pages), 'indexed_pages missing');
    assert.ok(d.indexed_pages <= d.pages, `${d.slug} claims more indexed pages than it has`);
  }
});

test('deleting a document removes its pages, its file, and its search row', { skip: !have() }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { UPLOAD_DIR } = db;

  // Build a tiny real PDF rather than reusing a fixture, so the test owns it.
  const src = db.get('SELECT storage_key FROM document ORDER BY id LIMIT 1');
  const buffer = fs.readFileSync(path.join(UPLOAD_DIR, src.storage_key));

  const id = await documents.ingest({
    buffer, originalName: 'throwaway.pdf', title: 'Throwaway test document', visibility: 'public',
  });
  const doc = db.get('SELECT storage_key FROM document WHERE id = ?', id);
  const abs = path.join(UPLOAD_DIR, doc.storage_key);
  assert.ok(fs.existsSync(abs), 'file was not written');

  documents.remove(id, 'test');

  assert.equal(fs.existsSync(abs), false, 'file was orphaned on disk');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM document_page WHERE document_id = ?', id).n, 0, 'pages survived');
  assert.equal(db.get("SELECT id FROM search_index WHERE kind = 'document' AND ref_id = ?", id), undefined, 'search row survived');
});
