/*
 * Media pipeline. The allowlist must fail CLOSED: anything not positively
 * recognised is rejected, rather than anything known-bad being blocked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const media = require('../src/media.js');
const sharp = require('sharp');

const png = await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#E06D00' } }).png().toBuffer();
const jpg = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#123456' } }).jpeg().toBuffer();
const webp = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#123456' } }).webp().toBuffer();
const pad = (b) => Buffer.concat([b, Buffer.alloc(64)]);

test('recognises every allowed type by its magic bytes', () => {
  assert.equal(media.sniff(png).mime, 'image/png');
  assert.equal(media.sniff(jpg).mime, 'image/jpeg');
  assert.equal(media.sniff(webp).mime, 'image/webp');
  assert.equal(media.sniff(pad(Buffer.from('%PDF-1.7\n'))).mime, 'application/pdf');
  assert.equal(media.sniff(pad(Buffer.from('glTF'))).mime, 'model/gltf-binary');
  assert.equal(media.sniff(pad(Buffer.from('GIF89a'))).mime, 'image/gif');
});

test('the allowlist fails closed on anything unrecognised', () => {
  for (const b of [
    Buffer.alloc(64, 0x41),
    Buffer.from('MZ' + '\0'.repeat(80)),          // Windows executable
    Buffer.from('#!/bin/sh\necho hi' + ' '.repeat(64)),
    Buffer.from('PK\x03\x04' + '\0'.repeat(80)),   // zip, docx, jar
    Buffer.alloc(4),                                // too short
    Buffer.alloc(0),
  ]) {
    assert.equal(media.sniff(b), null, `accepted something it should not: ${b.subarray(0, 8).toString('latin1')}`);
  }
});

test('SVG and HTML are caught by the markup check, not by sniffing', () => {
  // This is the gap in every generic detector: SVG is text and has no binary
  // signature, so byte sniffing cannot see it at all. It can carry script.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + ' '.repeat(200));
  const html = Buffer.from('<!DOCTYPE html><html><body>x</body></html>' + ' '.repeat(200));
  assert.equal(media.sniff(svg), null);
  assert.equal(media.sniff(html), null);
  assert.equal(media.looksLikeMarkup(svg), true);
  assert.equal(media.looksLikeMarkup(html), true);
  assert.equal(media.looksLikeMarkup(png), false);
});

test('ingest rejects markup, junk and empty uploads with a usable message', async () => {
  const cases = [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>' + ' '.repeat(200)), /markup|SVG/i],
    [Buffer.alloc(64, 0x41), /not accepted/i],
    [Buffer.alloc(0), /empty/i],
  ];
  for (const [buf, pattern] of cases) {
    await assert.rejects(
      () => media.ingest({ buffer: buf, originalName: 'x', alt: 'x' }),
      (err) => pattern.test(err.message),
      `did not reject with a matching message: ${buf.length} bytes`
    );
  }
});

test('ingest re-encodes rasters, which is what strips a metadata payload', async () => {
  const id = await media.ingest({ buffer: png, originalName: 't.png', alt: 'test', origin: 'generated' });
  const rec = media.getMedia(id);
  try {
    assert.equal(rec.mime, 'image/webp', 'PNG was not re-encoded');
    assert.equal(rec.width, 1400);
    assert.equal(rec.height, 900);
    assert.equal(rec.origin, 'generated');
    assert.ok(rec.storage_key.endsWith('.webp'));
    // Random storage key, so a guessed URL cannot enumerate uploads.
    assert.match(rec.storage_key, /^\d{4}-\d{2}\/[0-9a-f]{32}\.webp$/);
  } finally {
    media.deleteMedia(id);
  }
});

test('the derivative ladder never upscales past the source width', async () => {
  const id = await media.ingest({ buffer: png, originalName: 't.png', alt: 'test' });
  const rec = media.getMedia(id);
  try {
    const set = media.srcset(rec, 'avif');
    assert.ok(set.includes('640w') && set.includes('1280w'), 'missing expected rungs');
    // Source is 1400 wide, so 1920 and 2560 must not be offered.
    assert.ok(!set.includes('1920w'), 'upscaled to 1920');
    assert.ok(!set.includes('2560w'), 'upscaled to 2560');
  } finally {
    media.deleteMedia(id);
  }
});

test('deleting media removes every derivative, not just the original', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { UPLOAD_DIR } = require('../src/db.js');
  const id = await media.ingest({ buffer: png, originalName: 't.png', alt: 'test' });
  const rec = media.getMedia(id);
  const dir = path.join(UPLOAD_DIR, path.dirname(rec.storage_key));

  // Count only this item's files. The directory is shared by month, so a
  // whole-directory count would be testing whatever else happens to be there.
  const stem = path.basename(rec.storage_key).replace(/\.[^.]+$/, '');
  const mine = () => fs.readdirSync(dir).filter((f) => f.startsWith(stem));

  const before = mine();
  assert.ok(before.length >= 5, `expected original plus derivatives, found ${before.length}`);

  media.deleteMedia(id);

  assert.deepEqual(mine(), [], 'derivatives were orphaned on disk');
  assert.equal(media.getMedia(id), undefined);
});

test('the publish gate counts only original media on physical projects', () => {
  const db = require('../src/db.js');
  const p = db.get("SELECT id FROM project WHERE slug = 'frc-electrical-curriculum'");
  if (!p) return;
  // Electrical is a primary discipline here and it has no media, so publishing
  // must be blocked. A downloaded vendor part could never satisfy this,
  // because origin is a CHECK-constrained column rather than a label.
  const blockers = media.publishBlockers(p.id);
  assert.equal(blockers.length, 1, 'physical project with no evidence was not blocked');
  assert.match(blockers[0], /photography or video/i);
});

test('a specification is exempt from the evidence gate by design', () => {
  const db = require('../src/db.js');
  const p = db.get("SELECT id FROM project WHERE slug = 'pumpkinlib'");
  if (!p) return;
  assert.deepEqual(media.publishBlockers(p.id), [], 'specification was wrongly gated');
});

test('the publish gate is actually INVOKED by the save path, not just defined', () => {
  // This is the failure mode the gate itself is vulnerable to. A blocker
  // function that is exported and unit tested but never called is worse than
  // no gate at all, because it looks closed. Assert the call site exists.
  const fs = require('node:fs');
  const path = require('node:path');
  const admin = fs.readFileSync(
    path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1))), 'src', 'routes', 'admin.js'),
    'utf8'
  );
  assert.match(admin, /publishBlockers\(/, 'nothing calls publishBlockers');
  // And it must gate the published flag specifically, not merely be referenced.
  assert.match(
    admin,
    /published[\s\S]{0,80}publishBlockers/,
    'publishBlockers is called but not tied to the published transition'
  );
});
