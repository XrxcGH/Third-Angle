'use strict';

/*
 * Media pipeline.
 *
 * The threat model is narrow, because the only uploader is the site owner, so
 * the realistic risk is not infection: it is a served file scripting against
 * the admin session, or a malformed file filling the volume. ClamAV was
 * considered and declined; it would be the largest process on a 12 GB box and
 * would not address either of those.
 *
 * What actually closes the risk:
 *   1. Magic byte sniffing against a strict allowlist, never the client's
 *      Content-Type and never the extension.
 *   2. SVG rejected outright. It is markup, not an image: it can carry script,
 *      and byte sniffing cannot detect it because it has no binary signature.
 *      Every generic sniffing library misses it for the same reason.
 *   3. Raster images re-encoded through sharp, which drops any payload hiding
 *      in metadata and normalises orientation.
 *   4. Everything served from a route that sets nosniff, and anything that is
 *      not a re-encoded image served as an attachment.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { run, get, all, nowIso, UPLOAD_DIR } = require('./db');

const MAX_BYTES = 25 * 1024 * 1024;

/*
 * Magic byte signatures. Hand rolled rather than pulled from a package,
 * because an allowlist that fails closed on anything unrecognised is exactly
 * what is wanted here, and a general purpose detector is a larger surface
 * that still cannot see SVG.
 */
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg',  test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png',  ext: 'png',  test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif',  ext: 'gif',  test: (b) => b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/avif', ext: 'avif', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /avif|avis/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'video/mp4',  ext: 'mp4',  test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /isom|mp4|avc1|iso2|M4V/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'model/gltf-binary', ext: 'glb', test: (b) => b.subarray(0, 4).toString('latin1') === 'glTF' },
];

const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/** Returns { mime, ext } or null. Null means reject: the allowlist fails closed. */
function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(buffer)) return { mime: sig.mime, ext: sig.ext };
    } catch { /* a short or odd buffer is simply not a match */ }
  }
  return null;
}

/** Cheap textual check so an SVG cannot arrive relabelled as something else. */
function looksLikeMarkup(buffer) {
  const head = buffer.subarray(0, 1024).toString('latin1').toLowerCase();
  return head.includes('<svg') || head.includes('<!doctype html') || head.includes('<html');
}

/* Five widths, not fifteen. The saved effort goes into correct sizes
   attributes and explicit dimensions, which is what a visitor actually feels. */
const WIDTHS = [640, 960, 1280, 1920, 2560];

function storageKey(ext) {
  return `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * Ingest one uploaded buffer. Throws with a message safe to show the admin.
 *
 * `origin` is load bearing rather than decorative: a project whose primary
 * discipline is mechanical or electrical cannot be published without at least
 * one media row marked 'original', so a downloaded vendor part is structurally
 * incapable of standing in as evidence.
 */
async function ingest({ buffer, originalName, kind, alt, caption, origin, capturedOn, releaseOk }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('That upload was empty.');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is ${(buffer.length / 1048576).toFixed(1)} MB. The limit is ${MAX_BYTES / 1048576} MB.`);
  }
  if (looksLikeMarkup(buffer)) {
    throw new Error('That looks like SVG or HTML. Markup is not accepted: it can carry script and no byte signature can detect it. Export a PNG instead.');
  }

  const type = sniff(buffer);
  if (!type) {
    throw new Error('That file type is not accepted. Allowed: JPEG, PNG, GIF, WebP, AVIF, PDF, MP4 and GLB.');
  }

  const isRaster = RASTER.has(type.mime);
  let width = null;
  let height = null;
  let finalBuffer = buffer;
  let finalMime = type.mime;
  let finalExt = type.ext;

  if (isRaster) {
    /*
     * Re-encode rather than store the original bytes. This is the step that
     * strips anything hiding in metadata, and autoOrient stops a phone photo
     * arriving sideways. limitInputPixels caps a decompression bomb.
     */
    const img = sharp(buffer, { limitInputPixels: 50_000_000, failOn: 'truncated' }).autoOrient();
    const meta = await img.metadata();
    width = meta.width || null;
    height = meta.height || null;
    finalBuffer = await img.clone().webp({ quality: 88 }).toBuffer();
    finalMime = 'image/webp';
    finalExt = 'webp';
  }

  const key = storageKey(finalExt);
  const dest = path.join(UPLOAD_DIR, key);
  ensureDir(dest);
  fs.writeFileSync(dest, finalBuffer);

  const res = run(
    `INSERT INTO media (kind, storage_key, original_name, mime, bytes, width, height,
                        alt, caption, origin, captured_on, release_ok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    kind || (isRaster ? 'photo' : type.mime === 'video/mp4' ? 'video' : 'other'),
    key, originalName || null, finalMime, finalBuffer.length, width, height,
    String(alt || '').trim(), String(caption || '').trim() || null,
    ['original', 'third-party', 'generated'].includes(origin) ? origin : 'original',
    capturedOn || null, releaseOk ? 1 : 0, nowIso()
  );
  const id = Number(res.lastInsertRowid);

  if (isRaster && width) await makeDerivatives(id, key, finalBuffer, width);
  return id;
}

/**
 * Responsive ladder. Only widths smaller than the source are produced, so a
 * 900px photo never gets upscaled into a fake 2560px file.
 */
async function makeDerivatives(mediaId, key, buffer, sourceWidth) {
  const base = key.replace(/\.[^.]+$/, '');
  for (const w of WIDTHS) {
    if (w > sourceWidth) continue;
    for (const [fmt, ext] of [['avif', 'avif'], ['webp', 'webp']]) {
      const out = path.join(UPLOAD_DIR, `${base}-${w}.${ext}`);
      ensureDir(out);
      const pipeline = sharp(buffer).resize({ width: w, withoutEnlargement: true });
      const data = fmt === 'avif'
        ? await pipeline.avif({ quality: 55 }).toBuffer()
        : await pipeline.webp({ quality: 82 }).toBuffer();
      fs.writeFileSync(out, data);
    }
  }
}

/** srcset for a stored image, newest format first. */
function srcset(media, format = 'avif') {
  if (!media || !media.width) return null;
  const base = media.storage_key.replace(/\.[^.]+$/, '');
  const parts = WIDTHS
    .filter((w) => w <= media.width)
    .map((w) => `/media/${base}-${w}.${format} ${w}w`);
  return parts.length ? parts.join(', ') : null;
}

function mediaUrl(media) {
  return `/media/${media.storage_key}`;
}

function listMedia(limit = 200) {
  return all('SELECT * FROM media ORDER BY id DESC LIMIT ?', limit);
}

function getMedia(id) {
  return get('SELECT * FROM media WHERE id = ?', id);
}

function deleteMedia(id) {
  const m = getMedia(id);
  if (!m) return false;
  const base = m.storage_key.replace(/\.[^.]+$/, '');
  // Remove the original plus every derivative rung.
  const candidates = [m.storage_key];
  for (const w of WIDTHS) for (const ext of ['avif', 'webp']) candidates.push(`${base}-${w}.${ext}`);
  for (const c of candidates) {
    const f = path.join(UPLOAD_DIR, c);
    try { if (fs.existsSync(f)) fs.rmSync(f); } catch { /* best effort */ }
  }
  run('DELETE FROM media WHERE id = ?', id);
  return true;
}

/**
 * The R2 publish gate. A project whose primary discipline is physical cannot
 * go live on a claim alone.
 */
function publishBlockers(projectId) {
  const p = get('SELECT tier, status FROM project WHERE id = ?', projectId);
  if (!p) return ['That project does not exist.'];

  const physical = all(
    `SELECT 1 FROM project_facet
      WHERE project_id = ? AND weight = 'primary'
        AND facet_slug IN ('mechanical', 'electrical', 'fabrication')`,
    projectId
  ).length > 0;

  // A specification is honestly a document, so it is exempt by design rather
  // than by oversight.
  if (!physical || p.status === 'specification') return [];

  const originals = get(
    `SELECT COUNT(*) AS n FROM project_media pm
       JOIN media m ON m.id = pm.media_id
      WHERE pm.project_id = ? AND m.origin = 'original'`,
    projectId
  ).n;

  const required = p.tier === 'case-study' ? 3 : p.tier === 'build' ? 2 : 1;
  if (originals < required) {
    return [
      `This project leads on physical work, so it needs at least ${required} piece${required === 1 ? '' : 's'} ` +
      `of your own photography or video before it can be published. It has ${originals}. ` +
      'A downloaded vendor part does not count, which is what the origin field is for.',
    ];
  }
  return [];
}

module.exports = {
  ingest, sniff, looksLikeMarkup, makeDerivatives, srcset, mediaUrl,
  listMedia, getMedia, deleteMedia, publishBlockers,
  WIDTHS, MAX_BYTES, SIGNATURES, RASTER,
};
