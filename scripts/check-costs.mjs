/*
 * Cost staleness gate. Risk R9.
 *
 * Prices age invisibly when they live in prose. This turns "the numbers are
 * out of date" from an embarrassment in front of a reader into a red build,
 * which is a thing you already respond to.
 *
 * Deliberately hand rolled rather than pulling a YAML parser: the file shape
 * is fixed and known, and a dependency added to check a dependency-free
 * project is a poor trade.
 *
 *   npm run check:costs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RAW = readFileSync(path.join(ROOT, 'costs.yml'), 'utf8');

const WINDOW_DAYS = 180;
const VOLATILE_WINDOW_DAYS = 90;

/* Split on list items, then pull the scalar fields we care about. */
const blocks = RAW.split(/\n\s*-\s+name:/).slice(1);

const items = blocks.map((b) => {
  const field = (k) => {
    const m = new RegExp(`^\\s*${k}:\\s*(.+?)\\s*$`, 'm').exec(b);
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  };
  return {
    name: b.split('\n')[0].trim(),
    vendor: field('vendor'),
    amount: field('amount_usd'),
    source: field('source_url'),
    verified: field('verified_on'),
    volatile: field('volatile') === 'true',
    evidence: /^\s*evidence:\s*(.+?)\s*$/m.exec(b)?.[1] ?? null,
  };
});

if (!items.length) {
  console.error('FAIL: costs.yml parsed to zero items. Has the file shape changed?');
  process.exit(1);
}

const today = new Date();
const problems = [];

console.log(`Cost check, ${items.length} items, today ${today.toISOString().slice(0, 10)}\n`);

for (const it of items) {
  const limit = it.volatile ? VOLATILE_WINDOW_DAYS : WINDOW_DAYS;

  if (!it.verified) { problems.push(`${it.name}: no verified_on date`); continue; }
  if (!it.source) problems.push(`${it.name}: no source_url`);
  // The evidence field is what stops a number being "remembered" rather than read.
  if (!it.evidence) problems.push(`${it.name}: no evidence string quoted from the vendor page`);

  const age = Math.floor((today - new Date(it.verified)) / 86_400_000);
  const stale = age > limit;
  if (stale) problems.push(`${it.name}: verified ${age} days ago, limit ${limit}`);

  console.log(
    `  ${stale ? 'STALE' : 'ok   '}  ` +
    `$${String(it.amount ?? '?').padStart(7)}/yr  ` +
    `${String(age).padStart(4)}d  ` +
    `${it.volatile ? 'volatile' : 'stable  '}  ${it.name}`
  );
}

if (problems.length) {
  console.error('\nFAIL:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nRe-read each vendor page, update amount_usd, evidence and verified_on.');
  process.exit(1);
}

console.log('\nOK, every price is current and sourced.');
