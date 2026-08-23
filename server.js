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

app.use(mw.sameOrigin);
app.use(mw.securityHeaders);
/*
 * Before anything renders, and before express.static, because both of those
 * override it deliberately. The default it sets is the careful one: nothing
 * shared may keep this. See src/middleware.js.
 */
app.use(mw.cacheHeaders);
app.use(mw.theme);
app.use(mw.locals);

/*
 * The stylesheets, the fonts and the favicon.
 *
 * The headers are written here rather than left to `maxAge`, because `send`
 * only sets Cache-Control when the response does not already carry one, and
 * mw.cacheHeaders above always does. Left to itself that ordering silently
 * turned a year of edge caching on every font into revalidate-every-time, with
 * no error and no visible symptom except a slower site.
 */
const STATIC_MAX_AGE = process.env.NODE_ENV === 'production' ? 31536000 : 0;
app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => {
      mw.publicAsset(res, STATIC_MAX_AGE, STATIC_MAX_AGE > 0);
    },
  })
);

app.use(mw.redirects);
app.use(require('./src/routes/media'));
app.use('/admin', require('./src/routes/admin'));
app.use(require('./src/routes/public'));

/* 404 */
app.use((req, res) => {
  res.status(404).render('pages/404', {
    title: 'Not Found',
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
    /*
     * The content helpers explicitly, because res.locals may never have been
     * populated: if the failure happened in the middleware that sets them, the
     * 500 template would throw on c() and the reader would get the plain text
     * fallback instead of a page.
     */
    ...require('./src/content').helpers(),
    title: 'Something Broke',
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

/*
 * Only bind a port when this file is run directly.
 *
 * Requiring server.js used to start listening as a side effect, which meant
 * the app could not be imported by a test without fighting the dev server for
 * port 3000. Exporting the app and gating the listen is what makes the route
 * suite able to exercise the real middleware stack in process.
 */
function start(port = Number(process.env.PORT) || 3000) {
  const server = app.listen(port, () => {
    console.log(`Third Angle listening on http://localhost:${server.address().port}`);
  });

  /*
   * SIGTERM drain. This is the whole of the deploy story: blue/green was
   * declined deliberately, because two processes against one SQLite file
   * creates a real two writer window. One to two seconds of restart, made
   * invisible by Caddy retry, is the correct trade for a portfolio. See
   * DESIGN.md risk R6.
   */
  const shutdown = (signal) => () => {
    console.log(`${signal} received, draining.`);
    server.close(() => {
      try { db.db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    // If a connection refuses to close, do not hang the deploy forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  return server;
}

if (require.main === module) start();

module.exports = app;
module.exports.start = start;
