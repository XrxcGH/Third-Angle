/*
 * Post-deploy smoke test. Every public page answers, every admin address stays
 * shut, and the headers that matter are actually on the response.
 *
 *   npm run smoke                        # against the dev server
 *   npm run smoke -- https://your-domain # against the real one
 *
 * Exits non-zero on the first thing that is wrong, so it can be the last line
 * of a deploy and mean something.
 *
 * This is not the test suite. The suite runs in process against a database it
 * controls; this runs over the wire against whatever is actually deployed, and
 * catches the class of failure the suite cannot see: a reverse proxy that did
 * not reload, a tunnel pointing at the wrong port, a TLS mode that strips a
 * header, an origin serving a stale build.
 */
const BASE = (process.argv[2] || process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');

/* [path, expected status, a string the body must contain] */
const PUBLIC = [
  ['/', 200, 'Eric'],
  ['/work', 200],
  ['/work?d=electrical', 200],
  ['/disciplines', 200],
  ['/education', 200],
  ['/professional', 200],
  ['/personal', 200],
  ['/documents', 200],
  ['/contact', 200],
  ['/now', 200],
  ['/attributions', 200],
  ['/search', 200],
  ['/search?q=swerve', 200],
  ['/feed.xml', 200, '<feed'],
  ['/feed.json', 200, 'jsonfeed.org'],
  ['/sitemap.xml', 200, '<urlset'],
  ['/robots.txt', 200, 'Sitemap:'],
  ['/.well-known/security.txt', 200, 'Contact:'],
  ['/healthz', 200, 'ok'],
  ['/og/default.png', 200],
  ['/no-such-page-here', 404],
];

/* Redirects that exist so an old or guessed address is not a dead end. */
const REDIRECTS = [['/log', '/now'], ['/feed', '/feed.xml'], ['/rss', '/feed.xml'],
  ['/rss.xml', '/feed.xml'], ['/atom.xml', '/feed.xml']];

/* Every one of these must send a signed-out visitor to the sign in screen and
   disclose nothing on the way. */
const ADMIN = ['/admin', '/admin/projects', '/admin/media', '/admin/documents',
  '/admin/settings', '/admin/messages', '/admin/education', '/admin/content',
  '/admin/notes', '/admin/photos', '/admin/facets', '/admin/account'];

const problems = [];
const bad = (what) => problems.push(what);

const get = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts });

for (const [p, status, contains] of PUBLIC) {
  let res;
  try { res = await get(p); } catch (e) { bad(`${p} did not answer: ${e.message}`); continue; }
  if (res.status !== status) { bad(`${p} answered ${res.status}, expected ${status}`); continue; }
  if (contains) {
    const body = await res.text();
    if (!body.includes(contains)) bad(`${p} answered ${status} but does not contain ${JSON.stringify(contains)}`);
  }
}

for (const [from, to] of REDIRECTS) {
  const res = await get(from);
  if (res.status !== 301) { bad(`${from} answered ${res.status}, expected a 301`); continue; }
  const loc = res.headers.get('location') || '';
  if (!loc.endsWith(to)) bad(`${from} redirects to ${loc}, expected ${to}`);
}

for (const p of ADMIN) {
  const res = await get(p);
  if (res.status !== 303 && res.status !== 302) {
    bad(`${p} answered ${res.status} to a signed-out visitor, expected a redirect to the sign in screen`);
    continue;
  }
  const loc = res.headers.get('location') || '';
  if (!loc.includes('/admin/login')) bad(`${p} redirects to ${loc}, expected /admin/login`);
  const body = await res.text();
  if (body.length > 512) bad(`${p} redirected but returned a ${body.length} byte body, which should be empty`);
}

/* Headers. Each of these has a way of going missing that nothing else notices:
   a proxy that rewrites, a cache rule that strips, an origin serving the wrong
   environment. */
const home = await get('/');
const header = (n) => home.headers.get(n) || '';

if (!/nosniff/.test(header('x-content-type-options'))) bad('X-Content-Type-Options is not nosniff');
if (!/DENY/i.test(header('x-frame-options'))) bad('X-Frame-Options is not DENY');
if (!/default-src 'self'/.test(header('content-security-policy'))) bad('the CSP is missing or does not start from self');
if (/unsafe-inline/.test(header('content-security-policy').replace(/style-src-attr[^;]*/, ''))) {
  bad("the CSP allows 'unsafe-inline' somewhere other than style-src-attr");
}
if (header('x-powered-by')) bad('X-Powered-By is being sent');

/* The cache scope that keeps one visitor's theme off another visitor's screen. */
if (!/private/.test(header('cache-control'))) {
  bad(`the home page says Cache-Control: ${header('cache-control') || '(nothing)'}, which lets a shared cache keep it`);
}
const asset = await get('/og/default.png');
if (!/immutable/.test(asset.headers.get('cache-control') || '')) {
  bad('a content addressed asset is not marked immutable, so the edge will not keep it');
}

if (BASE.startsWith('https://')) {
  if (!/max-age=\d+/.test(header('strict-transport-security'))) bad('HSTS is missing on an https origin');
}

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} at ${BASE}:\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('');
  process.exit(1);
}
console.log(`OK, ${BASE}: ${PUBLIC.length} public routes, ${REDIRECTS.length} redirects, ${ADMIN.length} admin addresses shut, headers intact.`);
