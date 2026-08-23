'use strict';

const repo = require('./repo');
const media = require('./media');

/* ---- theme --------------------------------------------------------------
 * Three states, not two: 'system' (no attribute, prefers-color-scheme decides),
 * 'light' and 'dark'. A two state toggle silently overrides the OS preference
 * forever, and a user who later changes their OS setting gets stranded.
 *
 * The preference is a cookie rather than localStorage specifically so the
 * server can read it on the FIRST request and emit <html data-theme="...">
 * in the initial HTML. localStorage plus a script guarantees a paint in the
 * wrong theme. There is no inline script here at all, which also means the
 * CSP needs no nonce.
 */
const THEMES = new Set(['light', 'dark', 'system']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    // decodeURIComponent throws on a lone '%', and a cookie is attacker
    // controlled, so an unguarded decode here 500s EVERY page for anyone
    // carrying a malformed cookie from any app on the same host.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function theme(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const raw = req.cookies.theme;
  res.locals.theme = THEMES.has(raw) ? raw : 'system';
  next();
}

function setTheme(res, value) {
  const v = THEMES.has(value) ? value : 'system';
  const oneYear = 60 * 60 * 24 * 365;
  // Not HttpOnly: a future progressive enhancement may want to read it.
  // No personal data, and exempt from consent as a user-preference cookie.
  res.setHeader(
    'Set-Cookie',
    `theme=${v}; Path=/; Max-Age=${oneYear}; SameSite=Lax${
      process.env.NODE_ENV === 'production' ? '; Secure' : ''
    }`
  );
}

/* ---- who is asking ------------------------------------------------------
 * Behind Cloudflare the socket's peer is Cloudflare, not the visitor, so
 * req.socket.remoteAddress is the same short list of addresses for everybody on
 * earth. Rate limiting on that number rate limits the whole internet as one
 * client: the first person to get the sign in form wrong locks out the next.
 *
 * CF-Connecting-IP carries the real address, and it is an ordinary request
 * header, which means anyone who can reach the origin directly can write
 * whatever they like in it. So it is read ONLY when the connection arrived from
 * a peer we put there ourselves: the tunnel or the reverse proxy, both of which
 * sit on loopback. A request that reaches the origin port from the open
 * internet falls back to the socket address, which cannot be forged.
 *
 * That ordering is the whole security property. Trusting the header
 * unconditionally would hand every attacker a free rate limit reset, one header
 * at a time.
 */
const LOOPBACK = /^(?:::1|(?:::ffff:)?127\.)/;
const PRIVATE = /^(?:::ffff:)?(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function fromTrustedPeer(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || '');
  return LOOPBACK.test(peer) || PRIVATE.test(peer);
}

function clientIp(req) {
  if (fromTrustedPeer(req)) {
    const cf = req.headers && req.headers['cf-connecting-ip'];
    /* One address, no list. CF-Connecting-IP is single valued by definition;
       anything with a comma in it did not come from Cloudflare. */
    if (typeof cf === 'string' && cf.trim() && !cf.includes(',')) return cf.trim();
  }
  return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

/* ---- caching ------------------------------------------------------------
 * Every HTML page on this site is personal to the person asking for it, and
 * not in the way that phrase usually means. The theme is a cookie the server
 * reads to emit <html data-theme="dark"> in the first byte, so a shared cache
 * holding one copy of the home page serves one visitor's theme to the next.
 * The admin pages are worse: they are rendered against a session.
 *
 * So HTML says `private`, which is the directive Cloudflare honours to mean
 * "your edge must not keep this", and the admin adds `no-store` on top. Vary
 * is there for the intermediaries that do read it; Cloudflare does not, which
 * is exactly why `private` and not Vary alone is doing the work.
 *
 * This costs nothing worth having. What makes the site fast at the edge is the
 * photographs, the fonts and the stylesheets, and those are content addressed
 * and immutable already. HTML is the small part.
 */
function cacheHeaders(req, res, next) {
  res.setHeader(
    'Cache-Control',
    req.path === '/admin' || req.path.startsWith('/admin/')
      ? 'private, no-store, max-age=0'
      : 'private, max-age=0, must-revalidate'
  );
  res.setHeader('Vary', 'Cookie');
  next();
}

/*
 * The other half of that policy, for the responses that are the same bytes for
 * everyone. Vary is REMOVED rather than left alone: it was set above as the
 * safe default, and leaving `Vary: Cookie` on a year long immutable photograph
 * splits the cache by cookie and quietly undoes the caching.
 */
function publicAsset(res, seconds, immutable = false) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}${immutable ? ', immutable' : ''}`);
  res.removeHeader('Vary');
}

/* ---- security headers ---------------------------------------------------
 * Written out rather than pulled from a dependency so each line is a decision
 * someone made on purpose. Verify at securityheaders.com after deploy.
 */
/*
 * LinkedIn's own profile badge is a script from platform.linkedin.com that
 * frames content from linkedin.com. It is off by default and switched on in the
 * admin, so the policy has to widen only when it is on, and only for those two
 * origins. Building the policy from a list rather than a template string is
 * what keeps that exception auditable: the difference between the two states is
 * three entries, and nothing else moves.
 */
const LINKEDIN_SCRIPT = 'https://platform.linkedin.com';
const LINKEDIN_FRAME = 'https://www.linkedin.com';

/* Whether the inline PDF reader is switched on. Same lazy require as the badge:
   middleware is loaded before the database is migrated on a cold start. */
function pdfViewerEnabled() {
  try {
    return require('./settings').getSetting('pdf_viewer');
  } catch {
    return false;
  }
}

function badgeEnabled() {
  try {
    // Required lazily: middleware.js is loaded before the database is migrated
    // on a cold start, and a settings read at module scope would run first.
    return require('./settings').getSetting('linkedin_badge');
  } catch {
    return false;
  }
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const badge = badgeEnabled();
  const pdfViewer = pdfViewerEnabled();
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  /*
   * HSTS, in production only. On http://localhost this header is ignored by
   * some browsers and cached by others, and a cached one makes local
   * development unreachable until the reader clears it by hand.
   *
   * No preload directive. Preloading is a one way door: removal takes months,
   * and it commits every future subdomain of the apex to HTTPS as well.
   */
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      // No executable inline script anywhere, which is why 'unsafe-inline' is
      // absent and no nonce is needed. The one inline block on the page is
      // application/ld+json, which CSP does not treat as executable script.
      `script-src 'self'${badge ? ` ${LINKEDIN_SCRIPT}` : ''}`,
      "script-src-attr 'none'",
      // style-src governs stylesheets and <style> elements. Inline style
      // ATTRIBUTES are governed by style-src-attr, which FALLS BACK to
      // style-src when it is not stated. Omitting it therefore blocks every
      // style="..." in the templates, and the page renders structurally
      // correct and visually broken, with nothing in the server log.
      // Allowing it only for attributes is a far smaller concession than
      // 'unsafe-inline' on style-src: a style attribute cannot pull in an
      // external resource or define a whole sheet.
      "style-src 'self'",
      "style-src-attr 'unsafe-inline'",
      // media.githubusercontent and avatars are proxied through /avatar, so
      // img-src stays 'self' whatever the badge setting is. The badge renders
      // its own picture inside its frame, which img-src does not govern.
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self'${badge ? ` ${LINKEDIN_SCRIPT}` : ''}`,
      /*
       * object-src governs the EMBEDDING page, not the embedded resource.
       *
       * The first version of this reasoned that the PDF response carries its
       * own restrictive policy so the page could keep object-src 'none'. That
       * is backwards: 'none' here blocks the <object> from loading at all, and
       * the only symptom is the viewer silently showing its fallback with a
       * console violation nobody reads. It opens to 'self' only while the
       * inline viewer is switched on, and the per-response policy on the PDF
       * itself stays as the second layer.
       */
      `object-src ${pdfViewer ? "'self'" : "'none'"}`,
      /*
       * frame-src, not only object-src. Chrome renders a PDF <object> through
       * its internal plugin viewer and checks frame-src as well, so allowing
       * object-src alone still refused to load it. Both are needed, and both
       * open only for what is switched on.
       */
      `frame-src ${[pdfViewer ? "'self'" : null, badge ? LINKEDIN_FRAME : null, badge ? LINKEDIN_SCRIPT : null]
        .filter(Boolean).join(' ') || "'none'"}`,
    ].join('; ')
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/* ---- cross-site writes --------------------------------------------------
 * The sign in form is the one form on the site that cannot carry a CSRF token.
 * A token is bound to a session and the whole point of sign in is that there is
 * not one yet, so POST /admin/login sits outside the check every other form
 * goes through.
 *
 * That is login CSRF, and it is a real attack even against a one-operator
 * admin: a page anywhere on the internet can silently submit this form with the
 * ATTACKER's credentials, and the operator carries on working, believing the
 * session is theirs, in an account that is not. Everything typed after that
 * point belongs to whoever owns those credentials.
 *
 * A token cannot fix it, so the request is judged by where it came from
 * instead. A browser attaches Origin to every cross-site POST and has done for
 * years, and Sec-Fetch-Site says the same thing in one word. A request that
 * announces it came from somewhere else is refused, whatever it is posting to.
 *
 * Absent headers are allowed through on purpose: curl, the test suite and every
 * other non-browser client send neither, and they are also not the thing this
 * defends against. What it defends against is a browser, and a browser tells
 * the truth here because the page doing the attacking cannot alter either
 * header.
 */
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const refuse = () => res.status(403).type('text/plain')
    .send('That form was submitted from another site.\n');

  /* 'none' is a typed address or a bookmark. 'same-origin' and 'same-site' are
     this site. Anything else is the attack. */
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return refuse();

  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    let host;
    try { host = new URL(origin).host; } catch { return refuse(); }
    if (host !== req.get('host')) return refuse();
  }
  return next();
}

/* ---- redirects ----------------------------------------------------------
 * So a URL can change without breaking a bookmark a recruiter kept.
 */
function redirects(req, res, next) {
  try {
    const hit = repo.findRedirect(req.path);
    if (hit) return res.redirect(hit.code, hit.to_path);
  } catch { /* table may not exist yet on a cold start */ }
  next();
}

/* ---- the operator's own bar ---------------------------------------------
 * A signed-in operator looking at the public site gets a thin bar above the
 * page with the way back to the admin in it.
 *
 * Without it, "View Site" is a one-way door: the admin bar is gone, and getting
 * back means scrolling to the footer, finding the sign in link, and landing on
 * a screen that is not the one you left. That is a small tax paid on every
 * single edit, which is the kind of tax that stops you making small edits.
 *
 * The session is read here rather than in every route. It costs one indexed
 * lookup on a page that is already rendering a database's worth of content, and
 * it is skipped entirely when there is no cookie, which is every request from
 * every visitor who is not the operator.
 *
 * Nothing here is secret: /admin is in robots.txt and discoverable regardless,
 * and the bar renders no data beyond the address already signed in. What it must
 * not do is reach a shared cache, and it cannot: every HTML response on this
 * site is already Cache-Control: private, Vary: Cookie, for the theme.
 */
function operatorBar(req, res, next) {
  res.locals.operator = null;
  const name = process.env.NODE_ENV === 'production' ? '__Host-session' : 'session';
  const id = req.cookies && req.cookies[name];
  if (!id) return next();
  try {
    const session = require('./auth').getSession(id);
    if (session) res.locals.operator = { email: session.email };
  } catch { /* a cold start before the session table exists is not an error here */ }
  return next();
}

/* ---- view locals -------------------------------------------------------- */
function locals(req, res, next) {
  /* EJS templates have no `require`, so anything a view needs has to arrive
     as a local. Passing the function rather than precomputed strings keeps the
     ladder logic in one place. */
  res.locals.srcset = media.srcset;
  /* One answer for how a stored enum reads. See src/labels.js. */
  res.locals.label = require('./labels').label;
  res.locals.titleCase = require('./labels').titleCase;
  /*
   * Bytes, in a unit that is not always MB. A 40 KB document rendered as
   * "0.0 MB" reads as a broken file rather than as a small one, and every page
   * that shows a size was hardcoding the megabyte divisor.
   */
  res.locals.fmtBytes = (n) => {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  };
  /*
   * The four content helpers. Every fixed string on the public site comes
   * through one of these, so nothing on a page is a literal that would need a
   * deploy to change. See src/content.js.
   */
  Object.assign(res.locals, require('./content').helpers());
  /*
   * Every date and time on the site reads in Pacific time, because that is
   * where the work happens and where the reader of a build log entry assumes
   * "yesterday" was measured from. Stored values stay UTC ISO strings; this is
   * a display concern and lives at the display boundary.
   *
   * A date-only string (2026-08-22) is formatted as a plain date rather than
   * being parsed as UTC midnight and shifted back a day, which is the classic
   * off-by-one that makes a log entry appear to have been written before it
   * was.
   */
  const PACIFIC = 'America/Los_Angeles';
  res.locals.fmtDate = (value) => {
    const raw = String(value || '');
    if (!raw) return '';
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const d = new Date(dateOnly ? `${raw}T12:00:00Z` : raw);
    if (Number.isNaN(d.getTime())) return raw;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  };
  res.locals.fmtWhen = (value) => {
    const d = new Date(String(value || ''));
    if (Number.isNaN(d.getTime())) return String(value || '');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.siteUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.locals.canonical = res.locals.siteUrl + req.path;
  res.locals.title = null;
  res.locals.description = null;
  res.locals.year = new Date().getFullYear();
  next();
}

module.exports = {
  theme, setTheme, securityHeaders, redirects, locals, parseCookies,
  cacheHeaders, publicAsset, clientIp, sameOrigin, operatorBar,
};
