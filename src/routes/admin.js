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
const documents = require('../documents');
const contact = require('../contact');
const mailer = require('../mailer');
const content = require('../content');
const markup = require('../markup');
const settings = require('../settings');
const github = require('../github');
const collage = require('../collage');

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

const clientIp = require('../middleware').clientIp;

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
    if (!auth.verifyTotpOnce(user, totp)) {
      auth.recordAttempt(email, ip, false);
      return fail('That code is not right. Codes expire every thirty seconds.', true);
    }
  }

  auth.recordAttempt(email, ip, true);
  auth.recordLogin(user.id);
  auth.purgeExpiredSessions();
  auth.pruneAttempts();

  const session = auth.createSession(user.id, { userAgent: req.get('user-agent'), ip });
  /*
   * A sign in is an audited event, and on a site with one operator it is the
   * most important one there is: every content change was already recorded and
   * the thing that would actually tell somebody they had been broken into was
   * not. A session row is genuinely inserted here, so it is an insert.
   */
  repo.logChange(user.email, 'session', user.id, 'insert',
    { event: 'signed in', ip, agent: String(req.get('user-agent') || '').slice(0, 120) });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${PROD ? '; Secure' : ''}`);
  res.redirect(303, nextUrl);
});

router.post('/logout', form, loadSession, requireCsrf, (req, res) => {
  repo.logChange(req.session.email, 'session', req.session.user_id, 'delete', { event: 'signed out' });
  auth.destroySession(req.session.id);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? '; Secure' : ''}`);
  res.redirect(303, '/');
});

/* Everything below requires a session. */
router.use(loadSession, requireAuth);

/*
 * A temporary password is a hand-over, not a chosen credential, so it is
 * flagged AND it is a lock.
 *
 * This used to be a banner only, on the argument that somebody handed a working
 * login should be able to walk the admin surface before choosing a permanent
 * password. That argument does not survive the site being public: a hand-over
 * credential is by definition one that has been transmitted somewhere, it is
 * exempt from the twelve character floor that a chosen password has to clear
 * (see scripts/create-admin.js), and a banner is dismissed by scrolling. Until
 * it is replaced, the only pages that answer are the account page that replaces
 * it and the way out.
 *
 * The allowlist is by path prefix rather than by route so that a route added
 * later is locked by default rather than accidentally exempt.
 */
const OPEN_WHILE_LOCKED = ['/account', '/logout'];

router.use((req, res, next) => {
  const locked = Boolean(req.session.must_change_password);
  res.locals.mustChangePassword = locked;
  if (!locked) return next();
  if (OPEN_WHILE_LOCKED.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  return res.redirect(303, '/admin/account?must=password');
});

/* ---------------------------------------------------------------- account */

/* Enough to recognise a device you do not own, not an audit log. Sessions last
   fourteen days, so an unbounded list turns into hundreds of rows of the same
   browser and stops being readable, which is the opposite of the point. */
const SESSIONS_SHOWN = 12;

function accountView(req, extra = {}) {
  const user = auth.getUser(req.session.user_id);
  const all_ = auth.listSessions(user.id).map((s) => ({ ...s, current: s.id === req.session.id }));
  return view('account', {
    title: 'Account',
    user,
    sessions: all_.slice(0, SESSIONS_SHOWN),
    sessionCount: all_.length,
    sessionsHidden: Math.max(0, all_.length - SESSIONS_SHOWN),
    minPassword: auth.MIN_PASSWORD,
    error: null,
    notice: null,
    /* Present only immediately after enrolling, and never stored in a cookie
       or a query string: a TOTP secret in a URL ends up in the browser
       history and in any proxy log between here and the screen. */
    enrol: null,
    /* Successes and failures together: a refused attempt from an address the
       operator does not recognise is the thing this page exists to show. */
    attempts: auth.signInActivity(20),
    failedCount: auth.signInActivity(100).filter((a) => !a.ok).length,
    ...extra,
  });
}

router.get('/account', (req, res) => {
  const flash = {
    saved: 'Account details updated.',
    password: 'Password changed. Every other session was signed out.',
    totp: 'Two factor authentication is on. It is required at the next sign in.',
    'totp-off': 'Two factor authentication is off.',
    sessions: 'Other sessions signed out.',
  }[String(req.query.done || '')] || null;
  res.render('admin/account', accountView(req, { notice: flash }));
});

/* Name and address. Deliberately separate from the password form: one of them
   is routine and the other revokes access, and a single Save button for both
   makes the destructive one accidental. */
router.post('/account/profile', form, requireCsrf, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();

  const problem =
    (!name && 'A name is required.') ||
    auth.emailProblem(email) ||
    null;
  if (problem) {
    return res.status(400).render('admin/account', accountView(req, { error: problem }));
  }

  try {
    auth.updateProfile(req.session.user_id, { name, email });
  } catch (err) {
    return res.status(400).render('admin/account', accountView(req, {
      error: /UNIQUE/i.test(err.message)
        ? 'Another account already uses that address.'
        : err.message,
    }));
  }
  repo.logChange(req.session.email, 'user', req.session.user_id, 'update', { name, email });
  res.redirect(303, '/admin/account?done=saved');
});

router.post('/account/password', form, requireCsrf, (req, res) => {
  const user = auth.getUser(req.session.user_id);
  const current = String(req.body.current_password || '');
  const next_ = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');

  /*
   * The current password is required even though the session is already
   * authenticated. A session cookie is what an unattended laptop leaks; the
   * password is what stops that turning into a permanent takeover.
   */
  const problem =
    (!auth.verifyPassword(current, user.password_hash) && 'That is not the current password.') ||
    auth.passwordProblem(next_) ||
    (next_ !== confirm && 'The two new passwords do not match.') ||
    (next_ === current && 'That is already the current password.') ||
    null;

  if (problem) {
    return res.status(400).render('admin/account', accountView(req, { error: problem }));
  }

  auth.setPassword(user.id, next_);
  auth.destroyOtherSessions(user.id, req.session.id);
  repo.logChange(req.session.email, 'user', user.id, 'update', { password_changed: true });
  res.redirect(303, '/admin/account?done=password');
});

/*
 * TOTP enrolment is two steps on purpose. Generating a secret and marking it
 * required in one action locks the operator out whenever the code was never
 * actually added to an authenticator, and the recovery for that is shell
 * access to the box.
 */
router.post('/account/totp/start', form, requireCsrf, (req, res) => {
  const user = auth.getUser(req.session.user_id);
  const secret = auth.generateTotpSecret();
  auth.setTotpSecret(user.id, secret, 0);
  res.render('admin/account', accountView(req, {
    enrol: { secret, uri: auth.totpUri(secret, user.email) },
    notice: 'Add this to your authenticator, then confirm the first code below. It is not required until you do.',
  }));
});

router.post('/account/totp/confirm', form, requireCsrf, (req, res) => {
  const user = auth.getUser(req.session.user_id);
  if (!user.totp_secret) {
    return res.status(400).render('admin/account', accountView(req, {
      error: 'Nothing to confirm. Start the enrolment first.',
    }));
  }
  if (!auth.verifyTotpOnce(user, req.body.totp)) {
    return res.status(400).render('admin/account', accountView(req, {
      enrol: { secret: user.totp_secret, uri: auth.totpUri(user.totp_secret, user.email) },
      error: 'That code did not verify. Codes expire every thirty seconds, so try the next one.',
    }));
  }
  auth.setTotpSecret(user.id, user.totp_secret, 1);
  repo.logChange(req.session.email, 'user', user.id, 'update', { totp: 'confirmed' });
  res.redirect(303, '/admin/account?done=totp');
});

/* Turning it off asks for the password, because a borrowed session should not
   be able to remove the second factor that the session itself bypassed. */
router.post('/account/totp/off', form, requireCsrf, (req, res) => {
  const user = auth.getUser(req.session.user_id);
  if (!auth.verifyPassword(String(req.body.current_password || ''), user.password_hash)) {
    return res.status(400).render('admin/account', accountView(req, {
      error: 'Enter the current password to turn two factor authentication off.',
    }));
  }
  auth.setTotpSecret(user.id, null, 0);
  repo.logChange(req.session.email, 'user', user.id, 'update', { totp: 'removed' });
  res.redirect(303, '/admin/account?done=totp-off');
});

router.post('/account/sessions/revoke', form, requireCsrf, (req, res) => {
  auth.destroyOtherSessions(req.session.user_id, req.session.id);
  res.redirect(303, '/admin/account?done=sessions');
});

/* -------------------------------------------------------------- dashboard */

router.get('/', (req, res) => {
  const counts = {
    projects: get('SELECT COUNT(*) AS n FROM project').n,
    published: get('SELECT COUNT(*) AS n FROM project WHERE published = 1').n,
    facets: get("SELECT COUNT(*) AS n FROM facet WHERE kind = 'discipline'").n,
    media: get('SELECT COUNT(*) AS n FROM media').n,
    documents: get('SELECT COUNT(*) AS n FROM document').n,
    pages: get('SELECT COUNT(*) AS n FROM document_page').n,
    notes: get('SELECT COUNT(*) AS n FROM note').n,
    errors: get('SELECT COUNT(*) AS n FROM app_error WHERE seen = 0').n,
    messages: contact.unreadCount(),
    undelivered: contact.undeliveredCount(),
    photos: repo.countOnWall(),
    courses: get('SELECT COUNT(*) AS n FROM course').n,
    content: content.editedCount(),
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

/* Body text is escaped and paragraphed, never parsed as markup. One
   implementation, in src/markup.js, shared with the seed. */
const renderInline = markup.paragraphs;

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
    summary_md: markup.normaliseNewlines(body.summary_md),
    body_md: markup.normaliseNewlines(body.body_md),
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

    /*
     * The evidence gate. Risk R2.
     *
     * Checked AFTER the write rather than before, for a specific reason: a new
     * project has no media yet, so a pre-check would refuse to let you create
     * a mechanical project at all. Instead the work is always saved, and only
     * the transition to PUBLISHED is refused. Nothing typed is ever lost.
     *
     * The gate has to be invoked here to mean anything. A blocker function
     * that is defined, exported and unit tested but never called is worse than
     * no gate at all, because it looks closed.
     */
    const blockers = req.body.published ? media.publishBlockers(id) : [];
    if (blockers.length) {
      run('UPDATE project SET published = 0 WHERE id = ?', id);
      repo.reindexProject(id);
      const row = get('SELECT * FROM project WHERE id = ?', id);
      row.facets = all(
        'SELECT facet_slug, weight, contribution_note FROM project_facet WHERE project_id = ?',
        id
      );
      return res.render('admin/project-form', view('project-form', {
        title: `Edit: ${row.title}`,
        project: row,
        disciplines: repo.listFacets('discipline'),
        error: `Saved as a draft. ${blockers.join(' ')} Upload evidence on the media page, or set the status to specification if it genuinely is one.`,
      }));
    }

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

/* On or off the personal wall. The wall is what publishes a photograph, and
   it is one wall rather than a set of albums, so this is a boolean. */
router.post('/media/:id/wall', form, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const on = req.body.on === '1';
  repo.setOnWall(id, on);
  repo.logChange(req.session.email, 'media', id, 'update', { wall: on });
  res.redirect(303, req.body.back === 'photos' ? '/admin/photos?saved=1' : '/admin/media');
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

/* -------------------------------------------------------------- documents */

/*
 * Which document is the resume and which is the CV.
 *
 * A role rather than a filename convention: "resume-final-v3.pdf" is not a
 * contract, and the public page has to know which two documents to put at the
 * top without guessing from a title.
 */
router.post('/documents/:id/role', form, requireCsrf, (req, res) => {
  const role = ['resume', 'cv', 'other'].includes(req.body.doc_role) ? req.body.doc_role : 'other';
  // At most one of each. Assigning a role takes it off whatever held it before,
  // because two documents both claiming to be the resume is a page that has to
  // pick one arbitrarily.
  if (role !== 'other') run("UPDATE document SET doc_role = 'other' WHERE doc_role = ?", role);
  run('UPDATE document SET doc_role = ? WHERE id = ?', role, Number(req.params.id));
  repo.logChange(req.session.email, 'document', Number(req.params.id), 'update', { doc_role: role });
  res.redirect(303, '/admin/documents');
});

router.get('/documents', (req, res) => {
  res.render('admin/documents', view('documents', {
    title: 'Documents',
    docs: documents.listDocuments({ includePrivate: true }),
    roles: ['resume', 'cv', 'other'],
    projects: repo.listProjects({ includeUnpublished: true }),
    error: typeof req.query.error === 'string' ? req.query.error : null,
    uploaded: req.query.uploaded ? Number(req.query.uploaded) : 0,
  }));
});

router.post('/documents/upload', upload.array('files', 5), requireCsrf, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.redirect(303, '/admin/documents?error=' + encodeURIComponent('Choose at least one PDF.'));

  let ok = 0;
  const errors = [];
  for (const f of files) {
    try {
      await documents.ingest({
        buffer: f.buffer,
        originalName: f.originalname,
        // With several files the per-file title field cannot apply to all of
        // them, so only a single upload takes the typed title.
        title: files.length === 1 ? req.body.title : '',
        description: files.length === 1 ? req.body.description : '',
        projectId: req.body.project_id ? Number(req.body.project_id) : null,
        visibility: req.body.visibility,
        actor: req.session.email,
      });
      ok += 1;
    } catch (err) {
      errors.push(`${f.originalname}: ${err.message}`);
    }
  }
  const q = errors.length ? '?error=' + encodeURIComponent(errors.join(' | ')) : '?uploaded=' + ok;
  res.redirect(303, '/admin/documents' + q);
});

router.post('/documents/:id/delete', form, requireCsrf, (req, res) => {
  documents.remove(Number(req.params.id), req.session.email);
  res.redirect(303, '/admin/documents');
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

/* --------------------------------------------------------------- settings */

router.get('/settings', (req, res) => {
  res.render('admin/settings', view('settings', {
    title: 'Settings',
    definitions: settings.DEFINITIONS,
    values: settings.allSettings(),
    mail: {
      configured: mailer.isConfigured(),
      host: mailer.config().host,
      port: mailer.config().port,
      from: mailer.config().from,
      recipient: contact.recipient(),
    },
    gh: github.snapshot({ live: false }),
    saved: Boolean(req.query.saved),
    refreshed: req.query.refreshed || null,
  }));
});

router.post('/settings', form, requireCsrf, (req, res) => {
  settings.saveFromForm(req.body || {});
  repo.logChange(req.session.email, 'setting', 0, 'update', settings.allSettings());
  res.redirect(303, '/admin/settings?saved=1');
});

/* Pull GitHub now rather than waiting for the hourly refresh. Useful straight
   after a repository is renamed, and the only way to see an API error. */
router.post('/settings/github/refresh', form, requireCsrf, async (req, res) => {
  const result = await github.refresh();
  res.redirect(303, `/admin/settings?refreshed=${result.ok ? 'ok' : 'failed'}`);
});

/* --------------------------------------------------------------- education */

router.get('/education', (req, res) => {
  const schools = repo.listSchools().map((sch) => ({
    ...sch,
    courses: repo.listCourses(sch.slug),
    counts: repo.courseCounts(sch.slug),
  }));
  res.render('admin/education', view('education', {
    title: 'Education',
    schools,
    activities: repo.listActivities(),
    statuses: repo.COURSE_STATUS,
    kinds: repo.ACTIVITY_KINDS,
    schoolKinds: repo.SCHOOL_KINDS,
    editCourse: req.query.course
      ? get('SELECT * FROM course WHERE id = ?', Number(req.query.course))
      : null,
    editActivity: req.query.activity
      ? get('SELECT * FROM activity WHERE id = ?', Number(req.query.activity))
      : null,
    saved: Boolean(req.query.saved),
    error: null,
  }));
});

router.post('/education/school', form, requireCsrf, (req, res) => {
  const slug = slugify(req.body.slug || req.body.name);
  if (!slug || !String(req.body.name || '').trim()) return res.redirect(303, '/admin/education');
  repo.saveSchool(slug, req.body);
  repo.logChange(req.session.email, 'school', 0, 'update', { slug });
  res.redirect(303, '/admin/education?saved=1');
});

router.post('/education/school/:slug/delete', form, requireCsrf, (req, res) => {
  repo.deleteSchool(req.params.slug);
  repo.logChange(req.session.email, 'school', 0, 'delete', { slug: req.params.slug });
  res.redirect(303, '/admin/education');
});

router.post('/education/course', form, requireCsrf, (req, res) => {
  if (!String(req.body.title || '').trim() || !req.body.school_slug) {
    return res.redirect(303, '/admin/education');
  }
  try {
    repo.saveCourse(req.body);
  } catch (err) {
    // The unique index is what stops the same class being listed twice, and a
    // 500 on a duplicate would look like a broken page rather than a rejected
    // entry.
    const schools = repo.listSchools().map((sch) => ({
      ...sch, courses: repo.listCourses(sch.slug), counts: repo.courseCounts(sch.slug),
    }));
    return res.status(400).render('admin/education', view('education', {
      title: 'Education',
      schools,
      activities: repo.listActivities(),
      statuses: repo.COURSE_STATUS,
      kinds: repo.ACTIVITY_KINDS,
      schoolKinds: repo.SCHOOL_KINDS,
      editCourse: null,
      editActivity: null,
      saved: false,
      error: /UNIQUE/i.test(err.message)
        ? 'That class is already listed for this school in that term.'
        : err.message,
    }));
  }
  res.redirect(303, '/admin/education?saved=1');
});

router.post('/education/course/:id/delete', form, requireCsrf, (req, res) => {
  repo.deleteCourse(req.params.id);
  res.redirect(303, '/admin/education');
});

router.post('/education/activity', form, requireCsrf, (req, res) => {
  if (!String(req.body.title || '').trim()) return res.redirect(303, '/admin/education');
  repo.saveActivity({ ...req.body, school_slug: req.body.school_slug || null });
  res.redirect(303, '/admin/education?saved=1');
});

router.post('/education/activity/:id/delete', form, requireCsrf, (req, res) => {
  repo.deleteActivity(req.params.id);
  res.redirect(303, '/admin/education');
});

/* ---------------------------------------------------------------- content */

/*
 * One screen for every fixed string on the public site.
 *
 * A page at a time, because 150 fields in one form is not an editing surface,
 * and because the unit somebody thinks in is "the education page", not "the
 * content model". The dropdown is a GET form with a real submit button rather
 * than an onchange handler: there is no JavaScript on this site, in the admin
 * either.
 */
router.get('/content', (req, res) => {
  const wanted = String(req.query.page || '');
  const page = content.PAGES.find((p) => p.slug === wanted) || content.PAGES[0];
  res.render('admin/content', view('content', {
    title: 'Content',
    pages: content.PAGES,
    page,
    slots: content.forPage(page.slug),
    /* Only images, and only ones with dimensions: an image slot that pointed at
       a PDF would render a broken tag on every page of the site. */
    images: all(
      `SELECT id, storage_key, alt, width, height FROM media
        WHERE mime LIKE 'image/%' ORDER BY created_at DESC LIMIT 200`
    ),
    edited: content.editedCount(),
    saved: Boolean(req.query.saved),
  }));
});

router.post('/content', form, requireCsrf, (req, res) => {
  const page = content.PAGES.find((p) => p.slug === String(req.body.page || ''));
  if (!page) return res.redirect(303, '/admin/content');

  /*
   * Iterate the registry, not the body. A checkbox that is off sends nothing at
   * all, so a loop over what arrived cannot tell "unchecked" from "not on this
   * form", and every flag would be stuck on forever.
   */
  let changed = 0;
  for (const slot of content.forPage(page.slug)) {
    if (req.body[`r:${slot.key}`]) {
      if (slot.edited) { content.reset(slot.key); changed += 1; }
      continue;
    }
    const raw = slot.kind === 'flag'
      ? Boolean(req.body[`c:${slot.key}`])
      : String(req.body[`c:${slot.key}`] ?? '');
    const now = slot.kind === 'flag' ? (slot.value === '1') : slot.value;
    if (raw !== now) { content.set(slot.key, raw); changed += 1; }
  }

  if (changed) repo.logChange(req.session.email, 'content', 0, 'update', { page: page.slug, changed });
  res.redirect(303, `/admin/content?page=${page.slug}&saved=1`);
});

/* ----------------------------------------------------------------- photos */

/*
 * The personal page is one wall, not a set of albums, so this screen asks one
 * question per photograph: on the wall or off it. There is no ordering control
 * and no folder to pick, because the wall orders itself by capture date and
 * packs itself from the shape of each photograph.
 */
router.get('/photos', (req, res) => {
  res.render('admin/photos', view('photos', {
    title: 'Photos',
    onWall: repo.personalPhotos(),
    /* In the library and not on the wall, so they appear nowhere on the
       personal page. This list exists because that is the one state nothing
       else on the site would show you. */
    off: repo.offWallPhotos(),
    saved: Boolean(req.query.saved),
  }));
});

/* Put several on the wall at once, from the off-wall list. */
router.post('/photos/add', form, requireCsrf, (req, res) => {
  const ids = [].concat(req.body.media_id || []).map(Number).filter(Boolean);
  for (const id of ids) repo.setOnWall(id, true);
  if (ids.length) {
    repo.logChange(req.session.email, 'media', ids[0], 'update', { wall: true, count: ids.length });
  }
  res.redirect(303, '/admin/photos?saved=1');
});

/* The albums screen is gone. Keep the URL working rather than 404 a bookmark. */
router.get('/albums', (req, res) => res.redirect(301, '/admin/photos'));

/* --------------------------------------------------------------- messages */

router.get('/messages', (req, res) => {
  res.render('admin/messages', view('messages', {
    title: 'Messages',
    messages: contact.listMessages(),
    mailConfigured: mailer.isConfigured(),
    forwarding: settings.getSetting('contact_forward'),
    recipient: contact.recipient(),
    undelivered: contact.undeliveredCount(),
    notice: req.query.sent === '1' ? 'Message forwarded.'
      : (req.query.sent === '0' ? 'That did not send. The reason is on the row.' : null),
  }));
});

/*
 * Retry one forward.
 *
 * The message is already stored, so this is only ever about the notification.
 * Retry is a button rather than a background queue: the operator is the only
 * person who needs it, and a retry loop on a single writer SQLite box is
 * machinery this does not need.
 */
router.post('/messages/:id/forward', form, requireCsrf, async (req, res) => {
  const result = await contact.forward(Number(req.params.id));
  res.redirect(303, `/admin/messages?sent=${result.ok ? '1' : '0'}`);
});

router.post('/messages/:id/read', form, requireCsrf, (req, res) => {
  contact.markRead(Number(req.params.id));
  res.redirect(303, '/admin/messages');
});

router.post('/messages/:id/delete', form, requireCsrf, (req, res) => {
  contact.remove(Number(req.params.id));
  repo.logChange(req.session.email, 'message', Number(req.params.id), 'delete', null);
  res.redirect(303, '/admin/messages');
});

/* ------------------------------------------------------------------ pages */

router.get('/pages/:slug', (req, res, next) => {
  const page = repo.getPageForEdit(req.params.slug);
  if (!repo.PAGE_SLUGS.includes(req.params.slug)) return next();
  res.render('admin/page-form', view('page-form', {
    title: `Edit: ${req.params.slug}`,
    slug: req.params.slug,
    page: page || { slug: req.params.slug, title: '', subtitle: '', body_md: '', published: 1 },
    saved: Boolean(req.query.saved),
  }));
});

router.post('/pages/:slug', form, requireCsrf, (req, res, next) => {
  if (!repo.PAGE_SLUGS.includes(req.params.slug)) return next();
  const md = markup.normaliseNewlines(req.body.body_md);
  repo.savePage(req.params.slug, {
    title: String(req.body.title || '').trim() || req.params.slug,
    subtitle: String(req.body.subtitle || '').trim(),
    body_md: md,
    // Same renderer the seed uses, so what the admin saves and what the seed
    // produces cannot diverge.
    //
    // This used to require scripts/seed-pages.js. Requiring a script from a
    // route runs the script: every page save re-ran assertEnvironment,
    // migrate and the seeding loop, and would recreate a page the operator had
    // deliberately deleted. The renderer now lives in src/markup.js and the
    // script is a script again.
    body_html: markup.richText(md),
    published: req.body.published ? 1 : 0,
  });
  repo.logChange(req.session.email, 'page', 0, 'update', { slug: req.params.slug });
  res.redirect(303, `/admin/pages/${req.params.slug}?saved=1`);
});

/* ------------------------------------------------------------------ notes */

router.get('/notes', (req, res) => {
  const editing = req.query.edit
    ? get('SELECT * FROM note WHERE id = ?', Number(req.query.edit))
    : null;
  res.render('admin/notes', view('notes', {
    title: 'Build log',
    notes: all(
      `SELECT id, slug, title, body_md, published, created_at, updated_at
         FROM note ORDER BY created_at DESC LIMIT 100`
    ),
    editing,
    projects: repo.listProjects({ includeUnpublished: true }),
  }));
});

/*
 * One route for both. An entry that can be written and never corrected is an
 * entry nobody writes in the first place, because a typo is permanent.
 *
 * The slug is derived once, on insert, and never again: it is the entry's
 * address, and rewriting it because a title was corrected breaks every link
 * anybody has to it.
 */
router.post('/notes/save', form, requireCsrf, (req, res) => {
  const body = markup.normaliseNewlines(req.body.body_md).trim();
  if (!body) return res.redirect(303, '/admin/notes');
  const now = nowIso();
  const id = Number(req.body.id) || 0;
  const title = String(req.body.title || '').trim() || null;
  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  const published = req.body.published ? 1 : 0;

  if (id) {
    run(
      `UPDATE note SET title = ?, body_md = ?, body_html = ?, project_id = ?,
              published = ?, updated_at = ?
        WHERE id = ?`,
      title, body, renderInline(body), projectId, published, now, id
    );
    repo.logChange(req.session.email, 'note', id, 'update', { title });
  } else {
    const slug = `${now.slice(0, 10)}-${slugify(req.body.title || body.slice(0, 40)) || 'note'}`;
    run(
      `INSERT INTO note (slug, title, body_md, body_html, project_id, published, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      slug, title, body, renderInline(body), projectId, published, now, now
    );
    repo.logChange(req.session.email, 'note', 0, 'insert', { slug });
  }
  res.redirect(303, '/admin/notes');
});

router.post('/notes/:id/delete', form, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  run('DELETE FROM note WHERE id = ?', id);
  repo.logChange(req.session.email, 'note', id, 'delete', null);
  res.redirect(303, '/admin/notes');
});

/* -------------------------------------------------------------------- now */

router.post('/now', form, requireCsrf, (req, res) => {
  const md = markup.normaliseNewlines(req.body.body_md).trim();
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
