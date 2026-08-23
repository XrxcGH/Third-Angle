/*
 * What the documents claim about this repository, checked against it.
 *
 *   npm run check:doc-facts
 *
 * A seven-way adversarial audit of the document set returned forty-seven
 * confirmed defects, and the majority of them were of one kind: a name written
 * down once and then quietly wrong. A `npm run` script that was renamed. A
 * systemd unit the provisioning script never installed. A file moved. A cross
 * reference to `DESIGN.md risk R5`, in three places, when the register runs R1
 * to R4, R6, and R8 to R13 and has never had an R5.
 *
 * None of that is careless writing. It is what happens to a proper noun the
 * moment anything is renamed, and the deploy runbook is the document most
 * damaged by it, because somebody follows it line by line on a machine they
 * have just built, and a command that does not exist reads as "this project is
 * broken" rather than "this sentence is stale".
 *
 * So every name a document uses is resolved here rather than trusted. A
 * reference that stops pointing at something fails the run and says where.
 *
 * Deliberately narrow. It checks things a script can resolve exactly: scripts,
 * paths, links, units, risk ids, counts. It says nothing about whether a
 * sentence is TRUE, which is the larger problem and not one a checker can help
 * with.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => existsSync(path.join(ROOT, p));

const DOCS = readdirSync(ROOT).filter((f) => f.endsWith('.md'));
const problems = [];
const fail = (doc, what) => problems.push(`${doc}: ${what}`);

/* Every fenced block is stripped for the prose checks and kept for the command
   checks, because a path inside a shell example is a real reference and a word
   inside prose backticks very often is not. */
const strip = (s) => s.replace(/```[\s\S]*?```/g, '');

const pkg = JSON.parse(read('package.json'));
const SCRIPTS = new Set(Object.keys(pkg.scripts || {}));

/* ---- 1. every `npm run X` names a script that exists ---- */
for (const doc of DOCS) {
  const body = read(doc);
  for (const m of body.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
    if (!SCRIPTS.has(m[1])) fail(doc, `npm run ${m[1]} is not a script in package.json`);
  }
}

/* ---- 2. every markdown link to a repo file resolves ---- */
for (const doc of DOCS) {
  for (const m of read(doc).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0].trim();
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    if (!has(target)) fail(doc, `link to ${target}, which does not exist`);
  }
}

/* ---- 3. every repo path named in backticks exists ----
   Only strings that are unambiguously a path in this repository: a known
   top-level directory and a slash, or a root document by name. A bare
   `app.css` is NOT one of them — it is how the design document refers to a
   file it has already located, and demanding the full path there would be the
   check dictating prose. Everything else in backticks is a command, a
   selector, an environment variable or a header, and is none of this
   check's business. */
const TOPS = ['src/', 'scripts/', 'tests/', 'deploy/', 'views/', 'public/', 'licenses/'];
const ROOT_DOCS = /^[A-Za-z0-9._-]+\.(md|yml|json)$/;
for (const doc of DOCS) {
  for (const m of read(doc).matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (t.includes(' ') || t.includes('*')) continue;
    const looksLikePath = TOPS.some((d) => t.startsWith(d))
      || (ROOT_DOCS.test(t) && !t.startsWith('.'));
    if (!looksLikePath) continue;
    if (!has(t)) fail(doc, `names ${t}, which does not exist`);
  }
}

/* ---- 4. every systemd unit named in a document is in deploy/ ---- */
const UNITS = new Set(readdirSync(path.join(ROOT, 'deploy'))
  .filter((f) => f.endsWith('.service') || f.endsWith('.timer')));
for (const doc of DOCS) {
  for (const m of strip(read(doc)).matchAll(/\b([a-z][a-z0-9-]*\.(?:service|timer))\b/g)) {
    /* Units the operating system or a package provides, not this repository. */
    if (['caddy.service', 'litestream.service', 'network-online.target',
      'timers.target', 'multi-user.target'].includes(m[1])) continue;
    if (!UNITS.has(m[1])) fail(doc, `names the unit ${m[1]}, which is not in deploy/`);
  }
}

/* ---- 5. every `risk RN` reference is in the register ---- */
const RISKS = new Set([...read('DESIGN.md').matchAll(/^\| (R\d+) /gm)].map((m) => m[1]));
const SOURCES = [...DOCS, 'costs.yml', 'server.js', 'src/routes/admin.js',
  'deploy/third-angle.service', 'deploy/backup.sh', 'deploy/restore-verify.sh',
  'deploy/provision.sh'].filter(has);
for (const f of SOURCES) {
  for (const m of read(f).matchAll(/[Rr]isk (R\d+)(?: and (R\d+))?/g)) {
    for (const id of [m[1], m[2]].filter(Boolean)) {
      if (!RISKS.has(id)) fail(f, `cites risk ${id}, which is not in the DESIGN.md register`);
    }
  }
}

/* ---- 6. the suite count in the README is the number of suites ---- */
const suites = readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs')).length;
const claimed = /(\d+) tests across (\d+) suites/.exec(read('README.md'));
if (!claimed) {
  fail('README.md', 'no longer states a test count in the form "N tests across M suites"');
} else if (Number(claimed[2]) !== suites) {
  fail('README.md', `claims ${claimed[2]} test suites, there are ${suites}`);
}

/* ---- report ---- */
if (problems.length) {
  console.error(`\n${problems.length} stale reference${problems.length === 1 ? '' : 's'}:\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('\nEach is a name a document uses that no longer resolves.\n');
  process.exit(1);
}
console.log(`OK, every name in ${DOCS.length} documents resolves. ${suites} test suites.`);
