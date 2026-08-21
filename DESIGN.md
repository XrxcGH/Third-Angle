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

Direction **ANODIZE**. Machine tool enamel gray green at OKLCH hue 135, the
colour of a Bridgeport, nowhere near slate at 257 or Tailwind's near black at
265. Hazard orange at hue 52 is the single loud accent and reads instantly as
electrical, safety and shop work. Copper and patina are the quiet supports.

All values live in `public/css/tokens.css`. Nothing else defines a colour.

Four rules that are load bearing:

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
- `tabular-nums lining-nums` on every BOM row, spec value, quantity and budget
  figure.
- Part numbers, CAN IDs and revision codes go in the mono with
  `font-variant-ligatures: none`. A part number containing `--` or `!=` is
  otherwise healed into a glyph the reader cannot retype.
- Use U+2212 MINUS for negative tolerances, not a hyphen. Minus is drawn at
  digit height; a column of tolerance values will not align otherwise.

## Banned

- Any gradient between hues 250 and 320
- Gradient clipped text headlines
- Inter, Roboto, Geist Sans or Space Grotesk as a display face
- Tailwind slate, zinc, gray, neutral and stone families
- Default blue-600 or indigo-500 anything
- Decorative backdrop blur
- Border radius above 6px on cards, above 3px on inputs
- Uniform large shadows on everything
- A centred hero with two buttons
- A three card feature row
- A four column footer
- Fade in up on more than one element per viewport
- The worn Lucide subset: Sparkles, ArrowRight, Zap
- Gear, lightbulb and rocket iconography
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

One hero motion moment per page. Motion only on state change or first entry into
view. Nothing loops autonomously, which sidesteps WCAG 2.2.2 entirely. UI
feedback under 200ms, entrances 300 to 500ms. Never more than two elements
animating at once. No parallax on text. Every animation must be removable
without losing information.

Under `prefers-reduced-motion: reduce`, transition durations drop to 1ms rather
than being removed. The state change still happens because it is information,
not decoration. Nothing moves.

A CSS `prefers-reduced-motion` block **cannot** stop a Lottie or Rive animation,
because those render into a canvas from a JavaScript loop CSS cannot reach. That
branch has to exist in JavaScript. See risk R4 in the proposal.

## Risks this codebase closes in code

| Risk | Mechanism | Test |
|---|---|---|
| R1 scope creep | `scripts/scope-guard.mjs` fails CI when prose outruns code | `npm run check:scope` |
| R2 no evidence | `media.origin` CHECK plus a publish gate | `tests/schema.test.mjs` |
| R3 facet drift | lookup table plus a NOCASE unique index | `tests/schema.test.mjs` |
| R4 dim fails contrast | token swap plus computed ratio assertions | `tests/contrast.test.mjs` |
| R6 single writer | SIGTERM drain, no blue/green, measured restore | `RESTORE.md` |
| R8 hollow sections | `project.tier` CHECK selects 3, 6 or 12 blocks | `tests/schema.test.mjs` |
| R9 stale prices | `costs.yml` with dated evidence | `npm run check:costs` |

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
