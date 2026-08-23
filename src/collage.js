'use strict';

/*
 * Photo collage layout.
 *
 * The wall is one undivided surface of photographs at different sizes, packed
 * with no dead space, that reflows itself when a photograph is added and needs
 * nobody to arrange anything by hand.
 *
 * It is packed here, on the server, and that is a deliberate reversal.
 *
 * Justified rows (flex-basis by aspect ratio, flex-grow to fill) pack perfectly
 * at any width with no JavaScript, which is why the wall was built that way
 * first. What they cannot do is vary a tile in two directions: every tile in a
 * row is the same height, so the only variety available is width, and the wall
 * reads as a stack of strips. Measured against the three collages this page is
 * meant to look like, that is the single difference that matters — all three
 * have four or five size classes across a sixteen-to-one area range, tiles that
 * are locally aligned and globally aligned to nothing, and coverage above 97%.
 *
 * So the rectangle is cut in two, and each half cut in two again, until every
 * photograph has a slot. The split is always at a CONTIGUOUS point in the list,
 * so reading order survives exactly: everything in the first half is above or
 * to the left of everything in the second. The result is a set of slots given
 * as percentages of the wall, which is resolution independent — the browser
 * still decides the actual pixel size, and the wall still fills whatever width
 * the window turns out to have.
 *
 * The wall's own aspect ratio is chosen from the number of photographs, so a
 * wall of twelve is a feature and a wall of two hundred is a mosaic, and below
 * 700px this layout is abandoned entirely for two masonry columns (see
 * app.css): a slot shape computed for a desktop is a sliver on a phone.
 */

/*
 * Aspect ratios are clamped for LAYOUT only. The image itself keeps its true
 * shape and is cropped by object-fit.
 *
 * Without a clamp a 6:1 panorama drags its whole branch of the split into a
 * strip and a 1:3 portrait into a sliver. Both are real photographs somebody
 * will upload, and neither should be able to dictate the wall.
 */
const MIN_ASPECT = 0.62;   // a little narrower than 2:3 portrait
const MAX_ASPECT = 2.40;   // a little wider than 21:9

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Round so the emitted CSS is short and stable. */
const round = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * One photograph, ready to render.
 *
 * `aspect` is what the packer reasons about. `trueAspect` is kept so a test can
 * tell a clamp from a bug, and so the caption can note a panorama.
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
  };
}

/*
 * How much visual weight each photograph claims, as a repeating cadence.
 *
 * The three references agree on the shape of the distribution and disagree only
 * on the numbers: roughly 8% features, 20% large, 36% medium, 28% small, 8%
 * tiny, with the largest tile something like sixteen times the area of the
 * smallest. This is that distribution written out, rather than computed, so it
 * is obvious at a glance what the wall is made of and easy to change.
 *
 * A cadence rather than a random draw, because a wall that reshuffles between
 * two visits makes it impossible to point somebody at a photograph. Length 25,
 * which shares no factor with the hero interval below, so a hero lands on a
 * different class each time it comes round.
 */
const W_FEATURE = 4.0;
const W_LARGE = 2.4;
const W_MEDIUM = 1.35;
const W_SMALL = 0.8;
const W_TINY = 0.5;

/*
 * The order matters as much as the numbers.
 *
 * Written with the classes interleaved — medium, small, large, medium, tiny —
 * the packer is repeatedly asked to fit a tiny tile beside a large one inside a
 * single rectangle, and the only way to do that is to cut a post off the side.
 * Measured on the same wall, an interleaved cadence produced fifteen slots
 * narrower than 1:3 and a worst crop of 15x; the same weights grouped into
 * runs, so that like sizes nest together and the cuts fall on the boundaries
 * between them, produced four and 4.7x.
 *
 * So the cadence is written in regions: a feature and its large neighbours,
 * then a run of mediums, then a run of smalls and tinies, then back. It reads
 * on the wall as areas of different density, which is exactly what the
 * references do.
 */
const CADENCE = [
  W_FEATURE, W_LARGE, W_LARGE, W_MEDIUM, W_MEDIUM,
  W_MEDIUM, W_SMALL, W_SMALL, W_TINY, W_TINY,
  W_MEDIUM, W_MEDIUM, W_LARGE, W_LARGE, W_FEATURE,
  W_MEDIUM, W_MEDIUM, W_SMALL, W_SMALL, W_SMALL,
  W_TINY, W_TINY, W_MEDIUM, W_MEDIUM, W_LARGE,
];

const HERO_EVERY = 47;
const HERO_OFFSET = 11;
const W_HERO = 9.0;

/*
 * Variety needs a population.
 *
 * The distribution above describes a dense wall of fifty photographs or more.
 * Applied unchanged to a wall of twelve it is nonsense: a tile nine times the
 * weight of a tiny one is a third of the whole canvas, and the eleven others
 * are pushed into the margins around it. The references are only references at
 * their own density.
 *
 * So the whole dynamic range is interpolated with the count, geometrically
 * toward 1. A wall of eight is flat and every photograph is roughly equal; the
 * spread opens as photographs are added and is at full strength by about fifty,
 * which is where the references sit.
 */
const SPREAD_FLOOR = 8;
const SPREAD_FULL = 52;

function spread(count) {
  return clamp((count - SPREAD_FLOOR) / (SPREAD_FULL - SPREAD_FLOOR), 0, 1);
}

function weightAt(i, count) {
  const raw = i % HERO_EVERY === HERO_OFFSET ? W_HERO : CADENCE[i % CADENCE.length];
  return Math.exp(Math.log(raw) * spread(count));
}

/**
 * How many tiles wide the wall reads as.
 *
 * This is the one number that decides whether the wall is a feature or a
 * mosaic, and it is the only thing the wall's own aspect ratio is derived from:
 * a wall `across` tiles wide holding `count` of them is `across / count` tiles
 * tall, so its aspect ratio is across² / count. Fractional on purpose — it is
 * an average tile, not a column count, and nothing lines up in columns anyway.
 */
function across(count) {
  if (count <= 1) return 1;
  if (count <= 3) return 2;
  if (count <= 8) return 3;
  if (count <= 15) return 3.6;
  if (count <= 30) return 4.6;
  if (count <= 60) return 6;
  if (count <= 120) return 7;
  return 9.5;
}

/**
 * The wall's aspect ratio: width over height.
 *
 * Small walls are special-cased away from the formula. One photograph gets the
 * wall its own shape, so the only picture on the page is not cropped to a
 * square for the sake of a rule; two get a wall as wide as both side by side,
 * for the same reason.
 */
function wallAspect(tiles) {
  const n = tiles.length;
  if (n === 0) return 1;
  if (n <= 2) return round(tiles.reduce((sum, t) => sum + t.aspect, 0));
  const a = across(n);
  return round((a * a) / n);
}

/*
 * Cut a rectangle in two, and recurse.
 *
 * Two things are decided at each cut: where in the list to split, and which way
 * to cut the rectangle. Neither is obvious.
 *
 * The weight median is the obvious place to split, and it ignores what is
 * actually in the two halves. A group of portraits handed a wide rectangle gets
 * sliced into vertical strips; a panorama handed a tall one is cropped to a
 * post. So every cut within a small window of the median is tried, both
 * directions, and the one whose children come closest to the shape their
 * photographs actually want is kept. Measured over the same wall, that took the
 * worst crop from 11.5x down to 3.7x and the median from 2.4x to 1.6x.
 *
 * `out` is appended to in list order, so the emitted array is still the order
 * the photographs came in.
 */
const CUT_WINDOW = 3;
const BALANCE = 0.6;
/*
 * How far the shape of the photographs is allowed to move the split away from
 * where the weights put it, and how small a group has to be before it is
 * allowed to. Near the leaves the approximation below is exact — a group of one
 * wants exactly its own aspect ratio — and that is also where a bad split shows
 * as a cropped post, so the pull is applied there and nowhere else.
 */
const SHAPE_PULL = 0.5;
const SHAPE_PULL_MAX_GROUP = 3;
/* No split may hand one side less than this, whatever the weights say. */
const MIN_SHARE = 0.10;
/*
 * A slot outside this range is a strip: too narrow to see what the photograph
 * is of at any size the wall renders at. Cuts that would make one are rejected
 * outright rather than scored, because a penalty added to a score is always
 * outbid by a big enough shape win somewhere else, and a strip is never worth
 * winning. Checked only where a child is a single photograph, which is where a
 * strip is actually born; deeper up the tree an elongated rectangle is just a
 * region that will be cut again.
 */
const STRIP_MIN = 0.42;
const STRIP_MAX = 2.40;

const geoMean = (list) => Math.exp(
  list.reduce((n, it) => n + Math.log(it.aspect), 0) / list.length
);
/* Distance between two aspect ratios, in log space, so 2x too wide and 2x too
   tall score the same. */
const shapeErr = (got, want) => Math.abs(Math.log(got / want));

function pack(items, rect, out) {
  if (items.length === 0) return;
  if (items.length === 1) {
    out.push({ item: items[0], rect });
    return;
  }

  const total = items.reduce((n, it) => n + it.weight, 0);

  let mid = 1;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].weight;
    if (acc >= total / 2) { mid = i + 1; break; }
  }
  /* Both halves must be non-empty or the recursion never terminates. */
  mid = Math.min(Math.max(mid, 1), items.length - 1);

  const lo = Math.max(1, mid - CUT_WINDOW);
  const hi = Math.min(items.length - 1, mid + CUT_WINDOW);

  let best = null;
  for (let cut = lo; cut <= hi; cut++) {
    const a = items.slice(0, cut);
    const b = items.slice(cut);
    const byWeight = a.reduce((n, it) => n + it.weight, 0) / total;
    const wantA = geoMean(a);
    const wantB = geoMean(b);

    /*
     * Where the shapes would put the split.
     *
     * Cutting vertically at wantA / (wantA + wantB) leaves both children the
     * same factor away from the aspect ratio they wanted, which is the best a
     * single cut can do for both at once. Horizontally it is the reciprocal,
     * so the shares swap.
     */
    const pull = Math.max(a.length, b.length) <= SHAPE_PULL_MAX_GROUP ? SHAPE_PULL : 0;
    const mix = (byShape) => clamp(
      (1 - pull) * byWeight + pull * byShape, MIN_SHARE, 1 - MIN_SHARE
    );
    const shareV = mix(wantA / (wantA + wantB));
    const shareH = mix(wantB / (wantA + wantB));

    /* A cut that leaves 90% of the weight on one side is a cut that made a
       stripe, however well the shapes happen to score. */
    const skew = (s) => Math.abs(s - 0.5) * BALANCE;

    const vertical = shapeErr((rect.w * shareV) / rect.h, wantA)
      + shapeErr((rect.w * (1 - shareV)) / rect.h, wantB) + skew(shareV);
    const horizontal = shapeErr(rect.w / (rect.h * shareH), wantA)
      + shapeErr(rect.w / (rect.h * (1 - shareH)), wantB) + skew(shareH);

    const sound = (group, aspect) => group.length > 1
      || (aspect >= STRIP_MIN && aspect <= STRIP_MAX);

    const candidates = [
      {
        score: vertical, dir: 'v', share: shareV, a, b,
        ok: sound(a, (rect.w * shareV) / rect.h) && sound(b, (rect.w * (1 - shareV)) / rect.h),
      },
      {
        score: horizontal, dir: 'h', share: shareH, a, b,
        ok: sound(a, rect.w / (rect.h * shareH)) && sound(b, rect.w / (rect.h * (1 - shareH))),
      },
    ];
    /* Sound first, then by score: a cut that makes no strip always beats one
       that does, however much better it scores. */
    for (const pick of candidates) {
      if (!best || (pick.ok && !best.ok)
        || (pick.ok === best.ok && pick.score < best.score)) best = pick;
    }
  }

  const { dir, share, a, b } = best;
  if (dir === 'v') {
    const w1 = rect.w * share;
    pack(a, { x: rect.x, y: rect.y, w: w1, h: rect.h }, out);
    pack(b, { x: rect.x + w1, y: rect.y, w: rect.w - w1, h: rect.h }, out);
  } else {
    const h1 = rect.h * share;
    pack(a, { x: rect.x, y: rect.y, w: rect.w, h: h1 }, out);
    pack(b, { x: rect.x, y: rect.y + h1, w: rect.w, h: rect.h - h1 }, out);
  }
}

/**
 * Prepare the wall for rendering.
 *
 * Order is by capture date, newest first, decided in SQL. Nothing here
 * reorders. Each tile comes back with its slot as four percentages of the
 * wall's box, which is all the template needs.
 */
function layout(photos) {
  const tiles = photos.map(tile);
  const ar = wallAspect(tiles);

  if (tiles.length) {
    const items = tiles.map((t, i) => ({ t, aspect: t.aspect, weight: weightAt(i, tiles.length) }));
    const slots = [];
    /* Pack in a space one unit wide and 1/ar tall, so the rectangles the packer
       reasons about have the proportions the browser will actually give them,
       then convert each axis to a percentage of the wall's own box. */
    const H = 1 / ar;
    pack(items, { x: 0, y: 0, w: 1, h: H }, slots);
    for (const { item, rect } of slots) {
      item.t.left = round4(rect.x * 100);
      item.t.top = round4((rect.y / H) * 100);
      item.t.slotWidth = round4(rect.w * 100);
      item.t.slotHeight = round4((rect.h / H) * 100);
      /*
       * What shape the slot turned out to be, so a test can prove the photo is
       * not being cropped to a post and the harness can report on it.
       *
       * rect.w / rect.h directly: the packing space is one unit wide and 1/ar
       * tall, so one unit on either axis is the same number of pixels and a
       * rectangle's aspect ratio in that space is already its aspect ratio on
       * the screen. Scaling this by ar was a real bug — it reported every slot
       * as 1.5x taller than it is, and the packer was tuned against it.
       */
      item.t.slotAspect = round(rect.w / rect.h);
      /* Measured against the photograph's TRUE shape, not the clamped one:
         the clamp is a layout decision and the crop it causes is real. */
      item.t.crop = round(Math.max(item.t.slotAspect / item.t.trueAspect,
        item.t.trueAspect / item.t.slotAspect));
    }
  }

  return {
    tiles,
    count: tiles.length,
    wallAspect: ar,
    across: across(tiles.length),
    portrait: tiles.filter((t) => t.aspect < 1).length,
    landscape: tiles.filter((t) => t.aspect >= 1).length,
  };
}

module.exports = {
  layout, tile, across, wallAspect, weightAt, spread,
  MIN_ASPECT, MAX_ASPECT, CADENCE, HERO_EVERY,
};
