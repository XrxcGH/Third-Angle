/*
 * Every internal link on the site, followed.
 *
 *   npm run check:links                        # against the dev server
 *   npm run check:links -- https://your-domain # against the real one
 *
 * Crawls from the home page, follows every same-origin href and src it finds,
 * and reports anything that answers 400 or worse. A portfolio is read by people
 * who click things, and a dead link on it is the most visible kind of
 * carelessness there is.
 *
 * The admin is skipped: it answers with a redirect to the sign in screen by
 * design, and npm run smoke is what asserts that.
 *
 * External links are listed rather than followed. Following them from here
 * would make the check depend on somebody else's uptime and on this machine's
 * egress, and a failure would say nothing about this repository.
 */
const BASE = (process.argv[2] || process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');

const seen = new Set();
const queue = ['/'];
const broken = [];
const external = new Set();
const referrer = new Map();

while (queue.length) {
  const p = queue.shift();
  if (seen.has(p)) continue;
  seen.add(p);

  let res;
  try {
    res = await fetch(BASE + p, { redirect: 'manual' });
  } catch (e) {
    broken.push([p, `did not answer (${e.message})`, referrer.get(p)]);
    continue;
  }

  /* A redirect is a working link, and its target is crawled on its own. */
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (loc.startsWith('/') && !seen.has(loc)) { queue.push(loc); referrer.set(loc, p); }
    continue;
  }
  if (res.status >= 400) {
    broken.push([p, `answered ${res.status}`, referrer.get(p)]);
    continue;
  }

  const type = res.headers.get('content-type') || '';
  if (!type.includes('html')) continue;
  const html = await res.text();

  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      /* An absolute URL back to this site is not an external link. The
         canonical tag, og:url and both feeds are all written as absolute URLs
         from SITE_URL, and listing them as "external" buried the handful of
         links that really do leave the site. */
      if (raw.startsWith(BASE + '/') || raw === BASE) {
        const own = raw.slice(BASE.length).split('#')[0] || '/';
        if (!seen.has(own)) { queue.push(own); referrer.set(own, p); }
      } else {
        external.add(raw.split('#')[0]);
      }
      continue;
    }
    if (raw.startsWith('mailto:') || raw.startsWith('#') || raw.startsWith('data:')) continue;
    if (!raw.startsWith('/')) continue;
    if (raw.startsWith('/admin')) continue;
    const target = raw.split('#')[0];
    if (!target || seen.has(target)) continue;
    queue.push(target);
    if (!referrer.has(target)) referrer.set(target, p);
  }

  /* srcset entries are not quoted individually. */
  for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
    for (const part of m[1].split(',')) {
      const u = part.trim().split(/\s+/)[0];
      if (u && u.startsWith('/') && !seen.has(u)) { queue.push(u); referrer.set(u, p); }
    }
  }
}

if (broken.length) {
  console.error(`\n${broken.length} broken link${broken.length === 1 ? '' : 's'} at ${BASE}:\n`);
  for (const [p, why, from] of broken) {
    console.error(`  ${p} ${why}${from ? `  (linked from ${from})` : ''}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`OK, ${seen.size} internal URLs at ${BASE}, none broken.`);
console.log(`${external.size} external links referenced, not followed:`);
for (const u of [...external].sort()) console.log('  ' + u);
