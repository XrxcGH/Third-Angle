/*
 * One HTML file containing every public page of the running site.
 *
 * `npm start` gives you a server, which is not something you can email to
 * somebody or open on a phone with no network. This walks the running site,
 * takes the HTML it actually produced, inlines the stylesheets, the three
 * fonts and every image as data URIs, and writes one file that opens anywhere
 * with no server behind it. A hash router swaps <main> so the navigation still
 * works.
 *
 * Nothing here re-designs or re-types anything: whatever the site renders is
 * what lands in the file. What cannot come is what needs the server, so search
 * and the contact form say so rather than failing silently.
 *
 *   npm start                    # in one terminal
 *   npm run preview              # in another; writes data/preview.html
 *   npm run preview -- out.html  # or somewhere else
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(ROOT, 'data', 'preview.html');

const text = async (p) => (await fetch(BASE + p)).text();

/* ---- which pages ---- */
const home = await text('/');
const links = new Set(['/', '/work', '/disciplines', '/education', '/professional',
  '/personal', '/documents', '/contact', '/search', '/now', '/resume', '/attributions']);
for (const html of [home, await text('/work'), await text('/disciplines'), await text('/documents')]) {
  for (const m of html.matchAll(/href="(\/(?:work|disciplines|documents)\/[a-z0-9-]+)"/g)) links.add(m[1]);
  /* The discipline filters are pages too: they have their own URL, their own
     order and their own emphasis, and a snapshot that dropped them would make
     every filter chip look broken. */
  for (const m of html.matchAll(/href="(\/work\?d=[a-z0-9-]+)"/g)) links.add(m[1]);
}
const ROUTES = [...links];

/* ---- assets ---- */
const MIME = { '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

const dataUri = async (url) => {
  const res = await fetch(BASE + url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(url.split('?')[0]).toLowerCase();
  const mime = MIME[ext] || res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
};

/* One stylesheet, in the order the layout loads them, with the fonts inlined. */
let css = '';
for (const f of ['fonts.css', 'tokens.css', 'app.css', 'icons.css', 'motion.css']) {
  css += `\n/* ===== ${f} ===== */\n` + await text('/static/css/' + f);
}
for (const m of [...css.matchAll(/url\((['"]?)((?:\/static)?\/fonts\/[^)'"]+)\1\)/g)]) {
  const uri = await dataUri(m[2]);
  if (uri) css = css.split(m[0]).join(`url(${uri})`);
}

/* ---- pull each page apart ---- */
const between = (html, open, close) => {
  const a = html.indexOf(open);
  if (a < 0) return '';
  const b = html.lastIndexOf(close);
  return html.slice(a + open.length, b);
};

const pages = [];
for (const route of ROUTES) {
  const html = await text(route);
  pages.push({
    route,
    title: (html.match(/<title>([^<]*)<\/title>/) || [, ''])[1],
    main: between(html, '<main id="main">', '</main>'),
  });
}
const shell = await text('/');
const header = '<header' + between(shell, '<header', '</header>') + '</header>';
const footer = '<footer' + between(shell, '<footer', '</footer>') + '</footer>';

/* ---- inline every image the pages reference ---- */
let bundle = header + footer + pages.map((p) => p.main).join('\n');
const srcs = new Set();
for (const m of bundle.matchAll(/(?:src|href)="(\/(?:media|og|static|avatar)\/[^"]+)"/g)) srcs.add(m[1]);
for (const m of bundle.matchAll(/srcset="([^"]+)"/g)) {
  for (const part of m[1].split(',')) {
    const u = part.trim().split(/\s+/)[0];
    if (u.startsWith('/')) srcs.add(u);
  }
}
const captured = new Set(ROUTES);
const uris = new Map();
for (const s of srcs) {
  if (/\.(css|js)$/.test(s)) continue;
  const uri = await dataUri(s);
  if (uri) uris.set(s, uri);
}

const inline = (html) => {
  let out = html;
  for (const [url, uri] of uris) out = out.split(`"${url}"`).join(`"${uri}"`);
  // srcset entries are not quoted individually
  out = out.replace(/srcset="([^"]+)"/g, (whole, list) => {
    const rebuilt = list.split(',').map((part) => {
      const [u, d] = part.trim().split(/\s+/);
      const uri = uris.get(u);
      return uri ? `${uri}${d ? ' ' + d : ''}` : null;
    });
    return rebuilt.every(Boolean) ? `srcset="${rebuilt.join(', ')}"` : '';
  });
  /*
   * An internal link becomes a route only if the snapshot actually holds that
   * page. Anything else — the admin, the feeds, the sitemap — is marked, and
   * the click handler says what it is. Rewriting them all meant every link the
   * snapshot could not answer silently went to the home page, which reads as a
   * broken site rather than as a missing page.
   */
  out = out.replace(/href="(\/[^"]*)"/g, (whole, href) => {
    if (/^\/(media|static|og)\//.test(href)) return whole;
    if (captured.has(href)) return `href="#${href}"`;
    return `href="#" data-offline="${href.replace(/"/g, '&quot;')}"`;
  });
  return out;
};

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');
const commit = readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim().startsWith('ref:')
  ? readFileSync(path.join(ROOT, '.git',
      readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim().slice(5)), 'utf8').trim().slice(0, 7)
  : 'unknown';

const doc = `<title>Third Angle Preview</title>
<style>
${css}

/* ===== the only thing this file adds to the site: a bar that says what it is
   and what does not work here. Site tokens, so it belongs to the page. ===== */
.snap-bar {
  position: sticky; top: 0; z-index: 60;
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-2) var(--s-4);
  padding: var(--s-2) var(--s-4);
  background: var(--sunken); border-bottom: 1px solid var(--hairline);
  font-family: var(--f-mono); font-size: .62rem; font-stretch: 80%;
  letter-spacing: .1em; text-transform: uppercase; color: var(--text-muted);
}
.snap-bar b { color: var(--text-strong); font-weight: var(--w-strong); }
.snap-bar .snap-note { text-transform: none; letter-spacing: .02em; font-size: .68rem; }
.site-header { top: 30px; }
.snap-dead { cursor: not-allowed; }
.snap-toast {
  position: fixed; left: 50%; bottom: var(--s-5); transform: translateX(-50%);
  background: var(--surface); color: var(--text-body);
  border: 1px solid var(--accent); border-radius: var(--r-control);
  padding: var(--s-3) var(--s-4); font-size: .9rem; z-index: 90;
  box-shadow: var(--lift-shadow);
}
</style>

<div class="snap-bar">
  <b>Third Angle</b>
  <span>Static snapshot &middot; ${built} UTC &middot; ${commit}</span>
  <span class="snap-note">Every public page, exactly as the server rendered it. Search, the contact form, and the admin need the running server.</span>
</div>

${inline(header)}
<main id="main"></main>
${inline(footer)}

<script id="pages" type="application/json">${JSON.stringify(
  pages.map((p) => ({ route: p.route, title: p.title, main: inline(p.main) }))
).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var PAGES = JSON.parse(document.getElementById('pages').textContent);
  var byRoute = {};
  PAGES.forEach(function (p) { byRoute[p.route] = p; });
  var main = document.getElementById('main');

  function render(route) {
    var page = byRoute[route] || byRoute['/'];
    main.innerHTML = page.main;
    document.title = page.title;
    document.querySelectorAll('.nav a').forEach(function (a) {
      var href = (a.getAttribute('href') || '').replace(/^#/, '');
      if (href && (href === page.route || (href !== '/' && page.route.indexOf(href + '/') === 0))) {
        a.setAttribute('aria-current', 'page');
      } else {
        a.removeAttribute('aria-current');
      }
    });
    window.scrollTo(0, 0);
    rendered = true;
  }

  var rendered = false;

  function go() {
    var hash = location.hash.replace(/^#/, '');
    /*
     * A hash that is not a path is an in-page anchor, not a route.
     *
     * Routes are written as #/work, #/documents and so on, so a bare
     * #repositories fell through byRoute, hit the fallback, and silently
     * replaced the page with the home page. Same page, scroll to the element.
     */
    if (hash && hash.charAt(0) !== '/') {
      if (!rendered) render('/');
      var target = document.getElementById(hash);
      if (target) target.scrollIntoView({ block: 'start' });
      return;
    }
    var route = hash || '/';
    if (rendered && document.startViewTransition
        && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(function () { render(route); });
    } else {
      render(route);
    }
  }

  addEventListener('hashchange', go);
  go();

  /* The theme control is a real form on the site. Here it is three buttons. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.theme-form button');
    if (!btn) return;
    e.preventDefault();
    var value = btn.value;
    if (value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', value);
    document.querySelectorAll('.theme-form button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.value === value));
    });
  });

  var toast;
  function say(message) {
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.className = 'snap-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function () { if (toast) { toast.remove(); toast = null; } }, 3200);
  }

  /* Anything that needs the server says so instead of doing nothing. */
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    say('This snapshot has no server, so search and the contact form are switched off here.');
  });

  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[data-offline]');
    if (!link) return;
    e.preventDefault();
    var target = link.getAttribute('data-offline');
    say(target.indexOf('/admin') === 0
      ? 'The admin needs the running server. It is not in this snapshot.'
      : target + ' needs the running server.');
  });
})();
</script>
`;

writeFileSync(OUT, doc);
console.log(OUT, (doc.length / 1024 / 1024).toFixed(2) + ' MB,', pages.length, 'pages,', uris.size, 'assets inlined');
