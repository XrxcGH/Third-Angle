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
