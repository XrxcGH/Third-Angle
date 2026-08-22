# Third Angle

Eric J. Dean's engineering portfolio. Mechanical, electrical, controls,
software, fabrication, documentation, business and teaching, presented as one
record per project rather than one page per discipline.

Server rendered Node, Express and EJS on `node:sqlite`. No build step, no native
dependencies, no framework. Runs on a free Oracle Always Free ARM instance for
the price of a domain name.

**Status: phases 02 to 08 done.** The public site, facet model, search, design
system, admin panel, media pipeline, document library, feeds and deploy tooling
are built and tested. The restore drill and the launch are not. See
[Roadmap](#roadmap).

## Run it

Requires **Node 24 or newer**. Older builds ship without FTS5, and the app
refuses to start on them rather than failing later in a confusing way.

```bash
npm install
npm run fonts      # downloads the three OFL faces to public/fonts
npm run seed       # creates the database and loads real content
npm run seed:pages # the resume page
npm run seed:edu   # institutions, classes and activities
npm start          # http://localhost:3000
```

`npm run dev` restarts on change. `npm run seed -- --reset` wipes and rebuilds.

## Checks

```bash
npm test              # 190 tests: routes, seo, icons, documents, contrast, layout, markup, account, pages, mailer, search, schema, security, auth, media, backup, regression
npm run check:scope   # fails when prose outruns code
npm run check:costs   # fails when a quoted price goes stale
```

Each of those exists because of a specific documented failure, not because a
checklist said to add tests. `npm test` currently catches, among other things, a
dim state that fails WCAG while looking fine, an FTS5 syntax error triggered by
typing `C++` into search, an open redirect that a naive `startsWith('/')` check
lets through, a `padding` shorthand that deletes the page gutter on a phone, and
the CRLF that a browser puts in every textarea and that quietly collapsed a
saved project body into one paragraph.

## Layout

```
server.js              boot, middleware order, SIGTERM drain
src/
  db.js                node:sqlite, pragmas, startup assertions
  schema.sql           STRICT tables, FTS5, the constraints that close risks
  repo.js              every query, as a named function
  markup.js            the two renderers. Nothing else turns stored text into HTML.
  labels.js            title case, and one label per stored enum
  collage.js           what the photo wall needs. It does NOT compute a layout.
  github.js            server side GitHub, cached, so no visitor talks to GitHub
  mailer.js            SMTP submission over node:tls, no dependency
  settings.js          the closed set of switches the admin can flip
  middleware.js        theme, security headers, redirects
  routes/public.js     the public site
  routes/admin.js      the admin, including the account page
views/                 EJS, layout plus pages plus partials
public/css/tokens.css  the design system. Nothing else defines a colour.
public/css/app.css     the component layer, including every form control
public/css/admin.css   admin density only. The public layout never loads it.
scripts/               seed, fonts, admin, db-tool, scope guard, cost check
deploy/                provision, systemd, Caddy, Litestream, backup, verify
tests/                 routes, contrast, layout, markup, account, search, schema, security, auth, media, backup
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
- Discipline icons are drawn, not bought: a caliper, a crimp barrel, a step
  response. Every stock pack offers a gear, a lightbulb and a rocket, all three
  of which are banned.
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

**Documents are searchable to the page.** Every page of every PDF is extracted
on upload and indexed, so a query for "retention schedule" returns the document
and the page number, not a filename that happens to contain the word.

**Search has three stages**, each paying for itself only when the one before
finds nothing: a `unicode61` prefix match, a trigram substring match, then edit
distance correction over the index's own vocabulary. So `harn` finds harnesses,
`lectric` finds electrical, and `swrve` suggests swerve.

**Ordering uses fractional indexes**, so inserting between two projects touches
one row. The keys are case sensitive base62: never declare `sort_key` as
`COLLATE NOCASE` and never sort it with `localeCompare`.

**GitHub is read by the server, not by the visitor.** The profile and every
repository are fetched here, cached for an hour with an ETag, and rendered as
HTML. Nothing on `/professional` calls out to a third party while you read it:
no extra connection, no script exception to a CSP that allows none, and a panel
that is not empty for anyone running a blocker. **LinkedIn cannot work the same
way.** There is no public profile API without a partner agreement and a profile
page cannot be framed, so what renders is a card built from the record this site
already holds. LinkedIn's own badge is available as a switch in the admin,
because it is a real third party connection and should be a decision.

**The photo wall is one wall.** `/personal` drops every photograph in together
at the full width of the window and scrolls; there are no albums, sections or
filters to maintain, and the only decision on an upload is whether it is on the
wall. `/admin/photos` is that one switch.

**The photo collage packs itself.** Each tile carries its aspect ratio and
flexbox does the rest, so every row fills the width exactly, adding a photograph
re-packs everything below it, and there is nothing to rearrange by hand.
Hovering one tile widens it and its neighbours give up the width, without the
row changing height or the page reflowing. Below 700px it becomes two masonry
columns instead of squeezing, because a single justified tile crops every
photograph to the same band and that destroys a portrait.

**The site moves, and none of it is JavaScript.** Pages cross-fade into each
other with view transitions, the first block of each page rises in, sections and
cards arrive as the reader scrolls to them, the header takes a shadow once the
page has moved under it, and a hairline across the header tracks how far through
the page you are. All of it is `public/css/motion.css`, all of it switches off
under `prefers-reduced-motion`, and none of it can strand content: anything that
starts an element invisible is behind both a preference query and an `@supports`
for the feature that finishes it.

**A contact message is stored before it is sent.** The inbox is the record and
the email is a copy. A relay that is down, misconfigured or not set up yet costs
a notification and never a message, and the admin shows every row's delivery
state with a retry. Outbound mail is SMTP over `node:tls` with no dependency,
same reasoning as scrypt and TOTP.

**The account is maintained from inside the site.** `/admin/account` changes the
name, the sign in address and the password, enrols or removes the second factor,
and lists the sessions that can currently reach the admin. Changing the password
requires the current one, even though the session is already authenticated, and
ends every other session. `scripts/create-admin.js --temp` hands over a short
password for exactly this page to replace; while that flag is set, every admin
page carries a warning. It is a warning and not a lock, because the point of a
hand-over password is that it works.

## Roadmap

| Phase | | |
|---|---|---|
| 00 | Decide, claim long-lead assets | design system done; domain and VM are yours to claim |
| 01 | Content capture | ongoing, and the real critical path |
| 02 | Walking skeleton and schema | **done** |
| 03 | Design system in code | **done** |
| 04 | Admin CRUD, reorder, media | **done** |
| 05 | Public site | **done**, tier-gated project pages |
| 06 | Search, documents, feeds | **done**, including per-page PDF indexing |
| 07 | Icons, structured data, social cards | **done** |
| 08 | Deploy and rehearse the restore | tooling **done**; the drill is yours to run |
| 09 | Professional, education and personal pages | **done** |
| 10 | GitHub cleanup, then launch | pending |

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
