# Third Angle, design rules

Point any AI assistant at this file before it touches the front end. The
operational finding behind that instruction is simple: a model reverts to the
training corpus average on any unconstrained decision, so the fix is locked
tokens and a written ban list, not better prompting.

Frame these as "justify in writing before violating", not as absolute. A
centred layout is genuinely correct for a 404 page.

## The idea

Third angle projection is the drawing convention that says: here is one object,
shown from several directions, and no single view is the object. That is the
portfolio's whole thesis. One person, eight disciplines, one record per project.

## Colour

Direction **ANODIZE**. Machine tool enamel grey green at OKLCH hue 135, the
colour of a Bridgeport, nowhere near slate at 257 or Tailwind's near black at
265. Hazard orange at hue 52 is the single loud accent and reads instantly as
electrical, safety, and shop work. Copper and patina are the quiet supports.

All values live in `public/css/tokens.css`. Nothing else defines a colour.

Five rules that are load bearing:

1. **`color-scheme: light dark` must stay on `:root`.** Without it `light-dark()`
   silently returns the light value forever and the entire dark theme fails with
   no error.
2. **`--on-accent` is not white.** White on hazard orange measures 3.30:1 and
   fails AA. Dark ink measures 5.27:1 and passes, which is also the real ANSI
   convention. This is encoded as a token and asserted by a test precisely so
   the next person cannot reach for white out of habit.
3. **Dimming is a token swap, never opacity.** axe-core reports contrast as
   "incomplete" rather than a violation whenever foreground opacity is involved,
   so an opacity dim passes the exact tool meant to catch it and CI reports
   green on a broken page. `tests/contrast.test.mjs` is the real gate.
4. **The two dark blocks must stay identical.** One dark palette is defined
   twice: under `prefers-color-scheme` for the un-stamped default, and under
   `[data-theme="dark"]` for the explicit toggle. Drift is invisible until
   someone flips the toggle on a light OS. A test asserts it.
5. **The print palette is part of the palette.** Every element takes its colour
   from a token, so forcing white paper in `app.css` does nothing about the ink:
   printing with the dark theme active put `#D9DED6` body text onto white. The
   `@media print` block in `tokens.css` restates the whole palette, and a test
   asserts it covers every token the screen palettes define.

Contrast target is WCAG 2.2 AA. APCA was pulled from the WCAG 3 draft in 2023
and the WCAG 3 contrast algorithm is still undetermined, so APCA is a design
tiebreaker here, never the contract.

## Typography

| Role | Face | Why |
|---|---|---|
| Display | TASA Orbiter | Drawn for a national space agency's technical identity. Squared counters read as mechanism. Almost nobody uses it. |
| Body | Literata | A real reading serif with an optical size axis and true italics. Every other engineering portfolio uses a sans. |
| Data | Martian Mono | Built for dense data. Slashed zero by default, width axis for tightening a table. |

All three are SIL OFL 1.1 and **self hosted** via `npm run fonts`. Not the CDN:
HTTP cache partitioning killed the shared-cache benefit, the CDN costs two extra
third party connections, and it carries a live GDPR question that is the wrong
risk to hold on a site fronting a nonprofit.

Technical typography, non negotiable:

- Use `font-variant-numeric`, never `font-feature-settings`. The latter is all
  or nothing and silently cancels every `font-variant-*` on the element, which
  is the most common cause of tables that mysteriously lose tabular figures.
- `tabular-nums lining-nums` on every BOM row, spec value, quantity, and budget
  figure.
- Part numbers, CAN IDs, and revision codes go in the mono with
  `font-variant-ligatures: none`. A part number containing `--` or `!=` is
  otherwise healed into a glyph the reader cannot retype.
- Use U+2212 MINUS for negative tolerances, not a hyphen. Minus is drawn at
  digit height; a column of tolerance values will not align otherwise.

## Layout

`public/css/app.css` is the component layer. Everything a **public** page can
use lives there; `public/css/admin.css` holds only what is genuinely
admin-specific, because the public layout never loads it. Forms, buttons, panels
and flashes belong to app.css: in the admin sheet they leave the contact form
rendering as bare user-agent widgets, which looks exactly like a stylesheet
failing to load.

Four things that will silently break a page rather than error:

1. **`padding` shorthand on `.wrap`.** The gutter is `padding-inline`, and an
   inline `padding: <y> 0` is a shorthand that resets it to zero. Use
   `padding-block`, or the `.pad-top` / `.pad-page-lg` classes. A test scans the templates.
2. **`minmax(280px, 1fr)` in an auto-fill grid.** The track cannot go below its
   floor, so once the column is narrower the document scrolls sideways. Always
   `minmax(min(280px, 100%), 1fr)`.
3. **A divider and a measure on the same element.** `.section` is page width,
   `.prose` and `.measure` are `max-width: none`, so text runs the page width too.
   Reintroducing a measure on an element that also carries a divider stops its
   rule short while every other rule runs full width, which reads as a rendering
   fault. `.section.prose` keeps an explicit `none` so a cap has to be put back
   on purpose rather than inherited by accident.
4. **Anything below 16px in a text input.** iOS Safari zooms the viewport on
   focus and never zooms back.

The site must work from a 320px phone to a 1920px monitor with no horizontal
scrollbar anywhere. The public header and the admin bar both drop their
navigation onto its own row below 720px and 860px respectively; `--header-h` is
restated at that breakpoint because `scroll-margin-top` is derived from it.

## Text that gets stored

`src/markup.js` holds both renderers and is the only place either is defined.

- `paragraphs()` for project summaries and bodies, log entries, and `/now`.
  Blank lines separate paragraphs, single newlines are line breaks, nothing else
  is interpreted.
- `richText()` for the fixed editorial pages: h2 to h4, lists, bold, inline
  code, http(s) or site-relative links, and a `label :: value` row.

Both escape first and add markup back afterwards, and both normalise line
endings before doing anything else. That last part is not cosmetic: the HTML
form specification requires a browser to submit textarea content with CRLF,
so a splitter written `/\n{2,}/` never fires on posted text, every body saved
from the admin collapses into one paragraph of line breaks, and the collapsed
text is what gets stored back.

Never store HTML in a `*_md` column. The renderer escapes what it is given, so
the first save from the admin publishes the tags as visible text.

Never `require()` a file from `scripts/` inside a route. Requiring a script runs
it: a route that reaches its renderer that way re-runs the environment
assertion, the migration, and the seeding loop on every save.

## Capitalisation

One rule, stated in `src/labels.js` and applied by `titleCase()` there:

- **Title Case** for anything that names something: headings, navigation,
  buttons, links that act as controls, table headers, form labels, dropdown
  options and status badges. AP form, so short articles, conjunctions and
  prepositions stay lowercase in the middle: "Open in a New Tab", not "Open In
  A New Tab".
- **Sentence case** for anything that reads as a sentence: body copy, the hint
  under a field, empty states, flash messages, alt text, and placeholders.
- **ALL CAPS is never typed.** Where small caps are wanted the uppercase comes
  from `text-transform` in CSS, so the source stays readable in a diff,
  searchable, and translatable.

Every stored enum has exactly one label, in `LABELS` in the same file. A
template must never print `status`, `tier`, `kind`, `weight`, `origin` or
`visibility` directly, or with its own `.replace()`: that is how `case-study`
ends up as three different strings on three screens. A test enforces it.

## Editable content

Every fixed string on the public site is a slot: a key, a default in
`src/content.js`, and an optional override row. Templates call `c()`, `cr()`,
`cf()` and `ci()`; none of them hold copy.

- **The default lives in code, the override lives in the database.** A slot that
  has never been edited has no row, so adding one needs no migration, a better
  default reaches every unedited site, and reset is a `DELETE` rather than a
  second copy of a string somebody has to keep in step.
- **The key set is closed.** `c('typo.key')` throws. An unknown key that
  rendered an empty string would produce a page with a missing heading that
  still looks deliberate, which is the worst available failure.
- **A required slot cannot be emptied.** Headings and page titles restore their
  default when submitted blank. A blank `<h1>` is not a design choice; it is a
  page with no name in a search result.
- **Two tests, both directions.** Every key a template asks for must be
  registered, and every registered key must be asked for somewhere. Either kind
  of drift is silent otherwise.

## The photo collage

**One wall, no categories.** `/personal` is a single stream of every photograph
that is on the wall, full window width, newest capture first, and it scrolls.
There are no albums, no sections, and no filters, because a wall broken into
"sport", "travel", and "family" asks the reader to pick a category before they
have seen a photograph, and it forces a filing decision on every upload. The
database keeps one album row, `personal`, purely so `media.album_slug` still has
a foreign key to point at; nothing in the interface exposes it, and the only
control anywhere is on the wall or off it.

The layout is computed on the server, and that is the design.

The wall is packed on the server, in `src/collage.js`. Justified rows can only
vary a tile in one direction, because every tile in a row shares its height, so
the rectangle is cut in two instead, and each half cut in two again, until every
photograph has a slot. The split is always at a contiguous point in the list, so
reading order survives. Each slot is written as four percentages of the wall,
`--l`, `--t`, `--w` and `--h`, which stays resolution independent: the browser
still decides the pixel size and the wall still fills whatever width the window
turns out to have. Adding a photograph re-packs the wall for free.

- Aspect ratios are clamped for layout only, so a 6:1 panorama cannot take a
  whole row and a 1:4 portrait cannot become a sliver. The image keeps its real
  shape and is cropped by `object-fit`.
- Hover and focus scale one tile by `--tile-hover`, 1.14, so it lifts over its
  neighbours instead of pushing them aside, and every other photograph drops in
  saturation. Nothing is in the flow, so no slot moves, the page does not change
  height, and it never reflows.
- Below 700px the packing is thrown away rather than shrunk. A slot computed to
  sit beside seven others is a sliver when only two fit across, and a tile
  stretched to the full width at a fixed height crops every photograph to the
  same band, which destroys a portrait. Masonry columns instead, each tile at
  its true aspect ratio: three from 560px, two from 360px, and one below that,
  where two would be postage stamps.

## Banned

- Any gradient between hues 250 and 320
- Gradient clipped text headlines
- Inter, Roboto, Geist Sans, or Space Grotesk as a display face
- Tailwind slate, zinc, gray, neutral, and stone families
- Default blue-600 or indigo-500 anything
- Decorative backdrop blur
- Border radius above 6px on cards, above 3px on inputs
- Uniform large shadows on everything
- A centred hero with two buttons
- A three card feature row
- A four column footer
- Fade in up on more than one element per viewport
- The worn Lucide subset: Sparkles, ArrowRight, Zap
- Gear, lightbulb, and rocket iconography
- **Emoji, anywhere, in any context**
- **Em dashes in any copy**

## Required

- Exactly one loud accent plus two quiet supports
- Asymmetric hero, content left weighted
- At least one place where the grid is deliberately broken
- Non uniform spacing: 4 / 8 / 12 / 20 / 32 / 52 / 84
- Low radius reading as machined chamfer, 4 to 6px
- Monospace as a genuine information channel, never decoration
- Every dimmed state above 4.5:1 by construction
- `:focus-visible` on everything, 2px accent outline, 2px offset, contrasting ring
- `scroll-margin-top` so a focused card is never tucked under the sticky header

## Motion

The motion layer is `public/css/motion.css`, and all of it is CSS. A transition
that belongs to one component stays beside that component in `app.css`; what
lives in `motion.css` is what is shared or global.

No public page runs script: page transitions, scroll reveals, the read-progress
line, and the header settle are browser features, not a library. The one script
in the project, `public/js/reorder.js`, enhances drag-to-reorder on the admin
project list, and the buttons it enhances work without it.

One hero motion moment per page: the first block of every page rises in on
load, staggered by 60ms. Everything below it is tied to the reader's own
scrolling rather than to a timer, so an element animates exactly as they arrive
at it and rewinds if they scroll back. Nothing loops autonomously, which
sidesteps WCAG 2.2.2 entirely. UI feedback under 200ms, entrances 300 to 500ms.
No parallax on text. Every animation must be removable without losing
information.

Four rules hold the layer together:

- **Entrances use `translate`, interactions use `transform`.** They are separate
  properties that compose. Sharing one means a card still fading in cannot also
  be pressed, because the animation holds the value and the interaction is
  dropped.
- **Anything that starts an element invisible is behind two guards**, a
  `prefers-reduced-motion: no-preference` query and an
  `@supports (animation-timeline: view())`. A browser that cannot finish an
  animation never starts it, so text is never stranded by a feature that did not
  load.
- **A reveal range closes at `min(100%, 220px)`.** A bare percentage is a
  percentage of the element's own height, so a section taller than the window is
  still arriving while it is being read. A bare length is worse for a short one:
  a 60px tile is fully visible after 60px of scrolling and would still be at a
  third of its opacity. The minimum of the two is the invariant that matters:
  nothing entirely inside the window is ever less than fully opaque.
- **Paper and preference both switch it off.** `@media print` forces opacity
  back to 1, because a page printed mid-reveal prints half transparent.

Under `prefers-reduced-motion: reduce`, transition durations drop to 1ms rather
than being removed, and every reveal is switched off rather than accelerated.
The state change still happens because it is information, not decoration.
Nothing moves.

`tests/motion.test.mjs` asserts the guards from the source. The browser-level
check scrolls thirteen pages at five positions each and asserts the invariant
above; a full-page screenshot captures beyond the viewport without scrolling, so
the screenshot sweep runs under reduced motion deliberately, or every page
photographs half empty.

A CSS `prefers-reduced-motion` block **cannot** stop a Lottie or Rive animation,
because those render into a canvas from a JavaScript loop CSS cannot reach. That
branch has to exist in JavaScript.

## Risks this codebase closes in code

| Risk | Mechanism | Test |
|---|---|---|
| R1 scope creep | `scripts/scope-guard.mjs` exits non-zero when prose outruns code | `npm run check:scope` |
| R2 no evidence | `media.origin` CHECK plus a publish gate | `tests/schema.test.mjs` |
| R3 facet drift | lookup table plus a NOCASE unique index | `tests/schema.test.mjs` |
| R4 dim fails contrast | token swap plus computed ratio assertions | `tests/contrast.test.mjs` |
| R6 single writer | SIGTERM drain, no blue/green, measured restore | `RESTORE.md` |
| R8 hollow sections | `project.tier` CHECK selects 3, 6, or 12 blocks | `tests/schema.test.mjs` |
| R9 stale prices | `costs.yml` with dated evidence | `npm run check:costs` |
| R10 silent layout break | gutter, grid floor, measure, and control-layer assertions | `tests/layout.test.mjs` |
| R11 stored text corruption | one renderer, line endings normalised on the way in | `tests/markup.test.mjs` |
| R12 capitalisation drift | one `titleCase` and one enum label map | `tests/pages.test.mjs` |
| R13 a lost contact message | stored before it is mailed, with a visible delivery state | `tests/mailer.test.mjs` |

## Things that will bite

- `sort_key` holds a fractional index in **case sensitive base62**. Never declare
  it `COLLATE NOCASE` and never sort it with `localeCompare`. Both produce a
  silently wrong order months later.
- Never interpolate user input into an FTS5 `MATCH` expression. FTS5 has its own
  query syntax, so a visitor typing `C++` or a stray quote produces a syntax
  error and a 500 on the page recruiters use most.
- The search tokenizer is `unicode61`, deliberately not `porter`. Porter
  stemming plus prefix queries silently returns zero rows: `harn*` finds nothing
  in an index containing "harnesses".
- `PRAGMA foreign_keys` is asserted at startup rather than trusted. A silently
  disabled pragma turns every `ON DELETE CASCADE` into a no-op.
- STRICT tables validate **datatypes only**. They do nothing for vocabulary
  drift; only the lookup table and the NOCASE index close that.
- `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, which is a no-op for a table
  that already exists. A column added to an existing table therefore never
  appears on an older database, and the failure is a runtime "no such column" on
  whichever page reads it first. Added columns go in `ADDED_COLUMNS` in
  `src/db.js`.
- A `min-width` on a table inside an `overflow-x: auto` wrapper still pushes the
  **document** sideways. Nothing has a bounding box outside the viewport,
  `overflow-x: clip` on an ancestor does not stop it, and the root element will
  not clip it either, because the root's overflow is propagated to the viewport.
  `contain: layout paint` on the wrapper is the mechanism that isolates it.
- `object-src` governs the page doing the embedding, not the thing embedded, and
  Chrome checks `frame-src` for a PDF `<object>` as well. Both have to open for
  the inline reader, and both close again when it is switched off.
- A `<select>` sizes itself to its longest option. In a table cell that lets one
  long project title set the width of a whole column.
