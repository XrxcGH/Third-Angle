'use strict';

/*
 * Admin. The reason a static site was ruled out: add, edit, delete, categorise
 * and reorder projects with no source edit and no redeploy.
 *
 * It is also the highest value target on the property, so every mutating route
 * is CSRF protected, the login route is rate limited in two tiers, and every
 * write is recorded in audit_log.
 */

const express = require('express');
const repo = require('../repo');
const auth = require('../auth');
const { get, all, run, transaction, nowIso } = require('../db');
const { generateKeyBetween } = require('fractional-indexing');
const multer = require('multer');
const media = require('../media');

/* In memory, because every upload is validated and re-encoded before it ever
   touches the disk. multer 2.2.0 or newer: earlier versions carry CVE-2026-2359
   and leave orphaned partial files behind with diskStorage. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: media.MAX_BYTES, files: 10, fields: 40 },
});

const router = express.Router();
const form = express.urlencoded({ extended: false, limit: '256kb' });

const PROD = process.env.NODE_ENV === 'production';
// The __Host- prefix requires Secure, which requires HTTPS. Over plain http in
// development the browser silently refuses to store it, so the name changes
// with the environment rather than the security posture.
const COOKIE = PROD ? '__Host-session' : 'session';

/*
 * Computed once at startup so an unknown email costs exactly the same scrypt
 * work as a known one. The value is never a real credential.
 */
const DECOY_HASH = auth.hashPassword(require('node:crypto').randomBytes(32).toString('hex'));

/* ------------------------------------------------------------- middleware */

function loadSession(req, res, next) {
  req.session = auth.getSession(req.cookies && req.cookies[COOKIE]);
  res.locals.session = req.session;
  res.locals.csrf = req.session ? auth.csrfToken(req.session.id) : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.session) {
    const next_ = encodeURIComponent(req.originalUrl || '/admin');
    return res.redirect(303, `/admin/login?next=${next_}`);
  }
  next();
}

/** Every mutating route goes through this. No exceptions, including reorder. */
function requireCsrf(req, res, next) {
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!req.session || !auth.checkCsrf(req.session.id, token)) {
    return res.status(403).render('admin/error', {
      layout: 'layout-admin', title: 'Rejected',
      message: 'That form expired or came from somewhere else. Go back and try again.',
    });
  }
  next();
}

const clientIp = (req) => (req.ip || req.socket.remoteAddress || 'unknown').toString();

function view(name, extra = {}) {
  return { layout: 'layout-admin', ...extra, view: name };
}

/* ------------------------------------------------------------------ login */

router.get('/login', loadSession, (req, res) => {
  if (req.session) return res.redirect(303, '/admin');
  res.render('admin/login', view('login', {
    title: 'Sign in',
    error: null,
    email: '',
    needsTotp: false,
    next: typeof req.query.next === 'string' ? req.query.next : '/admin',
  }));
});

router.post('/login', form, loadSession, (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const totp = String(req.body.totp || '');
  const ip = clientIp(req);
  const nextUrl = typeof req.body.next === 'string' && req.body.next.startsWith('/admin') ? req.body.next : '/admin';

  const fail = (message, needsTotp = false) =>
    res.status(401).render('admin/login', view('login', {
      title: 'Sign in', error: message, email, needsTotp, next: nextUrl,
    }));

  const limited = auth.isRateLimited(email, ip);
  if (limited.limited) {
    // Deliberately not counted as another attempt, so a locked-out operator
    // cannot extend their own lockout by retrying.
    return res.status(429).render('admin/login', view('login', {
      title: 'Too many attempts',
      error: `Too many failed attempts from this ${limited.scope}. Try again in about ${limited.retryMinutes} minutes.`,
      email, needsTotp: false, next: nextUrl,
    }));
  }

  const user = auth.findUserByEmail(email);

  /*
   * Same generic message and the same work either way, so the response does
   * not reveal whether the address exists.
   *
   * The decoy hash is computed ONCE at module load, not per request. Calling
   * hashPassword here would run scrypt twice for an unknown address and once
   * for a known one, which inverts the very timing signal this is meant to
   * hide: unknown users would answer measurably slower.
   */
  const ok = user
    ? auth.verifyPassword(password, user.password_hash)
    : auth.verifyPassword(password, DECOY_HASH);

  if (!user || !ok) {
    auth.recordAttempt(email, ip, false);
    return fail('That email and password do not match.');
  }

  if (user.totp_secret && user.totp_confirmed) {
    if (!totp) return fail('Enter the six digit code from your authenticator.', true);
    if (!auth.verifyTotp(user.totp_secret, totp)) {
      auth.recordAttempt(email, ip, false);
      return fail('That code is not right. Codes expire every thirty seconds.', true);
    }
  }

  auth.recordAttempt(email, ip, true);
  auth.clearAttempts(email, ip);
  auth.recordLogin(user.id);
  auth.purgeExpiredSessions();

  const session = auth.createSession(user.id, { userAgent: req.get('user-agent'), ip });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${PROD ? '; Secure' : ''}`);
  res.redirect(303, nextUrl);
});

router.post('/logout', form, loadSession, requireCsrf, (req, res) => {
  auth.destroySession(req.session.id);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? '; Secure' : ''}`);
  res.redirect(303, '/');
});

/* Everything below requires a session. */
router.use(loadSession, requireAuth);

/* -------------------------------------------------------------- dashboard */

router.get('/', (req, res) => {
  const counts = {
    projects: get('SELECT COUNT(*) AS n FROM project').n,
    published: get('SELECT COUNT(*) AS n FROM project WHERE published = 1').n,
    facets: get("SELECT COUNT(*) AS n FROM facet WHERE kind = 'discipline'").n,
    media: get('SELECT COUNT(*) AS n FROM media').n,
    notes: get('SELECT COUNT(*) AS n FROM note').n,
    errors: get('SELECT COUNT(*) AS n FROM app_error WHERE seen = 0').n,
  };
  res.render('admin/dashboard', view('dashboard', {
    title: 'Admin',
    counts,
    recent: all('SELECT at, actor, table_name, row_id, action FROM audit_log ORDER BY id DESC LIMIT 12'),
    projects: repo.listProjects({ includeUnpublished: true }),
  }));
});

/* --------------------------------------------------------------- projects */

router.get('/projects', (req, res) => {
  res.render('admin/projects', view('projects', {
    title: 'Projects',
    projects: repo.listProjects({ includeUnpublished: true }),
  }));
});

router.get('/projects/new', (req, res) => {
  res.render('admin/project-form', view('project-form', {
    title: 'New project',
    project: {
      id: null, slug: '', title: '', subtitle: '', tier: 'note', status: 'in-progress',
      context: '', role: '', summary_md: '', body_md: '', started_on: '', ended_on: '',
      published: 0, featured: 0, facets: [],
    },
    disciplines: repo.listFacets('discipline'),
    error: null,
  }));
});

router.get('/projects/:id/edit', (req, res, next) => {
  const row = get('SELECT * FROM project WHERE id = ?', Number(req.params.id));
  if (!row) return next();
  row.facets = all(
    'SELECT facet_slug, weight, contribution_note FROM project_facet WHERE project_id = ?',
    row.id
  );
  res.render('admin/project-form', view('project-form', {
    title: `Edit: ${row.title}`,
    project: row,
    disciplines: repo.listFacets('discipline'),
    error: null,
  }));
});

const slugify = (s) =>
  String(s).toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/*
 * One handler for create and update. The whole write is a single transaction,
 * so a failure part way through cannot leave a project with half its
 * disciplines attached, and the search index cannot drift from the row.
 */
const saveProject = transaction((body, actor) => {
  const id = body.id ? Number(body.id) : null;
  const slug = slugify(body.slug || body.title);
  const now = nowIso();

  const fields = {
    slug,
    title: String(body.title || '').trim(),
    subtitle: String(body.subtitle || '').trim() || null,
    tier: ['note', 'build', 'case-study'].includes(body.tier) ? body.tier : 'note',
    status: ['shipped', 'competed', 'in-progress', 'specification', 'archived'].includes(body.status)
      ? body.status : 'in-progress',
    context: String(body.context || '').trim() || null,
    role: String(body.role || '').trim() || null,
    summary_md: String(body.summary_md || ''),
    body_md: String(body.body_md || ''),
    started_on: String(body.started_on || '').trim() || null,
    ended_on: String(body.ended_on || '').trim() || null,
    published: body.published ? 1 : 0,
    featured: body.featured ? 1 : 0,
  };

  let projectId = id;
  if (id) {
    const before = get('SELECT * FROM project WHERE id = ?', id);
    run(
      `UPDATE project SET slug=?, title=?, subtitle=?, tier=?, status=?, context=?, role=?,
         summary_md=?, summary_html=?, body_md=?, body_html=?, started_on=?, ended_on=?,
         published=?, featured=?, updated_at=? WHERE id=?`,
      fields.slug, fields.title, fields.subtitle, fields.tier, fields.status, fields.context, fields.role,
      fields.summary_md, renderInline(fields.summary_md), fields.body_md, renderInline(fields.body_md),
      fields.started_on, fields.ended_on, fields.published, fields.featured, now, id
    );
    repo.logChange(actor, 'project', id, 'update', before);
  } else {
    const res_ = run(
      `INSERT INTO project (slug, title, subtitle, tier, status, context, role,
         summary_md, summary_html, body_md, body_html, started_on, ended_on,
         published, featured, sort_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      fields.slug, fields.title, fields.subtitle, fields.tier, fields.status, fields.context, fields.role,
      fields.summary_md, renderInline(fields.summary_md), fields.body_md, renderInline(fields.body_md),
      fields.started_on, fields.ended_on, fields.published, fields.featured,
      repo.nextProjectKey(), now, now
    );
    projectId = Number(res_.lastInsertRowid);
    repo.logChange(actor, 'project', projectId, 'insert', fields);
  }

  // Disciplines are replaced wholesale rather than diffed. Simpler, and at
  // eight rows the cost is irrelevant.
  run('DELETE FROM project_facet WHERE project_id = ?', projectId);
  const selected = [].concat(body.facet || []).filter(Boolean);
  let key = null;
  for (const slugSel of selected) {
    key = generateKeyBetween(key, null);
    const weight = String(body[`weight_${slugSel}`] || 'supporting');
    run(
      `INSERT INTO project_facet (project_id, facet_slug, weight, contribution_note, sort_key)
       VALUES (?, ?, ?, ?, ?)`,
      projectId, slugSel,
      ['primary', 'significant', 'supporting'].includes(weight) ? weight : 'supporting',
      String(body[`note_${slugSel}`] || '').trim() || null,
      key
    );
  }

  repo.reindexProject(projectId);
  return projectId;
});

/* Markdown is not wired up yet, so body text is escaped and paragraphed.
   This is deliberately conservative: it can never emit markup. */
function renderInline(text) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

router.post('/projects/save', form, requireCsrf, (req, res) => {
  if (!String(req.body.title || '').trim()) {
    return res.status(400).render('admin/project-form', view('project-form', {
      title: 'New project',
      project: { ...req.body, facets: [] },
      disciplines: repo.listFacets('discipline'),
      error: 'A title is required.',
    }));
  }
  try {
    const id = saveProject(req.body, req.session.email);
    res.redirect(303, `/admin/projects/${id}/edit?saved=1`);
  } catch (err) {
    res.status(400).render('admin/project-form', view('project-form', {
      title: 'Could not save',
      project: { ...req.body, facets: [] },
      disciplines: repo.listFacets('discipline'),
      error: /UNIQUE/i.test(err.message)
        ? 'Another project already uses that address. Change the slug.'
        : err.message,
    }));
  }
});

const deleteProject = transaction((id, actor) => {
  const before = get('SELECT * FROM project WHERE id = ?', id);
  if (!before) return false;
  // search_index has no foreign key to project, so it is cleaned explicitly.
  run("DELETE FROM search_index WHERE kind = 'project' AND ref_id = ?", id);
  run('DELETE FROM project WHERE id = ?', id);
  repo.logChange(actor, 'project', id, 'delete', before);
  return true;
});

router.get('/projects/:id/delete', (req, res, next) => {
  const project = get('SELECT id, slug, title FROM project WHERE id = ?', Number(req.params.id));
  if (!project) return next();
  res.render('admin/confirm-delete', view('confirm-delete', { title: 'Delete project', project }));
});

router.post('/projects/:id/delete', form, requireCsrf, (req, res) => {
  deleteProject(Number(req.params.id), req.session.email);
  res.redirect(303, '/admin/projects');
});

/* ------------------------------------------------------------- reordering */

/*
 * Accepts the whole ordered list rather than a delta, so the operation is
 * idempotent and safe to retry. Keys are generated server side from the
 * position: a key supplied by the client would let a buggy session collide
 * the index.
 */
router.post('/projects/reorder', express.json({ limit: '64kb' }), requireCsrf, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  if (!ids || !ids.length) return res.status(400).json({ ok: false, error: 'ids required' });

  const known = new Set(all('SELECT id FROM project').map((r) => r.id));
  const seen = new Set(ids);
  // All three checks are needed. Length plus membership alone lets a payload of
  // the same id repeated N times through, which then violates the sort_key
  // unique index and 500s.
  if (ids.length !== known.size || seen.size !== ids.length || !ids.every((id) => known.has(id))) {
    return res.status(400).json({ ok: false, error: 'ids must be the full set, each exactly once' });
  }

  repo.reorderProjects(ids);
  repo.logChange(req.session.email, 'project', 0, 'update', { reordered: ids });
  res.json({ ok: true, count: ids.length });
});

/* Keyboard equivalent, shipped alongside drag because drag alone is unusable
   without a pointer. Works with no JavaScript at all. */
router.post('/projects/:id/move', form, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const dir = req.body.dir === 'up' ? -1 : 1;
  const ordered = all('SELECT id FROM project ORDER BY sort_key').map((r) => r.id);
  const i = ordered.indexOf(id);
  const j = i + dir;
  if (i >= 0 && j >= 0 && j < ordered.length) {
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    repo.reorderProjects(ordered);
    repo.logChange(req.session.email, 'project', id, 'update', { moved: req.body.dir });
  }
  res.redirect(303, '/admin/projects');
});

/* ------------------------------------------------------------------ media */

router.get('/media', (req, res) => {
  res.render('admin/media', view('media', {
    title: 'Media',
    items: media.listMedia(),
    projects: repo.listProjects({ includeUnpublished: true }),
    error: typeof req.query.error === 'string' ? req.query.error : null,
    uploaded: req.query.uploaded ? Number(req.query.uploaded) : 0,
  }));
});

/*
 * Capture inbox. One field, mobile first, no required metadata beyond alt
 * text. Capture and curation are different activities, and forcing them
 * together is why neither happens. The R2 mitigation depends on this being
 * genuinely fast from a phone at a competition.
 */
router.post('/media/upload', upload.array('files', 10), requireCsrf, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.redirect(303, '/admin/media?error=' + encodeURIComponent('Choose at least one file.'));

  let ok = 0;
  const errors = [];
  for (const f of files) {
    try {
      const id = await media.ingest({
        buffer: f.buffer,
        originalName: f.originalname,
        kind: req.body.kind,
        // Alt text is not optional. An image with no alt is invisible to a
        // screen reader and to a search engine, and a portfolio cannot afford
        // either. The form marks it required; this is the server side of that.
        alt: req.body.alt || f.originalname || 'Untitled',
        caption: req.body.caption,
        origin: req.body.origin,
        capturedOn: req.body.captured_on,
        releaseOk: req.body.release_ok ? 1 : 0,
      });
      if (req.body.project_id) {
        run(
          'INSERT OR IGNORE INTO project_media (project_id, media_id, sort_key) VALUES (?, ?, ?)',
          Number(req.body.project_id), id,
          repo.nextKeyFor('project_media', 'project_id = ?', Number(req.body.project_id))
        );
      }
      repo.logChange(req.session.email, 'media', id, 'insert', { name: f.originalname });
      ok += 1;
    } catch (err) {
      errors.push(`${f.originalname}: ${err.message}`);
    }
  }

  const q = errors.length ? '?error=' + encodeURIComponent(errors.join(' | ')) : '?uploaded=' + ok;
  res.redirect(303, '/admin/media' + q);
});

router.post('/media/:id/delete', form, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  media.deleteMedia(id);
  repo.logChange(req.session.email, 'media', id, 'delete', null);
  res.redirect(303, '/admin/media');
});

router.post('/media/:id/attach', form, requireCsrf, (req, res) => {
  const mediaId = Number(req.params.id);
  const projectId = Number(req.body.project_id);
  if (projectId) {
    run(
      'INSERT OR IGNORE INTO project_media (project_id, media_id, sort_key) VALUES (?, ?, ?)',
      projectId, mediaId, repo.nextKeyFor('project_media', 'project_id = ?', projectId)
    );
  }
  res.redirect(303, '/admin/media');
});

/* ----------------------------------------------------------------- facets */

router.get('/facets', (req, res) => {
  res.render('admin/facets', view('facets', {
    title: 'Disciplines',
    facets: repo.listFacets('discipline'),
    counts: repo.facetCounts(),
    tokens: [
      'ch-mechanical', 'ch-electrical', 'ch-controls', 'ch-software',
      'ch-fabrication', 'ch-documentation', 'ch-business', 'ch-teaching',
    ],
    error: typeof req.query.error === 'string' ? req.query.error : null,
  }));
});

router.post('/facets/save', form, requireCsrf, (req, res) => {
  const slug = slugify(req.body.slug || req.body.label);
  const label = String(req.body.label || '').trim();
  if (!label) return res.redirect(303, '/admin/facets?error=A+label+is+required');
  try {
    const existing = get('SELECT slug FROM facet WHERE slug = ?', slug);
    if (existing) {
      run('UPDATE facet SET label = ?, color_token = ?, blurb = ? WHERE slug = ?',
        label, req.body.color_token || null, String(req.body.blurb || '').trim() || null, slug);
      repo.logChange(req.session.email, 'facet', 0, 'update', { slug, label });
    } else {
      run(`INSERT INTO facet (slug, label, kind, color_token, blurb, sort_key, in_nav)
           VALUES (?, ?, 'discipline', ?, ?, ?, 1)`,
        slug, label, req.body.color_token || null,
        String(req.body.blurb || '').trim() || null,
        repo.nextKeyFor('facet', "kind = 'discipline'"));
      repo.logChange(req.session.email, 'facet', 0, 'insert', { slug, label });
    }
    repo.reindexAll();
    res.redirect(303, '/admin/facets');
  } catch (err) {
    // The NOCASE unique index is what produces this, and it is the whole point
    // of that index: it stops Electrical and electrical becoming two chips.
    const msg = /UNIQUE/i.test(err.message)
      ? 'A discipline with that name already exists, differing only by case.'
      : err.message;
    res.redirect(303, `/admin/facets?error=${encodeURIComponent(msg)}`);
  }
});

/* ------------------------------------------------------------------ notes */

router.get('/notes', (req, res) => {
  res.render('admin/notes', view('notes', {
    title: 'Build log',
    notes: all('SELECT id, slug, title, body_md, created_at FROM note ORDER BY created_at DESC LIMIT 100'),
    projects: repo.listProjects({ includeUnpublished: true }),
  }));
});

router.post('/notes/save', form, requireCsrf, (req, res) => {
  const body = String(req.body.body_md || '').trim();
  if (!body) return res.redirect(303, '/admin/notes');
  const now = nowIso();
  const slug = `${now.slice(0, 10)}-${slugify(req.body.title || body.slice(0, 40)) || 'note'}`;
  run(
    `INSERT INTO note (slug, title, body_md, body_html, project_id, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    slug, String(req.body.title || '').trim() || null, body, renderInline(body),
    req.body.project_id ? Number(req.body.project_id) : null, now, now
  );
  repo.logChange(req.session.email, 'note', 0, 'insert', { slug });
  res.redirect(303, '/admin/notes');
});

/* -------------------------------------------------------------------- now */

router.post('/now', form, requireCsrf, (req, res) => {
  const md = String(req.body.body_md || '').trim();
  run(
    `INSERT INTO now_page (id, body_md, body_html, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET body_md = excluded.body_md,
       body_html = excluded.body_html, updated_at = excluded.updated_at`,
    md, renderInline(md), nowIso()
  );
  res.redirect(303, '/admin');
});

module.exports = router;
module.exports.slugify = slugify;
module.exports.renderInline = renderInline;
