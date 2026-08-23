'use strict';

/*
 * Document library.
 *
 * This is the most under-used asset on the site. Very few engineering students
 * have authored a governance package, a 1,375 line game manual, or a migration
 * runbook, and a list of filenames communicates none of that. What turns a file
 * dump into a library is per-page text in the search index: a query for "youth
 * protection" or "retention schedule" should return the document AND the page,
 * not a filename that happens to contain the word.
 */

const fs = require('node:fs');
const path = require('node:path');
const { get, all, run, transaction, nowIso, UPLOAD_DIR } = require('./db');
const repo = require('./repo');
const media = require('./media');

/* Text only. Rendering a thumbnail would need a canvas binding, which is a
   native dependency this project deliberately does not have. */
async function extractPages(buffer, maxPages = 400) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    // PDF.js has a history of arbitrary-execution bugs in PDF rendering.
    // These files are all self-authored, but the flag costs nothing and the
    // day someone else uploads one it is already correct.
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages = [];
  const limit = Math.min(doc.numPages, maxPages);
  for (let n = 1; n <= limit; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items
      .map((i) => (typeof i.str === 'string' ? i.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push({ page_no: n, text });
    page.cleanup();
  }
  const total = doc.numPages;
  await doc.destroy();
  return { pages, total };
}

const slugify = (s) =>
  String(s).toLowerCase().trim()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document';

/**
 * Ingest one PDF. Extraction is done BEFORE the transaction, because it is the
 * slow part and holding a write lock open across it on a single-writer SQLite
 * file would block every other request.
 */
async function ingest({ buffer, originalName, title, description, projectId, visibility, actor }) {
  const type = media.sniff(buffer);
  if (!type || type.mime !== 'application/pdf') {
    throw new Error('The document library takes PDFs. Convert first, so the library has one viewer rather than several.');
  }
  if (buffer.length > media.MAX_BYTES) {
    throw new Error(`That file is ${(buffer.length / 1048576).toFixed(1)} MB. The limit is ${media.MAX_BYTES / 1048576} MB.`);
  }

  const { pages, total } = await extractPages(buffer);

  const key = `docs/${new Date().toISOString().slice(0, 7)}/${require('node:crypto').randomBytes(16).toString('hex')}.pdf`;
  const dest = path.join(UPLOAD_DIR, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);

  const finalTitle = String(title || '').trim() || String(originalName || 'Untitled').replace(/\.pdf$/i, '');
  let slug = slugify(finalTitle);
  if (get('SELECT id FROM document WHERE slug = ?', slug)) slug = `${slug}-${Date.now().toString(36)}`;

  return commit({
    slug, title: finalTitle, description, key, originalName,
    bytes: buffer.length, pages, total, projectId, visibility, actor,
  });
}

const commit = transaction((d) => {
  const now = nowIso();
  const res = run(
    `INSERT INTO document (slug, title, description, storage_key, original_name, mime,
                           bytes, pages, visibility, project_id, sort_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, ?)`,
    d.slug, d.title, String(d.description || '').trim() || null, d.key, d.originalName || null,
    d.bytes, d.total, d.visibility === 'private' ? 'private' : 'public',
    d.projectId || null, repo.nextKeyFor('document'), now, now
  );
  const id = Number(res.lastInsertRowid);

  for (const p of d.pages) {
    if (!p.text) continue;
    run('INSERT INTO document_page (document_id, page_no, text) VALUES (?, ?, ?)', id, p.page_no, p.text);
  }

  reindex(id);
  repo.logChange(d.actor, 'document', id, 'insert', { title: d.title, pages: d.total });
  return id;
});

/*
 * One search row per document, carrying the full text. Per-page rows were
 * considered and rejected: a 129 page training deck would produce 129 results
 * for one query and bury everything else. The page number is recovered at
 * query time by pageHits() instead, so the ranking stays sane and the detail
 * is still there.
 */
function reindex(id) {
  const doc = get('SELECT * FROM document WHERE id = ?', id);
  if (!doc) return;
  const text = all('SELECT text FROM document_page WHERE document_id = ? ORDER BY page_no', id)
    .map((r) => r.text).join(' ');
  repo.upsertSearchRow({
    kind: 'document',
    ref_id: doc.id,
    url: `/documents/${doc.slug}`,
    title: doc.title,
    subtitle: doc.description || '',
    body: repo.plain(text).slice(0, 200_000),
    tags: 'document pdf',
    published: doc.visibility === 'public' ? 1 : 0,
  });
}

/** Which pages of one document match a query, so a result can say "page 47". */
function pageHits(documentId, query, limit = 5) {
  const terms = repo.queryTerms(query);
  if (!terms.length) return [];
  const like = terms.map(() => 'text LIKE ?').join(' AND ');
  const params = terms.map((t) => `%${t}%`);
  return all(
    `SELECT page_no, substr(text, 1, 240) AS excerpt
       FROM document_page
      WHERE document_id = ? AND ${like}
      ORDER BY page_no LIMIT ?`,
    documentId, ...params, limit
  );
}

function listDocuments({ includePrivate = false } = {}) {
  /*
   * indexed_pages is deliberately reported alongside the page count. A slide
   * deck can be half photographs, and those pages have no text layer, so they
   * are not searchable. Saying "13 of 26 pages indexed" is honest; silently
   * showing 26 implies a searchability that is not there.
   */
  return all(
    `SELECT d.*, p.slug AS project_slug, p.title AS project_title,
            (SELECT COUNT(*) FROM document_page dp WHERE dp.document_id = d.id) AS indexed_pages
       FROM document d
       LEFT JOIN project p ON p.id = d.project_id
      ${includePrivate ? '' : "WHERE d.visibility = 'public'"}
      ORDER BY d.sort_key`
  );
}

function getDocument(slug, { includePrivate = false } = {}) {
  return get(
    `SELECT d.*, p.slug AS project_slug, p.title AS project_title
       FROM document d
       LEFT JOIN project p ON p.id = d.project_id
      WHERE d.slug = ? ${includePrivate ? '' : "AND d.visibility = 'public'"}`,
    slug
  );
}

const remove = transaction((id, actor) => {
  const doc = get('SELECT * FROM document WHERE id = ?', id);
  if (!doc) return false;
  const abs = path.join(UPLOAD_DIR, doc.storage_key);
  try { if (fs.existsSync(abs)) fs.rmSync(abs); } catch { /* best effort */ }
  // document_page cascades; search_index has no foreign key by design.
  run("DELETE FROM search_index WHERE kind = 'document' AND ref_id = ?", id);
  run('DELETE FROM document WHERE id = ?', id);
  repo.logChange(actor, 'document', id, 'delete', doc);
  return true;
});

module.exports = {
  ingest, extractPages, reindex, pageHits,
  listDocuments, getDocument, remove, slugify,
};
