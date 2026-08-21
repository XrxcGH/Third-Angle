# Third Angle

Eric J. Dean's engineering portfolio. Mechanical, electrical, controls,
software, fabrication, documentation, business and teaching, presented as one
record per project rather than one page per discipline.

Server rendered Node, Express and EJS on `node:sqlite`. No build step, no native
dependencies, no framework. Runs on a free Oracle Always Free ARM instance for
the price of a domain name.

**Status: phases 02 to 05 done.** The public site, facet model, search, design
system, admin panel and media pipeline are built and tested. The document
library, feeds and deploy tooling are not. See [Roadmap](#roadmap).

## Run it

Requires **Node 24 or newer**. Older builds ship without FTS5, and the app
refuses to start on them rather than failing later in a confusing way.

```bash
npm install
npm run fonts      # downloads the three OFL faces to public/fonts
npm run seed       # creates the database and loads real content
npm start          # http://localhost:3000
```

`npm run dev` restarts on change. `npm run seed -- --reset` wipes and rebuilds.

## Checks

```bash
npm test              # 74 tests: routes, contrast, search, schema, security, auth, media, backup, regression
npm run check:scope   # fails when prose outruns code
npm run check:costs   # fails when a quoted price goes stale
```

Each of those exists because of a specific documented failure, not because a
checklist said to add tests. `npm test` currently catches, among other things, a
dim state that fails WCAG while looking fine, an FTS5 syntax error triggered by
typing `C++` into search, and an open redirect that a naive `startsWith('/')`
check lets through.

## Layout

```
server.js              boot, middleware order, SIGTERM drain
src/
  db.js                node:sqlite, pragmas, startup assertions
  schema.sql           STRICT tables, FTS5, the constraints that close risks
  repo.js              every query, as a named function
  middleware.js        theme, security headers, redirects
  routes/public.js     the public site
views/                 EJS, layout plus pages plus partials
public/css/tokens.css  the design system. Nothing else defines a colour.
scripts/               seed, fonts, admin, db-tool, scope guard, cost check
deploy/                provision, systemd, Caddy, Litestream, backup, verify
tests/                 routes, contrast, search, schema, security, auth, media, backup
DESIGN.md              the rules, and what will bite you
costs.yml              every price, dated and sourced
```

## Design

Read [DESIGN.md](DESIGN.md) before touching the front end, and point any AI
assistant at it too. The short version:

- Colour direction is **Anodize**: machine tool gray green at OKLCH hue 135,
  hazard orange at hue 52 as the single loud accent.
- Type is TASA Orbiter, Literata and Martian Mono, all SIL OFL, all self hosted.
- **`--on-accent` is never white.** White on hazard orange fails AA at 3.30:1.
- **Dimming is a token swap, never opacity.** axe-core cannot see an opacity
  contrast failure, so an opacity dim passes the tool meant to catch it.
- No emoji. No em dashes.

## How a few things work

**Theme without a flash.** The preference is a cookie, not `localStorage`, so
the server reads it on the first request and emits `<html data-theme="...">` in
the initial HTML. There is no inline script anywhere, which is also why the CSP
needs no nonce. Three states: system, light, dark. A two state toggle silently
overrides the OS preference forever.

**Filtering does not remove anything.** Selecting a discipline marks
non-matching cards and de-emphasises them in CSS. The page never reflows, the
breadth stays visible, and the filter is linkable and indexable because it lives
in the query string.

**Search has three stages**, each paying for itself only when the one before
finds nothing: a `unicode61` prefix match, a trigram substring match, then edit
distance correction over the index's own vocabulary. So `harn` finds harnesses,
`lectric` finds electrical, and `swrve` suggests swerve.

**Ordering uses fractional indexes**, so inserting between two projects touches
one row. The keys are case sensitive base62: never declare `sort_key` as
`COLLATE NOCASE` and never sort it with `localeCompare`.

## Roadmap

| Phase | | |
|---|---|---|
| 00 | Decide, claim long-lead assets | design system done; domain and VM are yours to claim |
| 01 | Content capture | ongoing, and the real critical path |
| 02 | Walking skeleton and schema | **done** |
| 03 | Design system in code | **done** |
| 04 | Admin CRUD, reorder, media | **done** |
| 05 | Public site | **done**, tier-gated project pages |
| 06 | Search, feeds, colophon | search, Atom and JSON feeds, /now, attributions **done**; document library next |
| 07 | Icons, motion, polish | pending |
| 08 | Deploy and rehearse the restore | tooling **done**; the drill is yours to run |
| 09 | GitHub cleanup, then launch | pending |

The content, not the software, is the critical path. Photographs of the physical
work and a short video of a robot moving outrank everything on this list.

## Deploying

```bash
git clone https://github.com/XrxcGH/third-angle.git
sudo bash third-angle/deploy/provision.sh
```

Then read [RESTORE.md](RESTORE.md) and actually run the drill:

```bash
sudo third-angle-verify
```

An unrehearsed backup is a belief. The runbook has a blank where the measured
recovery time goes, and filling it in is the point.

## Licence

Code is MIT. Content, images and written work are all rights reserved. The three
typefaces are SIL OFL 1.1 and their notices are reproduced at `/attributions`,
which the licence requires.
