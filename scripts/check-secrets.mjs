/*
 * Nothing private in a public repository, and nothing private in its history.
 *
 *   npm run check:secrets
 *
 * The repository is public, so this is not a hypothetical. A key committed once
 * and deleted in the next commit is still in the history, still fetchable, and
 * still burned. So the working tree is not what is scanned: every blob that has
 * ever been committed is.
 *
 * The personal patterns are here because the resume and the CV are on this
 * site as PDFs and their SOURCE documents carry a phone number, a student
 * number, a date of birth and a home address. None of those belong in a
 * repository, and the way they arrive is somebody pasting a paragraph out of
 * the CV into a seed script.
 *
 * The pattern list is deliberately short. A scanner that cries wolf gets
 * switched off, and a scanner that is switched off finds nothing at all.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const CREDENTIALS = [
  ['an AWS or R2 access key id', String.raw`AKIA[0-9A-Z]{16}`],
  ['a GitHub personal access token', String.raw`gh[pousr]_[A-Za-z0-9]{30,}`],
  ['a fine-grained GitHub token', String.raw`github_pat_[A-Za-z0-9_]{30,}`],
  ['a Slack token', String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`],
  ['a private key block', String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`],
  ['a Cloudflare tunnel credential', String.raw`"TunnelSecret"\s*:`],
];

const PERSONAL = [
  ['a phone number', String.raw`\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b`],
  ['a student number', String.raw`\b60663629\d\b`],
  ['a date of birth', String.raw`\b(?:11/19/2007|2007-11-19)\b`],
  ['a street address', String.raw`\b\d{2,5} [A-Z][a-z]+ (?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Blvd)\b`],
];

/* Amazon publishes these in the SigV4 documentation as worked examples, and the
   signing tests are built from them. They are not credentials. */
const ALLOWED = [/AKIAIOSFODNN7EXAMPLE/, /wJalrXUtnFEMI\/K7MDENG/];

const problems = [];

/*
 * git grep exits 1 when it finds nothing and 2 or more when the pattern or the
 * invocation is wrong. Those must not be treated the same way: an earlier
 * version caught everything and printed OK while three of the six patterns had
 * never run at all, which is the worst possible outcome for a check like this.
 *
 * -P, because these patterns use \d, \b and (?:...), none of which POSIX
 * extended regular expressions have. -e, because a pattern that begins with a
 * dash is otherwise read as an option.
 */
function grep(pattern, revs = []) {
  try {
    return execFileSync('git', ['grep', '-I', '-n', '-P', '-e', pattern, ...revs, '--'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw new Error(`git grep failed for /${pattern}/: ${String(err.stderr || err.message).trim()}`);
  }
}

/* The working tree first, because that is the one somebody can still fix
   without rewriting history. */
for (const [what, pattern] of [...CREDENTIALS, ...PERSONAL]) {
  for (const line of grep(pattern)) {
    if (ALLOWED.some((a) => a.test(line))) continue;
    problems.push(`tracked: ${what} in ${line.slice(0, 160)}`);
  }
}

/* Then everything that has ever been committed. A key deleted in the next
   commit is still fetchable and still burned. */
const revs = execFileSync('git', ['rev-list', '--all'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);
for (const [what, pattern] of [...CREDENTIALS, ...PERSONAL]) {
  for (const line of grep(pattern, revs)) {
    if (ALLOWED.some((a) => a.test(line))) continue;
    /* Once per file and pattern, however many commits carry it. */
    const [, file] = /^[0-9a-f]{7,40}:([^:]+):/.exec(line) || [];
    const key = `history: ${what} in ${file}`;
    if (!problems.includes(key)) problems.push(key);
  }
}

/* An .env is never committed, and neither is the database. */
for (const p of ['.env', 'data/third-angle.db']) {
  try {
    if (git('ls-files', '--', p).trim()) problems.push(`tracked: ${p} is committed and must not be`);
  } catch { /* not tracked, which is the point */ }
}

if (problems.length) {
  console.error(`\n${problems.length} thing${problems.length === 1 ? '' : 's'} that should not be in a public repository:\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('\nAnything in the history is already burned: rotate it, do not just delete it.\n');
  process.exit(1);
}
console.log(`OK, nothing private in the working tree or in ${revs.length} commits of history.`);
