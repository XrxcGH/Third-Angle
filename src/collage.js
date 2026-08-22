'use strict';

/*
 * Photo collage layout.
 *
 * The requirement is a wall of photographs of different shapes that packs with
 * almost no dead space, reflows itself when a photo is added, and needs nobody
 * to rearrange anything by hand.
 *
 * The layout is therefore not computed here, and that is the whole design.
 *
 * A server that computes row breaks has to assume a viewport width, which it
 * does not know: the same rows that pack perfectly at 1440px leave a ragged
 * edge at 900px and overflow at 380px. Flexbox already solves justified rows
 * exactly, at whatever width the browser turns out to have, if each tile is
 * given its aspect ratio:
 *
 *   flex-basis: aspect * row-height   the tile's natural width at that height
 *   flex-grow:  aspect                share of the leftover, proportional
 *
 * Every tile in a row then ends up the same height and the row fills the width
 * exactly. Adding a photo re-packs every row below it for free, on the client,
 * with no JavaScript and no stored order.
 *
 * What this module does is the part flexbox cannot: decide how much visual
 * weight each photograph is allowed to claim.
 */

/*
 * Aspect ratios are clamped for LAYOUT only. The image itself keeps its true
 * shape and is cropped by object-fit.
 *
 * Without a clamp a 6:1 panorama takes a whole row on its own and a 1:3
 * portrait becomes a sliver too narrow to read. Both are real photographs
 * somebody will upload, and neither should be able to dictate the wall.
 */
const MIN_ASPECT = 0.62;   // a little narrower than 2:3 portrait
const MAX_ASPECT = 2.40;   // a little wider than 21:9

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Round so the emitted CSS custom property is short and stable. */
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * One photograph, ready to render.
 *
 * `aspect` is what CSS uses for basis and grow. `trueAspect` is kept so a test
 * can tell a clamp from a bug, and so the caption can note a panorama.
 */
function tile(m) {
  const w = Number(m.width) || 0;
  const h = Number(m.height) || 0;
  const trueAspect = w > 0 && h > 0 ? w / h : 1;
  const aspect = clamp(trueAspect, MIN_ASPECT, MAX_ASPECT);
  return {
    id: m.id,
    storage_key: m.storage_key,
    alt: m.alt || '',
    caption: m.caption || null,
    width: w,
    height: h,
    capturedOn: m.captured_on || null,
    mime: m.mime,
    aspect: round(aspect),
    trueAspect: round(trueAspect),
    clamped: round(aspect) !== round(trueAspect),
    /*
     * How far a tile grows on hover, as a multiplier on its flex-grow.
     *
     * Constant rather than proportional to size on purpose. A multiplier that
     * scaled with the tile would make a big photo swallow its row and a small
     * one barely move, so the interaction would feel different depending on
     * where the cursor happened to land.
     */
    grow: 2.6,
  };
}

/**
 * Prepare an album for rendering.
 *
 * Sorting is by capture date, newest first, done in SQL. Nothing here reorders:
 * a collage that reshuffles on every visit makes it impossible to point someone
 * at a photograph.
 */
function layout(photos) {
  const tiles = photos.map(tile);
  return {
    tiles,
    count: tiles.length,
    /*
     * The sum of the aspect ratios is how many "square tiles wide" the whole
     * album is. It is what decides a sensible row height: an album of eight
     * photographs should not be laid out at the same row height as one of two
     * hundred, or the short album becomes a single strip of stamps.
     */
    aspectSum: round(tiles.reduce((n, t) => n + t.aspect, 0)),
    portrait: tiles.filter((t) => t.aspect < 1).length,
    landscape: tiles.filter((t) => t.aspect >= 1).length,
  };
}

/**
 * Row height for an album, in px, as a starting point for the CSS clamp.
 *
 * Few photographs means a taller row, so a small album reads as a feature
 * rather than a filmstrip. Many means shorter, so the wall does not become a
 * scroll. The value is only a basis: flexbox still stretches every row to the
 * real width, so this changes proportion, never whether the layout fits.
 */
function rowHeight(count) {
  if (count <= 3) return 320;
  if (count <= 8) return 260;
  if (count <= 20) return 220;
  return 190;
}

module.exports = { layout, tile, rowHeight, MIN_ASPECT, MAX_ASPECT };
