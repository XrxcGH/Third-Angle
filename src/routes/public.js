'use strict';

const express = require('express');
const repo = require('../repo');
const { setTheme } = require('../middleware');

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
    title: 'Eric J. Dean',
    description:
      'Mechanical design, electrical, controls, software, fabrication, documentation and business. ' +
      'One engineer, several projections.',
    projects,
    featured: projects.filter((p) => p.featured).slice(0, 3),
    now: repo.getNow(),
    notes: repo.listNotes(3),
  });
});

/* ------------------------------------------------------------------- work */

router.get('/work', (req, res) => {
  const active = typeof req.query.d === 'string' ? req.query.d : null;
  const projects = repo.listProjects();

  /*
   * Note that non-matching projects are NOT removed. They are marked and then
   * de-emphasised in CSS, so the page does not reflow, the breadth claim stays
   * visible, and the filter is linkable and indexable because it lives in the
   * query string rather than in client state.
   */
  const decorated = projects.map((p) => ({
    ...p,
    match: !active || p.facetSlugs.includes(active),
  }));
  const matchCount = decorated.filter((p) => p.match).length;

  res.render('pages/work', {
    ...chrome(),
    title: 'Work',
    description: 'Projects across mechanical, electrical, controls, software, fabrication, documentation and business.',
    projects: decorated,
    active,
    matchCount,
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
  });
});

/* ------------------------------------------------------------ disciplines */

router.get('/disciplines', (req, res) => {
  res.render('pages/disciplines', {
    ...chrome(),
    title: 'Disciplines',
    description: 'Eight disciplines, each with the work that proves it.',
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
  });
});

/* ----------------------------------------------------------------- search */

router.get('/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
  const { results, fallback } = q ? repo.search(q) : { results: [], fallback: null };
  res.render('pages/search', {
    ...chrome(),
    title: q ? `Search: ${q}` : 'Search',
    description: 'Search projects, documents and disciplines.',
    q, results, fallback,
  });
});

/* -------------------------------------------------------------------- log */

router.get('/log', (req, res) => {
  res.render('pages/log', {
    ...chrome(),
    title: 'Build log',
    description: 'Short dated entries from work in progress.',
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
    title: 'Attributions',
    description: 'Typefaces, software, privacy and method for this site.',
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
    title: 'Now',
    description: 'What Eric Dean is working on at the moment.',
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
    '  <subtitle>Mechanical, electrical, controls and software.</subtitle>',
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
  ];
  for (const p of repo.listProjects()) urls.push({ loc: `/work/${p.slug}`, mod: p.updated_at, pri: '0.8' });
  for (const f of repo.listFacets('discipline')) urls.push({ loc: `/disciplines/${f.slug}`, pri: '0.6' });

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
