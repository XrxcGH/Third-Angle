/*
 * Scope guard. Risk R1, the highest severity risk on this project.
 *
 * The failure mode being guarded against is specific and documented: a 22,778
 * line library specification with zero lines of Java, and a 1,375 line manual
 * for a game that does not exist. Writing is not the problem. Writing INSTEAD
 * of shipping is.
 *
 * So: count words of prose against lines of code, and fail the build when the
 * ratio climbs. This does not stop you documenting. It stops documentation
 * outrunning the thing it documents.
 *
 *   npm run check:scope
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const MAX_RATIO = 1.5;          // words of prose per line of code
const IGNORE_DIRS = new Set(['node_modules', '.git', 'data', 'public/fonts']);
// README and docs are exempt: a portfolio SHOULD explain itself to a reader.
// The guard is aimed at design documents that grow instead of code.
const EXEMPT_PROSE = new Set(['README.md']);
const EXEMPT_DIRS = ['docs'];

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ejs', '.css', '.sql']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (IGNORE_DIRS.has(entry) || IGNORE_DIRS.has(rel)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else out.push({ abs, rel });
  }
  return out;
}

const files = walk(ROOT);

let codeLines = 0;
let proseWords = 0;
const proseFiles = [];

for (const f of files) {
  const ext = path.extname(f.rel);

  if (CODE_EXT.has(ext)) {
    const text = readFileSync(f.abs, 'utf8');
    codeLines += text.split('\n').filter((l) => l.trim().length > 0).length;
    continue;
  }

  if (ext === '.md') {
    if (EXEMPT_PROSE.has(f.rel)) continue;
    if (EXEMPT_DIRS.some((d) => f.rel.startsWith(`${d}/`))) continue;
    const text = readFileSync(f.abs, 'utf8');
    const words = text.split(/\s+/).filter(Boolean).length;
    proseWords += words;
    proseFiles.push({ rel: f.rel, words });
  }
}

const ratio = codeLines === 0 ? Infinity : proseWords / codeLines;

console.log('Scope guard');
console.log(`  code      ${String(codeLines).padStart(7)} non-blank lines`);
console.log(`  prose     ${String(proseWords).padStart(7)} words (excluding README.md and docs/)`);
console.log(`  ratio     ${ratio.toFixed(2).padStart(7)} words per line  (limit ${MAX_RATIO.toFixed(2)})`);

if (proseFiles.length) {
  console.log('\n  counted prose:');
  for (const p of proseFiles.sort((a, b) => b.words - a.words)) {
    console.log(`    ${String(p.words).padStart(6)}  ${p.rel}`);
  }
}

if (ratio > MAX_RATIO) {
  console.error(
    `\nFAIL: prose is outrunning code at ${ratio.toFixed(2)} words per line.\n` +
    'Write the code, or move the document into docs/ and accept it is not part of this project.'
  );
  process.exit(1);
}

console.log('\nOK');
