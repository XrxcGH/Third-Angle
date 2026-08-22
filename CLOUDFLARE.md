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

**Cost: $0 within the free limits.** D1 gives 5 GB and 5 M row reads a day, R2
gives 10 GB and 10 M reads a month, Workers gives 100 K requests a day.

This is a real rewrite of the storage and media layers, and it lands well.

- **Database:** `src/db.js` swaps `node:sqlite` for the D1 binding. This is the
  one place the project was already designed for: every query lives in
  `src/repo.js` as a named function and nothing above it touches the driver.
  **D1 supports FTS5 including `fts5vocab`**, so the three-stage search survives
  intact, which was the part most at risk.
  `db.transaction()` becomes `D1.batch()`, which is a real change: the current
  helper wraps arbitrary function bodies and batches cannot.
- **Uploads:** `data/uploads` becomes an R2 bucket. `src/media.js` and
  `src/routes/media.js` change; `/media/:key` becomes an R2 read or a public
  bucket domain, which the code comments already anticipate.
- **Images:** `sharp` cannot come. Either resize on upload from the browser
  before the bytes are sent, or use Cloudflare Images. This is a genuine loss:
  the current pipeline re-encodes every upload, which is what strips metadata
  and normalises orientation, and that is a security control rather than a
  convenience. Re-encoding in the browser is not the same guarantee.
- **PDF indexing:** extracting 400 pages will not fit in a Worker invocation.
  It moves to a Queue consumer, or to an upload step you run locally.
- **Templates:** EJS precompiled at build time into the bundle.
- **What you lose:** the media re-encode guarantee, the single-file backup story
  in `RESTORE.md`, and the ability to run the whole site on a laptop with
  `npm start` and no cloud account.
- **Effort:** substantial. Roughly the storage layer, the media pipeline, the
  document indexer and the build, with every test that touches them rewritten.

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
