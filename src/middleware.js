'use strict';

const repo = require('./repo');

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

/* ---- security headers ---------------------------------------------------
 * Written out rather than pulled from a dependency so each line is a decision
 * someone made on purpose. Verify at securityheaders.com after deploy.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      // No inline script anywhere, which is why 'unsafe-inline' is absent
      // here and why no nonce is needed.
      "script-src 'self'",
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
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
    ].join('; ')
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
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

/* ---- view locals -------------------------------------------------------- */
function locals(req, res, next) {
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.siteUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.locals.canonical = res.locals.siteUrl + req.path;
  res.locals.title = null;
  res.locals.description = null;
  res.locals.year = new Date().getFullYear();
  next();
}

module.exports = { theme, setTheme, securityHeaders, redirects, locals, parseCookies };
