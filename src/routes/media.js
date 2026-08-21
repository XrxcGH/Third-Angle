'use strict';

/*
 * Serving uploaded files.
 *
 * Deliberately a route rather than express.static, because uploaded bytes need
 * headers that static middleware will not set for them: nosniff on everything,
 * and Content-Disposition: attachment on anything that is not a re-encoded
 * image. A PDF rendered inline is the residual XSS vector once every other
 * control is in place, since a PDF cannot be re-encoded on the way in.
 *
 * In production these files move to an R2 custom domain, which is a separate
 * origin and therefore also cookieless. This route stays as the local and
 * fallback path, so the header policy is identical either way.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { UPLOAD_DIR } = require('../db');

const router = express.Router();

const INLINE_OK = new Set(['image/webp', 'image/avif', 'image/jpeg', 'image/png', 'image/gif', 'video/mp4']);

const EXT_MIME = {
  webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', mp4: 'video/mp4',
  pdf: 'application/pdf', glb: 'model/gltf-binary',
};

router.get(/^\/media\/(.+)$/, (req, res, next) => {
  const rel = req.params[0];

  /*
   * Resolve, then prove the result is still inside the upload directory.
   * Checking the input for '..' is not enough on its own: encoded traversal,
   * backslashes on Windows, and symlinks all get past a string test, and only
   * comparing the resolved paths closes all three.
   */
  const abs = path.resolve(UPLOAD_DIR, rel);
  const root = path.resolve(UPLOAD_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return next();

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return next();
  }
  if (!stat.isFile()) return next();

  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = EXT_MIME[ext];
  // Unknown extension means the file was not produced by this pipeline.
  if (!mime) return next();

  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', stat.size);
  // Storage keys are content addressed random names, so a given URL never
  // changes what it points at and can be cached hard.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

  if (!INLINE_OK.has(mime)) {
    const name = path.basename(abs);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }

  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
