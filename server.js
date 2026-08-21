'use strict';

require('node:fs').existsSync('.env') && loadDotEnv();

const path = require('node:path');
const express = require('express');

const db = require('./src/db');
const repo = require('./src/repo');
const mw = require('./src/middleware');

/* Tiny .env reader, so there is no dotenv dependency for three variables. */
function loadDotEnv() {
  const fs = require('node:fs');
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

db.assertEnvironment();
db.migrate();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const expressLayouts = require('express-ejs-layouts');
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(mw.securityHeaders);
app.use(mw.theme);
app.use(mw.locals);

app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '365d' : 0,
    immutable: process.env.NODE_ENV === 'production',
  })
);

app.use(mw.redirects);
app.use(require('./src/routes/media'));
app.use('/admin', require('./src/routes/admin'));
app.use(require('./src/routes/public'));

/* 404 */
app.use((req, res) => {
  res.status(404).render('pages/404', {
    title: 'Not found',
    description: 'That page does not exist.',
    disciplines: repo.listFacets('discipline'),
    counts: {},
  });
});

/*
 * 500. Errors are recorded in SQLite rather than sent to a paid SaaS.
 *
 * This handler must be self-sufficient. If the error was thrown INSIDE the
 * theme or locals middleware, res.locals was never populated, and the layout
 * dereferences theme, path and canonical. Rendering with the route's usual
 * assumptions makes the error handler throw a second time, at which point
 * Express falls through to its own final handler: the branded page never
 * appears, the security headers are replaced, and in development the raw
 * stack trace with absolute paths goes to the client.
 *
 * So: supply every local with a fallback, and pass a render callback so even a
 * template failure degrades to plain text rather than a second throw.
 */
app.use((err, req, res, _next) => {
  console.error(err);
  repo.logError(req && req.path, err);

  let disciplines = [];
  try { disciplines = repo.listFacets('discipline'); } catch { /* database may be the thing that broke */ }

  res.status(500).render('pages/500', {
    title: 'Something broke',
    description: 'An error occurred.',
    disciplines,
    counts: {},
    theme: (res.locals && res.locals.theme) || 'system',
    path: (req && req.path) || '/',
    query: {},
    siteUrl: (res.locals && res.locals.siteUrl) || '',
    canonical: (res.locals && res.locals.canonical) || '',
    year: new Date().getFullYear(),
  }, (renderErr, html) => {
    if (renderErr) {
      console.error('500 template also failed:', renderErr);
      return res.type('text/plain').send('Something broke on my end. Try again shortly.\n');
    }
    res.send(html);
  });
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
  console.log(`Third Angle listening on http://localhost:${PORT}`);
});

/*
 * SIGTERM drain. This is the whole of the deploy story: blue/green was
 * declined deliberately, because two processes against one SQLite file creates
 * a real two writer window. One to two seconds of restart, made invisible by
 * Caddy retry, is the correct trade for a portfolio. See DESIGN.md risk R6.
 */
function shutdown(signal) {
  return () => {
    console.log(`${signal} received, draining.`);
    server.close(() => {
      try { db.db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
}
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));

module.exports = app;
