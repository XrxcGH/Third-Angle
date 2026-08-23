# Hosting Third Angle On Cloudflare

**Nothing in this document has been implemented.** It is the answer to "can this
run free on Cloudflare Pages and Workers", plus the routes available if you want
it to. Pick one and I will build it.

Facts checked against Cloudflare's own documentation in August 2026. Where a
limit is quoted it is the free plan unless stated otherwise.

## The short answer

**Not as it stands, and not with a small change.** Cloudflare Pages serves
static files and Pages Functions run on Workers, which is a V8 isolate rather
than a machine. This application is an Express server that keeps a SQLite file
and an uploads directory on a persistent disk and re-encodes images with a
native library. Three of those four things have no equivalent in a Worker.

It is not close to working, and it is also not a lost cause: every capability
the app needs exists somewhere in Cloudflare's platform, just not in the shape
the app currently uses. The work is a port, not a config change.

## What actually blocks it

| # | What the app does | On Workers | Severity |
|---|---|---|---|
| 1 | `node:sqlite` `DatabaseSync` against a file | The module is a **stub**: `DatabaseSync` and `StatementSync` are not constructible | Hard |
| 2 | Writes uploads to `data/uploads` and reads them back later | `node:fs` exists but the filesystem is **ephemeral and per request**, so nothing survives the response | Hard |
| 3 | Re-encodes every image with `sharp` (libvips) | Native binaries do not run in an isolate | Hard |
| 4 | Renders EJS templates read from disk at request time | Templates must be compiled at build time; EJS reads from `fs` and builds functions at runtime | Medium |
| 5 | Extracts text from every page of an uploaded PDF with `pdfjs-dist` | Free plan gives **10 ms CPU per invocation**, and the whole Worker must fit in **3 MB** | Medium |
| 6 | `BEGIN` / `COMMIT` around multi-statement writes | D1 has no interactive transactions, only batches | Medium |
| 7 | Sends mail over SMTP with `node:net` and `node:tls` | Workers have `connect()` from `cloudflare:sockets`; port 25 is blocked but **587 and 465 work** | Low |
| 8 | `scryptSync` for password hashing | `node:crypto` scrypt **is supported** with `nodejs_compat` | None |
| 9 | SIGTERM drain, single writer, Litestream replication | Meaningless on Workers; D1 handles durability | Low, delete |

Items 8 and 9 are listed so the table is the whole picture rather than only the
bad news. Item 1 is the one that decides everything: without a database the
other twenty-nine routes have nothing to render.

## The three routes

### Option A — Cloudflare Containers

**Cost: $5/month.** Workers Paid, which includes 25 GiB-hours of memory,
375 vCPU-minutes and 200 GB-hours of disk per month.

Cloudflare Containers runs an actual Docker image on their network. The app goes
in essentially unchanged: Node 24, `node:sqlite`, `sharp`, Express, the lot.

- **Changes to the code:** a Dockerfile, and a volume or R2 sync for `data/`.
  Nothing else. The SQLite file, the uploads directory, and the image pipeline
  all keep working.
- **What you gain:** Cloudflare's network, DNS, TLS, and WAF in front of the same
  application you have now, with no rewrite and no behaviour to re-verify.
- **What you lose:** it is not free, and containers sleep when idle, so the
  first request after a quiet period pays a cold start.
- **Honest comparison:** the Oracle Always Free ARM instance this was designed
  for is $0 and does not sleep. $5/month buys you a better network and one less
  machine to patch. It does not buy you a capability you are missing.

### Option B — Full port to Workers, D1, and R2

**Cost: $0 within the free limits.** D1 gives 5 GB of storage and 5 M row reads
a day, R2 gives 10 GB and 10 M reads a month with no egress charge, and Workers
gives 100 K requests a day. A portfolio does not come close to any of those.

#### What it actually is

Right now there is one process on one machine holding one SQLite file and one
uploads directory. A Worker is not a machine: it is a function that runs in a
V8 isolate near whoever asked, with no disk, no long-lived memory, and a CPU
budget per request. So the port is not "move the files" — it is "take the two
things that were on the disk and put them behind network APIs":

| Today | After |
|---|---|
| `data/third-angle.db`, one SQLite file | **D1**, Cloudflare's SQLite, reached through a binding |
| `data/uploads/`, files on disk | **R2**, an object store, reached through a binding |
| `node server.js`, always running | A Worker, cold-started per request, no state between them |
| `npm start` | `wrangler deploy`, and `wrangler dev` locally |

Everything else — the routes, the templates, the search, the admin, the content
editor, the motion layer — is ordinary code that does not care where it runs.

#### What changes, file by file

- **`src/db.js`** is the whole driver, and it is the file that changes most.
  `DatabaseSync` becomes the D1 binding, and every call becomes `await`, which
  ripples: `get`, `all`, and `run` are synchronous today and every caller
  assumes that. This is the single largest mechanical edit in the port.
- **`src/repo.js`**, 790 lines and every query in the project, changes shape but
  not content: the SQL is the same, the functions become `async`. This is the
  part the project was designed for — nothing above `repo.js` knows what the
  database is.
- **`db.transaction()`** becomes `D1.batch()`. This is a real change rather than
  a rename: the current helper wraps an arbitrary function body, and a batch is
  a fixed list of statements decided in advance. The three places that use it
  (project reorder, document ingest, media delete) each need rewriting so the
  statements are known up front.
- **`src/media.js`** and **`src/routes/media.js`** write and read R2 instead of
  the filesystem. `/media/:key` becomes an R2 `get`, or a public bucket domain,
  which the existing comments already anticipate.
- **`src/documents.js`** stores PDFs in R2 the same way.
- **EJS templates** are compiled at build time into the bundle. EJS reads from
  `fs` and builds functions at runtime today; a Worker has neither.
- **`src/mailer.js`** swaps `node:net`/`node:tls` for `connect()` from
  `cloudflare:sockets`. Ports 587 and 465 both work; the protocol code is
  unchanged.
- **`server.js`** becomes a Worker entry point. Express does not run on Workers
  as-is, so this is either Hono (an Express-shaped router that does) or a small
  hand-written router over the ~30 routes.

#### The two things that genuinely do not come

**1. `sharp`.** It is a native binary and there is no version of it that runs in
an isolate. Today every upload is decoded, resized to five widths, re-encoded
to WebP, and stripped of metadata. That is not a convenience: re-encoding is
what guarantees an uploaded file is actually an image and not a payload with an
image's extension, and what removes the GPS coordinates a phone puts in a
photograph. Three replacements, in order of how much they preserve:

- **Cloudflare Images**, $5/month for 100 K images: keeps the resizing and the
  variants, and is the closest to what exists.
- **Resize in the browser before upload**, free: a canvas re-encode in the admin
  page. It works, and it is not the same guarantee, because the check now
  happens on the client where it can be skipped.
- **Store the original and resize on read** with Workers' image resizing.

**2. PDF text extraction.** `pdfjs` extracting 400 pages does not fit in a
Worker invocation on the free plan. It moves to a Queue consumer (also free at
this volume) so the upload returns immediately and the pages are indexed a few
seconds later, or it runs locally before upload. The full text search over
documents is one of the better things on the site, so this is worth keeping
rather than dropping.

#### What the day-to-day becomes

- **Deploying** is `wrangler deploy` instead of `git pull && systemctl restart`.
  Faster, and no machine to patch.
- **Editing content** is unchanged: the admin still writes to the database, and
  the database is now D1. Nothing about the content editor, the photo wall, or
  the education record changes for the person using them.
- **Backups** change the most. Today the whole site is one SQLite file you can
  copy, and `RESTORE.md` is a rehearsed restore of that file. D1 has Time Travel
  (any point in the last 30 days) and R2 has versioning, which is a good story
  but a different one, and `RESTORE.md` would have to be rewritten and
  re-rehearsed against it.
- **Running it on a laptop** still works: `wrangler dev` gives local D1 and R2,
  but it is a Cloudflare-shaped local environment rather than plain Node.

#### The honest risks

- **The async ripple is the whole job.** Turning ~790 lines of synchronous
  queries into promises touches every route and every test. It is mechanical
  rather than difficult, and mechanical work at that volume is where quiet bugs
  come from: a missing `await` returns a promise that renders as `[object
  Promise]` or, worse, silently skips a write.
- **Test suite.** 212 tests run against a real SQLite file in milliseconds.
  Against D1 they need either `wrangler`'s local D1 (slower, and a different
  process) or a fake. That is a day's work on its own and it is not optional:
  those tests are what makes the rest of it safe to change.
- **CPU limits.** 10 ms per invocation on the free plan is generous for
  rendering a page and tight for anything that loops over a large result. The
  search path is three queries and a sort, so it fits, but it has never been
  measured under that ceiling.
- **You are on Cloudflare now.** D1 and R2 have no drop-in equivalents
  elsewhere; moving away later is another port of the same size.

#### Rough effort

Two to four days of focused work, most of it in `db.js`, `repo.js`, and the
tests, plus a decision on images. The site's behaviour should not change at
all, which is exactly what makes it tedious: the whole job is to get back to
where you already are, on somebody else's computer, for free.

### Option C — Split: static shell on Pages, dynamic app elsewhere

**Cost: $0 on Cloudflare, plus whatever hosts the app.**

Pages serves the public read-only pages as pre-rendered HTML, and the parts that
need a server (admin, contact, search, media) stay on a small origin, which is
the Oracle box you already planned for.

- **What you gain:** the public site becomes static and very fast, and the
  origin only ever sees admin traffic.
- **What you lose:** search and the document library are dynamic, so they either
  stay on the origin or become a client-side index. Every publish needs a build
  and deploy step, which is exactly the thing the admin panel exists to avoid,
  and which the README calls out as the reason a static site was ruled out.
- **Honest note:** this reintroduces the problem the project was built to
  solve. I would not recommend it.

## What I would do

**Option A, if the $5 is acceptable.** It preserves every property the project
was designed around, including the ones that are security controls, and it is a
Dockerfile rather than a rewrite. The design decisions in `DESIGN.md` were made
for a machine with a disk, and Option A is the only route that keeps that true.

**Option B, if free is the requirement.** It genuinely works and stays inside
the free tier at this traffic. Go in knowing you are trading the upload
re-encode and the rehearsed single-file restore for it, and that the port is
days of work rather than hours.

**Not Option C.** It gives back the reason this is not a static site.

## What is already portable

Worth knowing, whichever route you take. The following need no changes at all:

- Every query is a named function in `src/repo.js`, so the driver is one file.
- Nothing outside `public/css/tokens.css` defines a colour.
- The renderers are pure functions in `src/markup.js`.
- Password hashing, TOTP, and CSRF use `node:crypto`, which Workers supports.
- The mailer talks to a relay on 587 or 465, both of which Workers permit; only
  the socket call itself changes.
- There is no client-side JavaScript to port, because there is none.

Sources: [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/),
[node:sqlite in workerd](https://github.com/cloudflare/workerd/issues/6878),
[node:fs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/),
[Containers pricing](https://developers.cloudflare.com/containers/pricing/).
