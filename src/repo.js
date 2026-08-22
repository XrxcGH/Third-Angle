'use strict';

/*
 * Repository module. Every query in the application lives here as a named
 * function, so no route ever writes SQL and the database driver stays a one
 * file swap.
 */

const { get, all, run, transaction, nowIso } = require('./db');
const { generateKeyBetween, generateNKeysBetween } = require('fractional-indexing');

/* ---------------------------------------------------------------- facets */

function listFacets(kind = 'discipline') {
  return all(
    `SELECT slug, label, kind, color_token, blurb, sort_key, in_nav
       FROM facet WHERE kind = ? ORDER BY sort_key`,
    kind
  );
}

function getFacet(slug) {
  return get('SELECT * FROM facet WHERE slug = ?', slug);
}

/**
 * Facet counts for the filter chips, published projects only.
 * Returned as a plain object keyed by slug so templates can do a lookup
 * rather than a scan.
 */
function facetCounts() {
  const rows = all(
    `SELECT pf.facet_slug AS slug, COUNT(*) AS n
       FROM project_facet pf
       JOIN project p ON p.id = pf.project_id
      WHERE p.published = 1
      GROUP BY pf.facet_slug`
  );
  return Object.fromEntries(rows.map((r) => [r.slug, r.n]));
}

/* --------------------------------------------------------------- projects */

const PROJECT_CARD_COLUMNS = `
  p.id, p.slug, p.title, p.subtitle, p.tier, p.status, p.context, p.role,
  p.summary_md, p.summary_html, p.started_on, p.ended_on, p.featured,
  p.published, p.sort_key, p.updated_at
`;

/**
 * The work index. Never filters rows out by facet: the highlight and dim
 * interaction needs every card present so the page does not reflow and the
 * breadth claim stays visible. Matching is decided by the caller.
 */
function listProjects({ includeUnpublished = false } = {}) {
  const rows = all(
    `SELECT ${PROJECT_CARD_COLUMNS} FROM project p
      ${includeUnpublished ? '' : 'WHERE p.published = 1'}
      ORDER BY p.sort_key`
  );
  return rows.map(attachFacets);
}

function getProjectBySlug(slug, { includeUnpublished = false } = {}) {
  const row = get(
    `SELECT p.* FROM project p
      WHERE p.slug = ? ${includeUnpublished ? '' : 'AND p.published = 1'}`,
    slug
  );
  if (!row) return null;
  const project = attachFacets(row);
  project.metrics = all(
    'SELECT label, value, unit FROM metric WHERE project_id = ? ORDER BY sort_key',
    row.id
  );
  project.links = all(
    'SELECT label, url, kind FROM link WHERE project_id = ? ORDER BY sort_key',
    row.id
  );
  project.media = all(
    `SELECT m.* FROM media m
       JOIN project_media pm ON pm.media_id = m.id
      WHERE pm.project_id = ? ORDER BY pm.sort_key`,
    row.id
  );
  return project;
}

/**
 * Disciplines for a project, ordered so the primary contribution reads first.
 * weight is ordered explicitly rather than alphabetically, which would put
 * 'primary' after 'significant'.
 */
function attachFacets(project) {
  project.facets = all(
    `SELECT f.slug, f.label, f.color_token, pf.weight, pf.contribution_note
       FROM project_facet pf
       JOIN facet f ON f.slug = pf.facet_slug
      WHERE pf.project_id = ?
      ORDER BY CASE pf.weight
                 WHEN 'primary' THEN 0
                 WHEN 'significant' THEN 1
                 ELSE 2 END,
               pf.sort_key`,
    project.id
  );
  project.facetSlugs = project.facets.map((f) => f.slug);
  return project;
}

/**
 * Projects for one discipline landing page, primary contributions first, so
 * filtering to Controls surfaces work where controls actually was the job.
 */
function listProjectsByFacet(slug) {
  const rows = all(
    `SELECT ${PROJECT_CARD_COLUMNS}, pf.weight, pf.contribution_note
       FROM project p
       JOIN project_facet pf ON pf.project_id = p.id
      WHERE pf.facet_slug = ? AND p.published = 1
      ORDER BY CASE pf.weight
                 WHEN 'primary' THEN 0
                 WHEN 'significant' THEN 1
                 ELSE 2 END,
               p.sort_key`,
    slug
  );
  return rows.map(attachFacets);
}

/* ------------------------------------------------------------- reordering */

/**
 * Rewrite the order of a whole scope from an ordered array of ids.
 *
 * Idempotent and safe to retry, which a stream of per-item PATCHes is not.
 * Keys are always generated on the server from neighbours; a key supplied by
 * the client would let a buggy or compromised session collide the index.
 */
const reorderProjects = transaction((orderedIds) => {
  const keys = generateNKeysBetween(null, null, orderedIds.length);
  const now = nowIso();

  /*
   * Two phases, because sort_key carries a UNIQUE index and the rows are
   * updated one at a time. A single pass collides the moment a new key equals
   * the key a not-yet-updated row still holds, which is the common case when
   * reversing an order. The parking values are unique by construction (the id
   * is), and '~' sorts above every base62 character so they cannot be mistaken
   * for real keys if a crash somehow lands between the phases.
   */
  for (const id of orderedIds) {
    run('UPDATE project SET sort_key = ? WHERE id = ?', `~${id}`, id);
  }
  orderedIds.forEach((id, i) => {
    run('UPDATE project SET sort_key = ?, updated_at = ? WHERE id = ?', keys[i], now, id);
  });
  return orderedIds.length;
});

/** Next key for an append. null, null on an empty table is correct. */
function nextProjectKey() {
  const row = get('SELECT sort_key FROM project ORDER BY sort_key DESC LIMIT 1');
  return generateKeyBetween(row ? row.sort_key : null, null);
}

function nextKeyFor(table, where = '1=1', ...params) {
  const row = get(`SELECT sort_key FROM ${table} WHERE ${where} ORDER BY sort_key DESC LIMIT 1`, ...params);
  return generateKeyBetween(row ? row.sort_key : null, null);
}

/* ------------------------------------------------------------------ notes */

function listNotes(limit = 20) {
  return all(
    `SELECT n.id, n.slug, n.title, n.body_html, n.created_at,
            p.slug AS project_slug, p.title AS project_title
       FROM note n
       LEFT JOIN project p ON p.id = n.project_id
      WHERE n.published = 1
      ORDER BY n.created_at DESC
      LIMIT ?`,
    limit
  );
}

function latestNoteDate() {
  const row = get('SELECT created_at FROM note WHERE published = 1 ORDER BY created_at DESC LIMIT 1');
  return row ? row.created_at : null;
}

function getNow() {
  return get('SELECT * FROM now_page WHERE id = 1');
}

/* ----------------------------------------------------------------- search */

/**
 * FTS5 has its own query syntax, so raw input containing a quote, a colon, a
 * caret or 'C++' produces a syntax error and a 500 on a page recruiters use.
 * Tokenise to word characters and requote every term. Never interpolate.
 */
function queryTerms(raw) {
  return String(raw || '')
    .toLowerCase()
    // Normalise to exactly what the unicode61 tokenizer will index. Keeping
    // punctuation here is what made "C++" collapse to a bare "c" prefix and
    // match every row in the table.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
}

function toMatchQuery(raw, { prefix = true } = {}) {
  const terms = queryTerms(raw);
  if (!terms.length) return null;
  return terms
    .map((t) => {
      // Prefix matching is safe only because the tokenizer is unicode61, and
      // only above two characters: "c"* matches most of the corpus and is
      // worse than no result at all.
      const usePrefix = prefix && t.length >= 3;
      return usePrefix ? `"${t}"*` : `"${t}"`;
    })
    .join(' AND ');
}

/* Bounded Damerau-Levenshtein. Bails as soon as the row minimum exceeds max. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1); // transposition
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/*
 * "Did you mean". Runs only on a zero-result query, over the term vocabulary
 * of the index itself, so it can never suggest a word that would find nothing.
 * The vocabulary here is a few thousand terms, so this is sub-millisecond and
 * needs no dependency.
 */
function correctTerms(terms) {
  let changed = false;
  const corrected = terms.map((term) => {
    if (term.length < 4) return term;
    const max = term.length < 6 ? 1 : 2;
    const candidates = all(
      `SELECT term, cnt FROM search_vocab
        WHERE length(term) BETWEEN ? AND ?
        ORDER BY cnt DESC LIMIT 800`,
      term.length - max, term.length + max
    );
    let best = null;
    for (const c of candidates) {
      // First-letter guard: it removes most false suggestions for free.
      if (c.term[0] !== term[0]) continue;
      const d = editDistance(term, c.term, max);
      if (d <= max && (!best || d < best.d || (d === best.d && c.cnt > best.cnt))) {
        best = { term: c.term, d, cnt: c.cnt };
      }
    }
    if (best && best.term !== term) { changed = true; return best.term; }
    return term;
  });
  return changed ? corrected : null;
}

/**
 * Two stage. The trigram fallback only runs when the primary finds nothing,
 * which is what gives substring and near-miss matching without paying for it
 * on every query.
 */
function runFts(table, matchExpr, limit, withSnippet) {
  const excerpt = withSnippet
    ? `snippet(search_fts, 2, '<mark>', '</mark>', ' ... ', 18)`
    : `''`;
  return all(
    `SELECT si.kind, si.url, si.title, si.subtitle,
            ${excerpt} AS excerpt,
            bm25(${table}) AS score
       FROM ${table}
       JOIN search_index si ON si.id = ${table}.rowid
      WHERE ${table} MATCH ? AND si.published = 1
      ORDER BY score
      LIMIT ?`,
    matchExpr, limit
  );
}

/**
 * Three stages, each only paying for itself when the one before finds nothing:
 *   1. unicode61 prefix match, the normal path
 *   2. trigram substring match, which catches "lectric" inside "electrical"
 *   3. edit-distance correction over the index vocabulary, which catches a
 *      dropped or transposed letter that no substring match can recover
 */
function search(raw, limit = 25) {
  const terms = queryTerms(raw);
  if (!terms.length) return { results: [], fallback: null };

  const q = toMatchQuery(raw);
  const primary = runFts('search_fts', q, limit, true);
  if (primary.length) return { results: primary, fallback: null };

  const loose = toMatchQuery(raw, { prefix: false });
  const substring = runFts('search_trgm', loose, limit, false);
  if (substring.length) return { results: substring, fallback: { kind: 'near' } };

  const corrected = correctTerms(terms);
  if (corrected) {
    const cq = corrected.map((t) => (t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(' AND ');
    const rescued = runFts('search_fts', cq, limit, true);
    if (rescued.length) {
      return { results: rescued, fallback: { kind: 'corrected', term: corrected.join(' ') } };
    }
  }

  return { results: [], fallback: null };
}

/** Rebuild one search_index row. Called inside the same transaction as a write. */
function upsertSearchRow({ kind, ref_id, url, title, subtitle = '', body = '', tags = '', published = 1 }) {
  // IS rather than =. Discipline rows carry a NULL ref_id, and `ref_id = NULL`
  // is NULL rather than true, so the probe never matched and every reindex
  // appended a fresh duplicate of all eight disciplines.
  const existing = ref_id === null || ref_id === undefined
    ? get('SELECT id FROM search_index WHERE kind = ? AND url = ?', kind, url)
    : get('SELECT id FROM search_index WHERE kind = ? AND ref_id IS ?', kind, ref_id);
  if (existing) {
    run(
      `UPDATE search_index
          SET url = ?, title = ?, subtitle = ?, body = ?, tags = ?, published = ?
        WHERE id = ?`,
      url, title, subtitle, body, tags, published ? 1 : 0, existing.id
    );
    return existing.id;
  }
  const res = run(
    `INSERT INTO search_index (kind, ref_id, url, title, subtitle, body, tags, published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    kind, ref_id, url, title, subtitle, body, tags, published ? 1 : 0
  );
  return Number(res.lastInsertRowid);
}

/** Strip Markdown down to plain text for indexing. Deliberately crude. */
function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // HTML must go before the punctuation pass, or a stray < survives into the
    // index and snippet() then emits it into the page. The search template has
    // to use <%- to render the <mark> highlight, so anything the indexer stores
    // is effectively unescaped output.
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:[a-z]+|#\d+);/gi, ' ')
    .replace(/[#>*_`|-]+/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reindexProject(projectId) {
  const p = get('SELECT * FROM project WHERE id = ?', projectId);
  if (!p) return;
  const facets = all(
    `SELECT f.label FROM project_facet pf JOIN facet f ON f.slug = pf.facet_slug
      WHERE pf.project_id = ?`,
    projectId
  ).map((r) => r.label);
  upsertSearchRow({
    kind: 'project',
    ref_id: p.id,
    url: `/work/${p.slug}`,
    title: p.title,
    subtitle: p.subtitle || '',
    body: `${plain(p.summary_md)} ${plain(p.body_md)}`.trim(),
    tags: [...facets, p.context, p.role, p.status].filter(Boolean).join(' '),
    published: p.published,
  });
}

function reindexAll() {
  // search_index deliberately has no foreign key to project, because it also
  // holds rows for disciplines and static pages that have no project. So
  // orphans have to be swept explicitly rather than cascaded.
  run(`DELETE FROM search_index
        WHERE kind = 'project'
          AND ref_id IS NOT NULL
          AND ref_id NOT IN (SELECT id FROM project)`);
  for (const p of all('SELECT id FROM project')) reindexProject(p.id);
  for (const f of all("SELECT * FROM facet WHERE kind = 'discipline'")) {
    upsertSearchRow({
      kind: 'discipline',
      ref_id: null,
      url: `/disciplines/${f.slug}`,
      title: f.label,
      subtitle: 'Discipline',
      body: plain(f.blurb),
      tags: f.label,
    });
  }
}

/* ------------------------------------------------------------------ pages */

/*
 * Singleton editorial pages. Deliberately not a general CMS: the admin can
 * rewrite a page without a deploy, but cannot invent a new URL that nothing
 * links to and nothing knows how to lay out.
 */
const PAGE_SLUGS = ['resume', 'about'];

function getPage(slug) {
  if (!PAGE_SLUGS.includes(slug)) return null;
  return get('SELECT * FROM page WHERE slug = ? AND published = 1', slug);
}

function getPageForEdit(slug) {
  if (!PAGE_SLUGS.includes(slug)) return null;
  return get('SELECT * FROM page WHERE slug = ?', slug);
}

function savePage(slug, { title, subtitle, body_md, body_html, published }) {
  if (!PAGE_SLUGS.includes(slug)) throw new Error(`Unknown page: ${slug}`);
  run(
    `INSERT INTO page (slug, title, subtitle, body_md, body_html, published, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title, subtitle = excluded.subtitle,
       body_md = excluded.body_md, body_html = excluded.body_html,
       published = excluded.published, updated_at = excluded.updated_at`,
    slug, title, subtitle || null, body_md, body_html, published ? 1 : 0, nowIso()
  );
  upsertSearchRow({
    kind: 'page', ref_id: null, url: `/${slug}`,
    title, subtitle: subtitle || '', body: plain(body_md),
    tags: slug, published: published ? 1 : 0,
  });
}

/* ------------------------------------------------------------------ audit */

function logChange(actor, table, rowId, action, snapshot) {
  run(
    `INSERT INTO audit_log (at, actor, table_name, row_id, action, snapshot)
     VALUES (?, ?, ?, ?, ?, ?)`,
    nowIso(), actor || null, table, rowId, action, JSON.stringify(snapshot ?? null)
  );
}

/* -------------------------------------------------------------- redirects */

function findRedirect(fromPath) {
  return get('SELECT to_path, code FROM redirect WHERE from_path = ?', fromPath);
}

/* ----------------------------------------------------------------- errors */

function logError(route, err) {
  try {
    run(
      'INSERT INTO app_error (at, route, message, stack) VALUES (?, ?, ?, ?)',
      nowIso(), route || null, String(err && err.message || err), err && err.stack ? String(err.stack) : null
    );
  } catch { /* never let error logging throw */ }
}


/* -------------------------------------------------------------- education
 *
 * The resume page is a document; this is a record. A class added here shows up
 * on /education, in the term summary, and in search without anyone rewriting a
 * paragraph, which is the difference between a list that stays current and one
 * that is accurate on the day it is written.
 */

const COURSE_STATUS = ['completed', 'in-progress', 'planned'];
const ACTIVITY_KINDS = ['activity', 'award', 'certification'];
const SCHOOL_KINDS = ['university', 'high-school', 'certification'];

function listSchools() {
  return all('SELECT * FROM school ORDER BY sort_key');
}

function getSchool(slug) {
  return get('SELECT * FROM school WHERE slug = ?', slug);
}

function saveSchool(slug, fields) {
  const kind = SCHOOL_KINDS.includes(fields.kind) ? fields.kind : 'university';
  const existing = getSchool(slug);
  if (existing) {
    run(
      `UPDATE school SET name=?, kind=?, credential=?, location=?, started_on=?,
         ended_on=?, honours=?, blurb=? WHERE slug=?`,
      fields.name, kind, fields.credential || null, fields.location || null,
      fields.started_on || null, fields.ended_on || null, fields.honours || null,
      fields.blurb || null, slug
    );
  } else {
    run(
      `INSERT INTO school (slug, name, kind, credential, location, started_on, ended_on, honours, blurb, sort_key)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      slug, fields.name, kind, fields.credential || null, fields.location || null,
      fields.started_on || null, fields.ended_on || null, fields.honours || null,
      fields.blurb || null, nextKeyFor('school')
    );
  }
  return slug;
}

const deleteSchool = transaction((slug) => {
  // course cascades, activity is set null: an activity can outlive the school
  // record it was attached to, and losing it would be a silent data loss.
  run('DELETE FROM school WHERE slug = ?', slug);
});

function listCourses(schoolSlug) {
  return schoolSlug
    ? all('SELECT * FROM course WHERE school_slug = ? ORDER BY sort_key', schoolSlug)
    : all('SELECT * FROM course ORDER BY school_slug, sort_key');
}

/**
 * Courses grouped by term, newest term first, with the terms in a stable order.
 *
 * Terms are compared as text with a deliberate season ordering rather than
 * alphabetically: "Fall 2026" sorts before "Winter 2027" only if the code knows
 * that Fall comes first in an academic year, and localeCompare does not.
 */
const SEASON_ORDER = { winter: 1, spring: 2, summer: 3, fall: 4, autumn: 4 };

function termSortValue(term) {
  const t = String(term || '').trim();
  const m = /^([A-Za-z]+)\s*(\d{4})$/.exec(t);
  if (!m) return { year: 0, season: 0, label: t };
  return { year: Number(m[2]), season: SEASON_ORDER[m[1].toLowerCase()] || 0, label: t };
}

/**
 * Courses grouped by status, which is the axis that carries a claim.
 *
 * "Completed" and "in progress" are different statements about the same
 * subject, and a single alphabetical list of class names quietly makes the
 * stronger one. Term is shown per row where it is recorded, rather than being
 * the grouping: a class whose term nobody wrote down still belongs on the page.
 */
function coursesByStatus(schoolSlug) {
  const rows = listCourses(schoolSlug);
  const order = ['in-progress', 'completed', 'planned'];
  const byTerm = (a, b) => {
    const ta = termSortValue(a.term);
    const tb = termSortValue(b.term);
    // A recorded term sorts above an unrecorded one, newest first.
    if (ta.year !== tb.year) return tb.year - ta.year;
    if (ta.season !== tb.season) return tb.season - ta.season;
    return a.sort_key.localeCompare(b.sort_key);
  };
  return order
    .map((status) => ({ status, courses: rows.filter((c) => c.status === status).sort(byTerm) }))
    .filter((g) => g.courses.length);
}

function coursesByTerm(schoolSlug) {
  const rows = listCourses(schoolSlug);
  const groups = new Map();
  for (const c of rows) {
    const key = c.term || 'Unscheduled';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()]
    .map(([term, courses]) => ({ term, courses, ...termSortValue(term) }))
    .sort((a, b) => (b.year - a.year) || (b.season - a.season) || b.label.localeCompare(a.label));
}

function courseCounts(schoolSlug) {
  const rows = listCourses(schoolSlug);
  const out = { completed: 0, 'in-progress': 0, planned: 0, total: rows.length };
  for (const c of rows) out[c.status] = (out[c.status] || 0) + 1;
  return out;
}

function saveCourse(fields) {
  const status = COURSE_STATUS.includes(fields.status) ? fields.status : 'planned';
  if (fields.id) {
    run(
      `UPDATE course SET school_slug=?, code=?, title=?, term=?, units=?, status=?, note=? WHERE id=?`,
      fields.school_slug, fields.code || null, fields.title, fields.term || null,
      fields.units || null, status, fields.note || null, Number(fields.id)
    );
    return Number(fields.id);
  }
  const res = run(
    `INSERT INTO course (school_slug, code, title, term, units, status, note, sort_key)
     VALUES (?,?,?,?,?,?,?,?)`,
    fields.school_slug, fields.code || null, fields.title, fields.term || null,
    fields.units || null, status, fields.note || null,
    nextKeyFor('course', 'school_slug = ?', fields.school_slug)
  );
  return Number(res.lastInsertRowid);
}

function deleteCourse(id) {
  run('DELETE FROM course WHERE id = ?', Number(id));
}

function listActivities(schoolSlug) {
  return schoolSlug === undefined
    ? all('SELECT * FROM activity ORDER BY sort_key')
    : all(
      schoolSlug === null
        ? 'SELECT * FROM activity WHERE school_slug IS NULL ORDER BY sort_key'
        : 'SELECT * FROM activity WHERE school_slug = ? ORDER BY sort_key',
      ...(schoolSlug === null ? [] : [schoolSlug])
    );
}

function saveActivity(fields) {
  const kind = ACTIVITY_KINDS.includes(fields.kind) ? fields.kind : 'activity';
  if (fields.id) {
    run(
      `UPDATE activity SET school_slug=?, title=?, role=?, detail=?, started_on=?, ended_on=?, kind=? WHERE id=?`,
      fields.school_slug || null, fields.title, fields.role || null, fields.detail || null,
      fields.started_on || null, fields.ended_on || null, kind, Number(fields.id)
    );
    return Number(fields.id);
  }
  const res = run(
    `INSERT INTO activity (school_slug, title, role, detail, started_on, ended_on, kind, sort_key)
     VALUES (?,?,?,?,?,?,?,?)`,
    fields.school_slug || null, fields.title, fields.role || null, fields.detail || null,
    fields.started_on || null, fields.ended_on || null, kind, nextKeyFor('activity')
  );
  return Number(res.lastInsertRowid);
}

function deleteActivity(id) {
  run('DELETE FROM activity WHERE id = ?', Number(id));
}

/* ------------------------------------------------------------ personal wall
 *
 * One wall, not a set of albums.
 *
 * This started as albums with a title and a blurb each, and the personal page
 * rendered a section per album. That is categorisation, and categorisation is
 * the thing that makes a photo wall stop being added to: every upload becomes a
 * decision about which bucket it belongs in, and the page becomes a stack of
 * short sections rather than a wall.
 *
 * So there is exactly one question about a photograph: is it on the wall or is
 * it not. `media.album_slug` is that flag. It stays a foreign key to a single
 * album row rather than becoming a boolean column, because rebuilding a STRICT
 * table to drop a constraint is a worse trade than one lookup row that never
 * changes.
 */

const PERSONAL_ALBUM = 'personal';

/**
 * Guarantee the single album row, and fold any others into it.
 *
 * Idempotent, and a no-op once there is nothing to fold, so it costs two cheap
 * reads on every boot rather than a destructive write.
 */
function ensurePersonalWall() {
  run(
    `INSERT INTO album (slug, title, blurb, published, sort_key)
     VALUES (?, 'Personal', NULL, 1, 'a0')
     ON CONFLICT(slug) DO NOTHING`,
    PERSONAL_ALBUM
  );
  const strays = get('SELECT COUNT(*) AS n FROM album WHERE slug != ?', PERSONAL_ALBUM).n;
  if (!strays) return 0;
  // A photograph that was in any album is on the wall. Nothing is dropped.
  run('UPDATE media SET album_slug = ? WHERE album_slug IS NOT NULL AND album_slug != ?',
    PERSONAL_ALBUM, PERSONAL_ALBUM);
  run('DELETE FROM album WHERE slug != ?', PERSONAL_ALBUM);
  return strays;
}

/**
 * Every photograph on the wall, newest capture first.
 *
 * Only rows with real dimensions come back. The collage packs by aspect ratio,
 * and a row with no width or height has no ratio: including it would make the
 * layout fall back to a guess for that one tile and visibly break the row.
 */
function personalPhotos() {
  return all(
    `SELECT id, storage_key, alt, caption, width, height, captured_on, created_at, mime
       FROM media
      WHERE album_slug IS NOT NULL
        AND mime LIKE 'image/%'
        AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0
      ORDER BY COALESCE(captured_on, created_at) DESC, id DESC`
  );
}

/** Photographs in the library that are not on the wall. */
function offWallPhotos(limit = 200) {
  return all(
    `SELECT id, storage_key, alt, width, height, created_at
       FROM media
      WHERE album_slug IS NULL AND mime LIKE 'image/%'
      ORDER BY created_at DESC LIMIT ?`,
    limit
  );
}

function countOnWall() {
  return get("SELECT COUNT(*) AS n FROM media WHERE album_slug IS NOT NULL AND mime LIKE 'image/%'").n;
}

/** The only write. `on` decides whether a photograph appears on /personal. */
function setOnWall(mediaId, on) {
  if (on) ensurePersonalWall();
  run('UPDATE media SET album_slug = ? WHERE id = ?', on ? PERSONAL_ALBUM : null, Number(mediaId));
}

module.exports = {
  listFacets, getFacet, facetCounts,
  listProjects, getProjectBySlug, listProjectsByFacet,
  reorderProjects, nextProjectKey, nextKeyFor,
  listNotes, latestNoteDate, getNow,
  search, toMatchQuery, queryTerms, editDistance, correctTerms, upsertSearchRow, reindexProject, reindexAll, plain,
  getPage, getPageForEdit, savePage, PAGE_SLUGS,
  logChange, findRedirect, logError,
  listSchools, getSchool, saveSchool, deleteSchool,
  listCourses, coursesByTerm, coursesByStatus, courseCounts, saveCourse, deleteCourse,
  listActivities, saveActivity, deleteActivity,
  ensurePersonalWall, personalPhotos, offWallPhotos, countOnWall, setOnWall, PERSONAL_ALBUM,
  COURSE_STATUS, ACTIVITY_KINDS, SCHOOL_KINDS, termSortValue,
};
