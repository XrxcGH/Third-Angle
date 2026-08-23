'use strict';

const express = require('express');
const repo = require('../repo');
const { setTheme } = require('../middleware');
const seo = require('../seo');
const documents = require('../documents');
const contact = require('../contact');
const github = require('../github');
const settings = require('../settings');
const collage = require('../collage');
const mailer = require('../mailer');
const content = require('../content');

const router = express.Router();

const DISCIPLINE_ORDER = ['discipline'];

/** Everything the header and filter bar need, on every page. */
function chrome() {
  return { disciplines: repo.listFacets('discipline'), counts: repo.facetCounts() };
}

/* ------------------------------------------------------------------- home */

router.get('/', (req, res) => {
  const projects = repo.listProjects();
  res.render('pages/home', {
    ...chrome(),
    title: content.value('home.meta.title'),
    description: content.value('home.meta.description'),
    projects,
    featured: projects.filter((p) => p.featured).slice(0, 3),
    now: repo.getNow(),
    notes: repo.listNotes(3),
    jsonLd: seo.jsonLd(res.locals.siteUrl),
    ogImage: registerOg({
      title: 'I build the machine, wire it, and write the code that runs it',
      subtitle: 'Mechanical engineering at UCLA. Four seasons of FIRST Robotics.',
      eyebrow: 'Eric J. Dean',
    }),
  });
});

/* ------------------------------------------------------------------- work */

router.get('/work', (req, res) => {
  const active = typeof req.query.d === 'string' ? req.query.d : null;
  const projects = repo.listProjects();

  /*
   * Non-matching projects are NOT removed. They are marked, moved below the
   * matches, and de-emphasised in CSS, so the breadth claim stays visible and
   * the filter is linkable and indexable because it lives in the query string
   * rather than in client state.
   *
   * Matches first, though. Marking alone left the work somebody asked for
   * scattered down a page of work they did not, which is a filter that makes
   * the reader do the filtering.
   */
  const decorated = projects.map((p) => ({
    ...p,
    match: !active || p.facetSlugs.includes(active),
  }));
  const ordered = active
    ? [...decorated.filter((p) => p.match), ...decorated.filter((p) => !p.match)]
    : decorated;
  const matchCount = decorated.filter((p) => p.match).length;

  res.render('pages/work', {
    ...chrome(),
    title: content.value('work.meta.title'),
    description: content.value('work.meta.description'),
    projects: ordered,
    active,
    matchCount,
    jsonLd: seo.jsonLd(res.locals.siteUrl, { trail: [{ name: 'Home', url: '/' }, { name: 'Work', url: '/work' }] }),
    ogImage: registerOg({ title: 'Work', subtitle: String(projects.length) + ' projects across eight disciplines.', eyebrow: 'Eric J. Dean' }),
  });
});

router.get('/work/:slug', (req, res, next) => {
  const project = repo.getProjectBySlug(req.params.slug);
  if (!project) return next();
  res.render('pages/project', {
    ...chrome(),
    title: project.title,
    description: project.subtitle || repo.plain(project.summary_md).slice(0, 160),
    project,
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      project,
      trail: [{ name: 'Home', url: '/' }, { name: 'Work', url: '/work' }, { name: project.title, url: '/work/' + project.slug }],
    }),
    ogImage: registerOg({
      title: project.title,
      subtitle: project.subtitle || '',
      eyebrow: project.context || 'Project',
    }),
  });
});

/* ------------------------------------------------------------ disciplines */

router.get('/disciplines', (req, res) => {
  res.render('pages/disciplines', {
    ...chrome(),
    title: content.value('disciplines.meta.title'),
    description: content.value('disciplines.meta.description'),
  });
});

router.get('/disciplines/:slug', (req, res, next) => {
  const facet = repo.getFacet(req.params.slug);
  if (!facet || facet.kind !== 'discipline') return next();
  const projects = repo.listProjectsByFacet(facet.slug);
  res.render('pages/discipline', {
    ...chrome(),
    title: facet.label,
    description: facet.blurb || `${facet.label} work.`,
    facet,
    projects,
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      trail: [{ name: 'Home', url: '/' }, { name: 'Disciplines', url: '/disciplines' }, { name: facet.label, url: '/disciplines/' + facet.slug }],
    }),
    ogImage: registerOg({
      title: facet.label,
      subtitle: String(projects.length) + ' project' + (projects.length === 1 ? '' : 's'),
      eyebrow: 'Discipline',
    }),
  });
});

/* ----------------------------------------------------------------- search */

router.get('/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
  const { results, fallback } = q ? repo.search(q) : { results: [], fallback: null };
  res.render('pages/search', {
    ...chrome(),
    title: q ? `${content.value('search.meta.title')}: ${q}` : content.value('search.meta.title'),
    description: content.value('search.meta.description'),
    q, results, fallback,
  });
});

/* ----------------------------------------------------------------- resume */

/*
 * The resume used to be its own page, with its own copy of the text and its own
 * PDF under data/resume. It is now one of the documents: pinned at the top of
 * /documents with an inline reader, a download, and full text search inside it,
 * which is everything the separate page did, maintained in one place instead of
 * two.
 *
 * A permanent redirect rather than a deletion. This address is on applications
 * and in email signatures, and those cannot be edited after the fact.
 */
router.get('/resume', (req, res) => res.redirect(301, '/documents'));

router.get(/^\/resume\/[A-Za-z0-9_.-]+\.pdf$/, (req, res) => {
  const doc = documents.listDocuments().find((d) => d.doc_role === 'resume');
  res.redirect(301, doc ? `/documents/${doc.slug}/download` : '/documents');
});


router.get('/about', (req, res, next) => {
  const page = repo.getPage('about');
  if (!page) return next();
  res.render('pages/page', {
    ...chrome(),
    title: page.title,
    description: page.subtitle || '',
    page,
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      trail: [{ name: 'Home', url: '/' }, { name: 'About', url: '/about' }],
    }),
    ogImage: registerOg({ title: page.title, subtitle: page.subtitle || '', eyebrow: 'Eric J. Dean' }),
  });
});


/* The one place the LinkedIn handle is written down. */
const LINKEDIN = {
  handle: process.env.LINKEDIN_USER || 'edean07',
  get url() { return `https://www.linkedin.com/in/${this.handle}`; },
};

/* ----------------------------------------------------------- professional
 *
 * GitHub and LinkedIn on one page, so a reviewer can read the repositories and
 * the professional record without leaving the site.
 *
 * GitHub is fetched server side and cached, so the visitor's browser never
 * talks to GitHub: no third party connection, no script exception to a CSP
 * that allows none, and a panel that is not empty for anyone running a
 * blocker. See src/github.js.
 *
 * LinkedIn cannot work the same way and does not pretend to. There is no
 * public profile API without a partnership, and a profile page cannot be
 * framed: LinkedIn serves X-Frame-Options DENY precisely to stop it. The two
 * honest options are a server rendered card built from the record the owner
 * already maintains here, which is the default, or LinkedIn's own badge
 * script, which is a real third party connection and is therefore a switch in
 * the admin rather than an assumption.
 */
router.get('/professional', (req, res) => {
  const cfg = settings.allSettings();
  const gh = github.snapshot({ live: cfg.github_live, topRepos: 8 });

  res.render('pages/professional', {
    ...chrome(),
    title: content.value('professional.meta.title'),
    description: content.value('professional.meta.description'),
    gh,
    settings: cfg,
    linkedin: LINKEDIN,
    schools: repo.listSchools(),
    stamp: contact.issueStamp(),
    errors: [],
    values: { name: '', email: '', subject: '', message: '' },
    sent: false,
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      trail: [{ name: 'Home', url: '/' }, { name: 'Professional', url: '/professional' }],
    }),
    ogImage: registerOg({
      title: 'Professional Profile',
      subtitle: `${gh.repos.length} public repositories, and how to get in touch.`,
      eyebrow: 'Eric J. Dean',
    }),
  });
});


/* ------------------------------------------------------------------ education */

router.get('/education', (req, res) => {
  /* Alphabetical unless asked otherwise. A GET form with a submit button, so
     the control works with no JavaScript, same as every other control here. */
  const sort = req.query.sort === 'term' ? 'term' : 'name';
  const schools = repo.listSchools().map((sch) => ({
    ...sch,
    groups: repo.coursesByStatus(sch.slug, sort),
    counts: repo.courseCounts(sch.slug),
    activities: repo.listActivities(sch.slug),
  }));

  const totals = schools.reduce((acc, sch) => {
    for (const k of ['completed', 'in-progress', 'planned', 'total']) acc[k] += sch.counts[k] || 0;
    return acc;
  }, { completed: 0, 'in-progress': 0, planned: 0, total: 0 });

  res.render('pages/education', {
    ...chrome(),
    title: content.value('education.meta.title'),
    description: content.value('education.meta.description'),
    schools,
    totals,
    sort,
    unattached: repo.listActivities(null),
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      trail: [{ name: 'Home', url: '/' }, { name: 'Education', url: '/education' }],
    }),
    ogImage: registerOg({
      title: 'Education',
      subtitle: `${totals.completed} classes completed, ${totals['in-progress']} in progress.`,
      eyebrow: 'Eric J. Dean',
    }),
  });
});

/* ------------------------------------------------------------------ personal */

router.get('/personal', (req, res) => {
  /*
   * One wall, undivided.
   *
   * Every photograph on it, in one collage, at the full width of the window.
   * There is no grouping and no section per subject: a wall split into
   * categories is a stack of short galleries, and it turns every upload into a
   * decision about which bucket a photograph belongs in. The only question here
   * is whether a photograph is on the wall, which is one switch in the admin.
   */
  const photos = repo.personalPhotos();

  res.render('pages/personal', {
    ...chrome(),
    title: content.value('personal.meta.title'),
    description: content.value('personal.meta.description'),
    ...collage.layout(photos),
    rowHeight: collage.rowHeight(photos.length),
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      trail: [{ name: 'Home', url: '/' }, { name: 'Personal', url: '/personal' }],
    }),
    ogImage: registerOg({
      title: 'Beyond the Bench',
      subtitle: 'Sport, travel, family, and the rest of it.',
      eyebrow: 'Eric J. Dean',
    }),
  });
});

/* ---------------------------------------------------------------- contact */

function contactView(res, extra) {
  return {
    ...chrome(),
    title: content.value('contact.meta.title'),
    description: content.value('contact.meta.description'),
    stamp: contact.issueStamp(),
    errors: [],
    values: { name: '', email: '', subject: '', message: '' },
    sent: false,
    ...extra,
  };
}

router.get('/contact', (req, res) => {
  res.render('pages/contact', contactView(res, {}));
});

router.post('/contact', express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
  const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
  const result = contact.validate(req.body || {}, ip);

  if (!result.ok) {
    // A honeypot hit is answered with the same page a real error gets, and
    // nothing is stored. Telling a bot precisely why it failed is free
    // tuning information.
    return res.status(400).render('pages/contact', contactView(res, {
      errors: result.errors,
      values: result.values,
      stamp: contact.issueStamp(),
    }));
  }

  /*
   * Stored first, forwarded second, and never the other way round.
   *
   * The inbox is the system of record. If the relay is down, misconfigured or
   * simply not set up yet, the message is already safe and the admin shows it
   * as unsent with a retry button. A form that mails and then stores loses the
   * message on exactly the failure it most needs to survive.
   */
  const id = contact.store(result.values, { ip, userAgent: req.get('user-agent') });
  contact.forward(id).catch(() => { /* recorded on the row */ });

  res.render('pages/contact', contactView(res, { sent: true }));
});

/* -------------------------------------------------------------- documents */

router.get('/documents', (req, res) => {
  const docs = documents.listDocuments();

  /*
   * The resume and the CV sit at the top, in that order, whatever their sort
   * key says. They are the two documents a reviewer came for, and burying them
   * in a library ordered by upload date is the one arrangement guaranteed to be
   * wrong. Everything else keeps its own order below.
   */
  const ROLE_RANK = { resume: 0, cv: 1 };
  const pinned = docs
    .filter((d) => d.doc_role === 'resume' || d.doc_role === 'cv')
    .sort((a, b) => ROLE_RANK[a.doc_role] - ROLE_RANK[b.doc_role]);
  const others = docs.filter((d) => !(d.doc_role in ROLE_RANK));

  res.render('pages/documents', {
    ...chrome(),
    title: content.value('documents.meta.title'),
    description: content.value('documents.meta.description'),
    docs,
    pinned,
    others,
    pdfViewer: settings.getSetting('pdf_viewer'),
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      trail: [{ name: 'Home', url: '/' }, { name: 'Documents', url: '/documents' }],
    }),
    ogImage: registerOg({
      title: 'Documents',
      subtitle: String(docs.length) + ' authored documents, searchable to the page.',
      eyebrow: 'Eric J. Dean',
    }),
  });
});

/*
 * A document, rendered in the browser rather than downloaded.
 *
 * /media serves every PDF as an attachment on purpose: a PDF is the one
 * accepted upload that cannot be re-encoded on the way in, so it is the
 * residual vector once every other control is in place. This route is the
 * deliberate exception, and it is narrowed rather than opened:
 *
 *   - only rows that are already in the document table, never an arbitrary key
 *   - a CSP of its own that permits nothing at all, so even a PDF carrying
 *     script has no origin to reach and no subresource to load
 *   - still nosniff, still same origin, and the operator can switch the whole
 *     inline path off from the admin
 */
router.get('/documents/:slug/view', (req, res, next) => {
  if (!settings.getSetting('pdf_viewer')) return next();
  const doc = documents.getDocument(req.params.slug);
  if (!doc) return next();

  const fs = require('node:fs');
  const path = require('node:path');
  const { UPLOAD_DIR } = require('../db');
  const abs = path.resolve(UPLOAD_DIR, doc.storage_key);
  const root = path.resolve(UPLOAD_DIR);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return next();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `inline; filename="${documents.slugify(doc.title)}.pdf"`);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

/*
 * The same PDF, as a download, named after the document rather than after its
 * storage key. /media serves it too, but a storage key is a random hex string:
 * a reviewer who downloads the resume should not end up with
 * a7cb5788cb9189b2d941431c9fc5b163.pdf in their downloads folder.
 */
router.get('/documents/:slug/download', (req, res, next) => {
  const doc = documents.getDocument(req.params.slug);
  if (!doc) return next();

  const fs = require('node:fs');
  const path = require('node:path');
  const { UPLOAD_DIR } = require('../db');
  const abs = path.resolve(UPLOAD_DIR, doc.storage_key);
  const root = path.resolve(UPLOAD_DIR);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return next();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${documents.slugify(doc.title)}.pdf"`);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

router.get('/documents/:slug', (req, res, next) => {
  const doc = documents.getDocument(req.params.slug);
  if (!doc) return next();
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.render('pages/document', {
    ...chrome(),
    title: doc.title,
    description: doc.description || `${doc.pages} page document.`,
    doc,
    q,
    hits: q ? documents.pageHits(doc.id, q, 12) : [],
    jsonLd: seo.jsonLd(res.locals.siteUrl, {
      trail: [{ name: 'Home', url: '/' }, { name: 'Documents', url: '/documents' }, { name: doc.title, url: '/documents/' + doc.slug }],
    }),
    ogImage: registerOg({ title: doc.title, subtitle: doc.description || '', eyebrow: 'Document' }),
  });
});

/* -------------------------------------------------------------------- log */

router.get('/log', (req, res) => {
  res.render('pages/log', {
    ...chrome(),
    title: content.value('log.meta.title'),
    description: content.value('log.meta.description'),
    notes: repo.listNotes(50),
  });
});

/* ------------------------------------------------------------------ theme */

/*
 * A real form POST, so the control works with JavaScript disabled and needs no
 * inline script. Redirects back to where it was pressed.
 */
router.post('/theme', express.urlencoded({ extended: false }), (req, res) => {
  setTheme(res, req.body && req.body.theme);
  res.redirect(303, safeBackPath(req.body && req.body.back));
});

/**
 * Open redirect guard for the "return to where you were" parameter.
 *
 * A bare startsWith('/') check is not enough: '//evil.com' and '/\evil.com'
 * are both protocol relative URLs that a browser will follow off site. Express
 * happens to normalise the first of those today, which is luck rather than a
 * guarantee, so the check is explicit here.
 */
function safeBackPath(raw) {
  if (typeof raw !== 'string') return '/';
  const v = raw.trim();
  if (!v.startsWith('/')) return '/';        // absolute or scheme-relative
  if (/^\/[/\\]/.test(v)) return '/';         // //host or /\host
  if (v.includes('..')) return '/';           // traversal
  if (/[\r\n]/.test(v)) return '/';           // header splitting
  if (v.length > 512) return '/';
  return v;
}

/* ------------------------------------------------------------- OG images */

/*
 * Rendered on demand and cached on disk. The key is a hash of the content, so
 * editing a title produces a new URL and the old card is never served stale by
 * a platform that cached it.
 */
router.get('/og/:key.png', async (req, res, next) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sharp = require('sharp');
  const { DATA_DIR } = require('../db');

  const key = String(req.params.key || '').replace(/[^a-f0-9]/g, '');
  if (key.length !== 16) return next();

  const dir = path.join(DATA_DIR, 'og');
  const file = path.join(dir, key + '.png');

  if (!fs.existsSync(file)) {
    const spec = ogSpecs.get(key);
    // An unknown key means the page that would have registered it has not been
    // rendered in this process. Fall back rather than 404, because a crawler
    // may hit the image before it ever hits the page.
    const svg = seo.ogSvg(spec || { title: 'Eric J. Dean', subtitle: 'Mechanical, electrical, controls, and software.' });
    fs.mkdirSync(dir, { recursive: true });
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(file, png);
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

/*
 * Content-addressed, so the map is a cache rather than state: a miss costs one
 * regeneration from the default, never a broken image.
 */
const ogSpecs = new Map();
function registerOg(spec) {
  const key = seo.ogKey(spec);
  if (!ogSpecs.has(key)) {
    ogSpecs.set(key, spec);
    // Bounded, because this is a cache and a long-running process should not
    // grow one entry per title edit forever.
    if (ogSpecs.size > 500) ogSpecs.delete(ogSpecs.keys().next().value);
  }
  return '/og/' + key + '.png';
}

/* ---------------------------------------------------- colophon and feeds */

const FONTS = [
  { name: 'TASA Orbiter', role: 'Display', file: 'TASA-Orbiter-OFL.txt',
    copyright: 'Copyright 2025 The TASA Typeface Collection Project Authors. Commissioned for the Taiwan Space Agency rebrand.',
    url: 'https://github.com/localremotetw/TASA-Typeface-Collection' },
  { name: 'Literata', role: 'Body', file: 'Literata-OFL.txt',
    copyright: 'Copyright 2017 The Literata Project Authors.',
    url: 'https://github.com/googlefonts/literata' },
  { name: 'Martian Mono', role: 'Data and code', file: 'Martian-Mono-OFL.txt',
    copyright: 'Copyright 2021 The Martian Mono Project Authors, Evil Martians.',
    url: 'https://github.com/evilmartians/mono' },
];

router.get('/attributions', (req, res) => {
  res.render('pages/attributions', {
    ...chrome(),
    title: content.value('attributions.meta.title'),
    description: content.value('attributions.meta.description'),
    fonts: FONTS,
  });
});

/* The OFL requires the notice travel with the fonts, so it is served as text. */
router.get('/licenses/:file', (req, res, next) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const allowed = new Set(FONTS.map((f) => f.file));
  if (!allowed.has(req.params.file)) return next();
  const abs = path.join(__dirname, '..', '..', 'licenses', req.params.file);
  if (!fs.existsSync(abs)) return next();
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(abs, 'utf8'));
});

/* A "now" page in Derek Sivers's sense. One field, editable in under a minute,
   and it is a large part of what stops the site reading as abandoned. */
router.get('/now', (req, res) => {
  res.render('pages/now', {
    ...chrome(),
    title: content.value('now.meta.title'),
    description: content.value('now.meta.description'),
    now: repo.getNow(),
    notes: repo.listNotes(5),
  });
});

/*
 * Atom, because it is the format with a real specification and unambiguous
 * date handling. JSON Feed alongside it from the same query, because it costs
 * twenty lines and some readers prefer it.
 */
function feedItems() {
  const notes = repo.listNotes(30).map((n) => ({
    id: `note-${n.id}`,
    url: `/log#${n.slug}`,
    title: n.title || `Log entry, ${n.created_at.slice(0, 10)}`,
    html: n.body_html,
    updated: n.created_at,
  }));
  const projects = repo.listProjects().slice(0, 20).map((p) => ({
    id: `project-${p.id}`,
    url: `/work/${p.slug}`,
    title: p.title,
    html: p.summary_html || `<p>${p.subtitle || ''}</p>`,
    updated: p.updated_at,
  }));
  return [...notes, ...projects]
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, 40);
}

const xmlEscape = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

router.get('/feed.xml', (req, res) => {
  const site = res.locals.siteUrl;
  const items = feedItems();
  const updated = items.length ? new Date(items[0].updated).toISOString() : new Date().toISOString();
  /* Built as an array of lines rather than concatenated template literals:
     an XML document is line oriented and this stays readable. */
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>Eric J. Dean</title>',
    '  <subtitle>Mechanical, electrical, controls, and software.</subtitle>',
    `  <link href="${xmlEscape(site)}/feed.xml" rel="self"/>`,
    `  <link href="${xmlEscape(site)}/"/>`,
    `  <id>${xmlEscape(site)}/</id>`,
    `  <updated>${updated}</updated>`,
    '  <author><name>Eric J. Dean</name></author>',
  ];

  for (const i of items) {
    lines.push(
      '  <entry>',
      `    <title>${xmlEscape(i.title)}</title>`,
      `    <link href="${xmlEscape(site + i.url)}"/>`,
      `    <id>${xmlEscape(site)}/${xmlEscape(i.id)}</id>`,
      `    <updated>${new Date(i.updated).toISOString()}</updated>`,
      `    <content type="html">${xmlEscape(i.html)}</content>`,
      '  </entry>'
    );
  }

  lines.push('</feed>', '');
  res.type('application/atom+xml; charset=utf-8').send(lines.join('\n'));
});

router.get('/feed.json', (req, res) => {
  const site = res.locals.siteUrl;
  res.type('application/feed+json').json({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Eric J. Dean',
    home_page_url: site + '/',
    feed_url: site + '/feed.json',
    authors: [{ name: 'Eric J. Dean', url: 'https://github.com/XrxcGH' }],
    items: feedItems().map((i) => ({
      id: site + '/' + i.id,
      url: site + i.url,
      title: i.title,
      content_html: i.html,
      date_modified: new Date(i.updated).toISOString(),
    })),
  });
});

/* ------------------------------------------------------------ machine bits */

router.get('/robots.txt', (req, res) => {
  const site = res.locals.siteUrl;
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Disallow: /admin',
      'Allow: /',
      '',
      // Deliberate: a portfolio wants to be found by answer engines.
      'User-agent: GPTBot',
      'Allow: /',
      '',
      'User-agent: ClaudeBot',
      'Allow: /',
      '',
      'User-agent: Google-Extended',
      'Allow: /',
      '',
      `Sitemap: ${site}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

router.get('/sitemap.xml', (req, res) => {
  const site = res.locals.siteUrl;
  const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const urls = [
    { loc: '/', pri: '1.0' },
    { loc: '/work', pri: '0.9' },
    { loc: '/disciplines', pri: '0.7' },
    { loc: '/log', pri: '0.5' },
    { loc: '/education', pri: '0.8' },
    { loc: '/professional', pri: '0.8' },
    { loc: '/contact', pri: '0.7' },
    { loc: '/documents', pri: '0.7' },
  ];
  /*
   * /personal is listed only when it has something on it. A sitemap entry for
   * an empty page is a promise to a crawler that the page does not keep, and
   * the empty state here is the normal state until photographs are uploaded.
   */
  if (repo.countOnWall() > 0) urls.push({ loc: '/personal', pri: '0.5' });
  for (const p of repo.listProjects()) urls.push({ loc: `/work/${p.slug}`, mod: p.updated_at, pri: '0.8' });
  for (const f of repo.listFacets('discipline')) urls.push({ loc: `/disciplines/${f.slug}`, pri: '0.6' });
  for (const d of documents.listDocuments()) urls.push({ loc: `/documents/${d.slug}`, mod: d.updated_at, pri: '0.6' });

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${esc(site + u.loc)}</loc>` +
          (u.mod ? `<lastmod>${esc(String(u.mod).slice(0, 10))}</lastmod>` : '') +
          `<priority>${u.pri}</priority></url>`
      )
      .join('\n') +
    `\n</urlset>\n`
  );
});

router.get('/.well-known/security.txt', (req, res) => {
  // Expires is mandatory under RFC 9116 and is computed, so it can never go stale.
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  res.type('text/plain').send(
    [
      `Contact: mailto:security@${new URL(res.locals.siteUrl).hostname}`,
      `Expires: ${expires}`,
      'Preferred-Languages: en',
      '',
    ].join('\n')
  );
});

/* Browsers request these at the root regardless of what <head> says. */
router.get(['/favicon.svg', '/favicon.ico'], (req, res) => {
  res.redirect(301, '/static/favicon.svg');
});

router.get('/healthz', (req, res) => {
  // Asserts the database answers, not merely that Node is up.
  try {
    const n = repo.listFacets('discipline').length;
    res.type('text/plain').send(`ok facets=${n}\n`);
  } catch (err) {
    res.status(503).type('text/plain').send('db unavailable\n');
  }
});

module.exports = router;
module.exports.safeBackPath = safeBackPath;
