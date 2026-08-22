'use strict';

/*
 * GitHub, server side.
 *
 * The point of this file is that the profile page shows live repository data
 * without the visitor's browser ever talking to GitHub. A client-side widget
 * would mean a third party connection from every visit, a script exception to
 * a CSP that currently allows none, and a page that is empty for anyone with
 * an ad blocker. Fetching here costs one request an hour from the server.
 *
 * Three behaviours that matter more than the fetch itself:
 *
 *   1. Stale is served immediately and refreshed behind the request. A page
 *      must never wait on a third party API, because the one day GitHub is
 *      slow is the day the page a recruiter opened takes eight seconds.
 *   2. A failed refresh keeps the last good copy. The cache is the source of
 *      truth for rendering; the network only ever updates it.
 *   3. ETags. GitHub does not count a 304 against the rate limit, so an hourly
 *      poll of two endpoints costs effectively nothing even unauthenticated.
 */

const { get, run, nowIso } = require('./db');

const API = 'https://api.github.com';
const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 6000;

/* Unauthenticated is 60 requests an hour per address, which is ample at one
   refresh an hour. A token raises it to 5000 and is read from the environment
   if present, never from the database. */
function headers(etag, { anonymous = false } = {}) {
  const h = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub rejects a request with no User-Agent outright.
    'User-Agent': 'third-angle (https://github.com/XrxcGH/third-angle)',
  };
  if (!anonymous && process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (etag) h['If-None-Match'] = etag;
  return h;
}

const username = () => process.env.GITHUB_USER || 'XrxcGH';

function readCache(key) {
  const row = get('SELECT * FROM github_cache WHERE key = ?', key);
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { return null; }
  return {
    payload,
    etag: row.etag,
    fetchedAt: row.fetched_at,
    ageMs: Date.now() - new Date(row.fetched_at).getTime(),
    stale: Date.now() - new Date(row.fetched_at).getTime() > TTL_MS,
  };
}

function writeCache(key, { etag, payload, status }) {
  run(
    `INSERT INTO github_cache (key, etag, payload, status, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, payload = excluded.payload,
       status = excluded.status, fetched_at = excluded.fetched_at`,
    key, etag || null, JSON.stringify(payload), status, nowIso()
  );
}

/** Touch the cache timestamp without rewriting the payload, after a 304. */
function touchCache(key) {
  run('UPDATE github_cache SET fetched_at = ? WHERE key = ?', nowIso(), key);
}

async function attempt(url, etag, opts) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers: headers(etag, opts), signal: ac.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request, with one deliberate fallback.
 *
 * A public profile needs no credential at all. So an expired, revoked or
 * wrongly-scoped GITHUB_TOKEN answering 401 is not a reason for the page to
 * have no data: it is a reason to ask again without the token. Without this
 * the whole feature dies on a credential that was never required, and the only
 * symptom is an empty panel.
 */
async function fetchJson(url, etag) {
  let res = await attempt(url, etag);

  if ((res.status === 401 || res.status === 403) && process.env.GITHUB_TOKEN) {
    const anon = await attempt(url, etag, { anonymous: true });
    if (anon.ok || anon.status === 304) {
      tokenUnusable = `GITHUB_TOKEN was rejected (${res.status}). Public data is being read without it.`;
      res = anon;
    }
  }

  if (res.status === 304) return { notModified: true, status: 304 };
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    throw new Error(
      `GitHub answered ${res.status}${remaining === '0' ? ', rate limit exhausted' : ''} for ${url}`
    );
  }
  return { json: await res.json(), etag: res.headers.get('etag'), status: res.status };
}

/* Set when a configured token turns out to be unusable. Surfaced in the admin
   rather than thrown, because the page is working: it is the credential that
   is not. */
let tokenUnusable = null;

/* --------------------------------------------------------------- shaping */

/*
 * Only the fields the page renders are stored. A full GitHub user object is
 * about 40 fields of URLs, and keeping the rest would mean the cache row
 * silently carries data nobody chose to publish.
 */
function shapeProfile(u) {
  return {
    login: u.login,
    name: u.name || u.login,
    bio: u.bio || null,
    company: u.company || null,
    location: u.location || null,
    blog: u.blog || null,
    avatar: u.avatar_url || null,
    url: u.html_url,
    publicRepos: u.public_repos || 0,
    followers: u.followers || 0,
    following: u.following || 0,
    createdAt: u.created_at || null,
  };
}

function shapeRepo(r) {
  return {
    name: r.name,
    fullName: r.full_name,
    description: r.description || null,
    url: r.html_url,
    homepage: r.homepage || null,
    language: r.language || null,
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    topics: Array.isArray(r.topics) ? r.topics.slice(0, 6) : [],
    fork: Boolean(r.fork),
    archived: Boolean(r.archived),
    pushedAt: r.pushed_at || null,
    createdAt: r.created_at || null,
  };
}

/**
 * Rank for display.
 *
 * Stars first, then most recently pushed. Forks and archives sink rather than
 * disappear: a fork can be real work, and hiding it would be the page deciding
 * what counts on the owner's behalf.
 */
function rankRepos(repos) {
  return [...repos].sort((a, b) => {
    const penalty = (r) => (r.archived ? 2 : 0) + (r.fork ? 1 : 0);
    const p = penalty(a) - penalty(b);
    if (p !== 0) return p;
    if (b.stars !== a.stars) return b.stars - a.stars;
    return String(b.pushedAt || '').localeCompare(String(a.pushedAt || ''));
  });
}

/** Language totals across the visible repositories, biggest first. */
function languageMix(repos) {
  const counts = new Map();
  for (const r of repos) {
    if (!r.language) continue;
    counts.set(r.language, (counts.get(r.language) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, n]) => ({ language, count: n, share: Math.round((n / total) * 100) }));
}

/* -------------------------------------------------------------- refresh */

let inFlight = null;

/**
 * Fetch both endpoints and update the cache. Never throws: the caller is
 * usually a background task whose only job is to make the next read fresher.
 */
async function refresh() {
  if (inFlight) return inFlight;
  const user = username();

  inFlight = (async () => {
    const errors = [];
    tokenUnusable = null;

    for (const [key, url, shape] of [
      ['profile', `${API}/users/${encodeURIComponent(user)}`, (j) => shapeProfile(j)],
      ['repos', `${API}/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`,
        (j) => (Array.isArray(j) ? j.map(shapeRepo) : [])],
    ]) {
      try {
        const cached = readCache(key);
        const res = await fetchJson(url, cached && cached.etag);
        if (res.notModified) { touchCache(key); continue; }
        writeCache(key, { etag: res.etag, payload: shape(res.json), status: res.status });
      } catch (err) {
        errors.push(`${key}: ${err.message}`);
      }
    }

    if (tokenUnusable) errors.push(tokenUnusable);

    if (errors.length) {
      // Recorded, not thrown. The page renders from cache either way, and the
      // admin needs to be able to see why a refresh stopped working.
      run(
        `INSERT INTO github_cache (key, etag, payload, status, fetched_at) VALUES (?, NULL, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
        '_error', JSON.stringify({ errors }), nowIso()
      );
    } else {
      run("DELETE FROM github_cache WHERE key = '_error'");
    }
    return { ok: errors.length === 0, errors };
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/**
 * Everything the profile page needs, from cache.
 *
 * `live` off means never touch the network: the page renders the last copy, or
 * nothing at all on a first run, and says which.
 */
function snapshot({ live = true, topRepos = 6 } = {}) {
  const profile = readCache('profile');
  const repos = readCache('repos');
  const err = readCache('_error');

  const needsRefresh = live && (!profile || !repos || profile.stale || repos.stale);
  if (needsRefresh) {
    /*
     * Fire and forget. The current request is answered from whatever is in the
     * cache right now, including nothing; the next one gets the fresh copy.
     * A page must never wait on a third party API.
     */
    refresh().catch(() => { /* recorded in the cache row */ });
  }

  const list = repos ? rankRepos(repos.payload) : [];
  return {
    username: username(),
    profile: profile ? profile.payload : null,
    repos: list,
    top: list.slice(0, topRepos),
    languages: languageMix(list),
    totalStars: list.reduce((n, r) => n + r.stars, 0),
    fetchedAt: profile ? profile.fetchedAt : null,
    stale: Boolean(profile && profile.stale),
    refreshing: needsRefresh,
    errors: err ? (err.payload.errors || []) : [],
  };
}

/* ---------------------------------------------------------------- avatar
 *
 * The profile picture is fetched by this server and cached on disk, then
 * served from this origin.
 *
 * Hotlinking avatars.githubusercontent.com would mean adding a third party to
 * img-src, and it would tell GitHub the address of every visitor who opens the
 * page. One 56px square is not worth either.
 */

const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function avatarPath() {
  const path = require('node:path');
  const { DATA_DIR } = require('./db');
  return path.join(DATA_DIR, 'cache', 'github-avatar.bin');
}

/**
 * Returns { buffer, mime } or null. Never throws: the page renders without a
 * picture rather than failing.
 */
async function avatar() {
  const fs = require('node:fs');
  const file = avatarPath();

  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < AVATAR_TTL_MS) {
      return { buffer: fs.readFileSync(file), mime: 'image/png' };
    }
  } catch { /* not cached yet */ }

  const profile = readCache('profile');
  const url = profile && profile.payload && profile.payload.avatar;
  if (!url) return null;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    // size=112 is the 56px tile at 2x. Asking for the size actually rendered
    // rather than the 460px original is the whole saving.
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}s=112`, {
      headers: { 'User-Agent': headers()['User-Agent'] },
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;

    const raw = Buffer.from(await res.arrayBuffer());
    /*
     * Re-encoded through sharp on the way in, exactly like an upload. The bytes
     * come from a third party, so they get the same treatment as anything else
     * that arrives from outside: metadata dropped, format normalised, and a
     * decompression bomb capped.
     */
    const sharp = require('sharp');
    const png = await sharp(raw, { limitInputPixels: 20_000_000 })
      .resize(112, 112, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toBuffer();

    require('node:fs').mkdirSync(require('node:path').dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return { buffer: png, mime: 'image/png' };
  } catch {
    return null;
  }
}

module.exports = {
  refresh, snapshot, username, avatar, avatarPath,
  shapeProfile, shapeRepo, rankRepos, languageMix, readCache, TTL_MS,
};
