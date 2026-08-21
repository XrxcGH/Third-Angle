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

/* 500. Errors are recorded in SQLite rather than sent to a paid SaaS. */
app.use((err, req, res, _next) => {
  console.error(err);
  repo.logError(req && req.path, err);
  res.status(500).render('pages/500', {
    title: 'Something broke',
    description: 'An error occurred.',
    disciplines: [],
    counts: {},
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
