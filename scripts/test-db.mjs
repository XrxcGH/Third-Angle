/*
 * Build the database the test suite runs against, somewhere that is not yours.
 *
 *   npm test          runs this first, via pretest
 *
 * The suite used to run against data/, the same directory the development
 * server and the real content live in. That is not a style problem. Tests
 * ingest documents, and tests/documents.test.mjs sets a document's visibility
 * to private to prove the public list honours it — against whichever row came
 * back first. Run the suite on a machine holding the real resume and the real
 * CV and it hides them from /documents and leaves its own fixtures behind.
 * That is precisely what happened, and the report was "the resume and CV are
 * missing and documents I did not approve got added".
 *
 * So the suite gets its own directory, rebuilt from the seeds each run. It is
 * disposable by construction: nothing in .test-data is content, and deleting
 * it costs a few seconds.
 */
import { rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, '.test-data');

rmSync(DIR, { recursive: true, force: true });
mkdirSync(path.join(DIR, 'uploads'), { recursive: true });

const env = { ...process.env, DATA_DIR: DIR, NODE_ENV: 'test' };
const run = (script) => execFileSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', script)],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

/* The same seeds a fresh clone runs, so the suite asserts against the content
   the project actually ships rather than a fixture set that can drift from it. */
for (const s of ['seed.js', 'seed-pages.js', 'seed-education.js']) run(s);

console.log('test database built in .test-data');
