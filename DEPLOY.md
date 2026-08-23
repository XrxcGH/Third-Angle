# Deploying Third Angle on Cloudflare Containers

Route A from [CLOUDFLARE.md](CLOUDFLARE.md): the same Node process that runs on
a laptop, in a container, with a Worker in front of it. Nothing is ported and
nothing behaves differently in production, which is the whole reason for
choosing it.

Read [SECURITY.md](SECURITY.md) before the first deploy. Two of the steps below
are there because of it.

## What you need

- A Cloudflare account on the **Workers Paid** plan, $5 a month.
- A domain, added to that account as a zone.
- Docker running locally. Wrangler builds the image on your machine and pushes
  it to Cloudflare's registry; there is no remote build.
- Node 24 or newer.

## The shape of it

```
  visitor
     |
     v
  Worker  (worker/index.js)         routing, TLS, cache, WAF
     |
     v
  Container  (Dockerfile)           the Express app, unchanged
     |
     +--> /data   SQLite + uploads, on the container's own disk
     |
     v
  R2 bucket                         where /data is mirrored
```

The container's disk is **ephemeral**. It goes back to the image every time the
container sleeps, which it does after fifteen minutes with no traffic. So
`src/backup.js` pulls `/data` down from R2 before the database is opened, and
pushes it back on a timer and once more on SIGTERM. Everything else about the
app is the same as it is on a machine with a disk.

There is exactly one container instance, always. The site is a single SQLite
file; two instances would be two writers against two copies of it.

## Steps

### 1. Create the R2 bucket

```sh
npx wrangler r2 bucket create third-angle
```

Then make an R2 API token: Cloudflare dashboard, **R2 → Manage API tokens →
Create API token**, permission **Object Read & Write**, scoped to that bucket.
Keep the access key id and the secret; the secret is shown once.

### 2. Set the secrets

These are the container's environment. `SESSION_SECRET` and `SITE_URL` are both
checked at boot and the app refuses to start without them in production, which
is deliberate: see `assertEnvironment` in `src/db.js`.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SESSION_SECRET

npx wrangler secret put SESSION_SECRET
npx wrangler secret put SITE_URL                 # https://your-domain.example, no trailing slash
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_BUCKET                # third-angle
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put GITHUB_TOKEN             # optional, raises the API rate limit
```

`SITE_URL` is not cosmetic. Every absolute URL on the site derives from it: the
canonical link, `og:url`, every `<loc>` in the sitemap, the Sitemap line in
robots.txt, both feeds, and the Contact line in security.txt. None of them
appear in the browser, so getting it wrong looks perfect and publishes a
sitemap full of the wrong domain. The boot check refuses `example.com`,
`localhost`, and anything that is not `https://`.

### 3. Seed the first database

The bucket starts empty, so the first boot has nothing to restore and would
serve an empty site. Build the database locally and upload it once:

```sh
npm ci
npm run seed          # projects, disciplines, and the copy
npm run seed:pages
npm run seed:edu
node scripts/create-admin.js you@example.com "Your Name"

npx wrangler r2 object put third-angle/third-angle/db/third-angle.db \
  --file data/third-angle.db --remote
```

Uploads (images, the resume and CV PDFs) go under
`third-angle/uploads/<the path under data/uploads>`. If there are none yet,
skip it. Anything uploaded through the admin afterwards is pushed up on the
next snapshot.

### 4. Deploy

```sh
npx wrangler deploy
```

Wrangler builds the image, pushes it, and rolls out the Worker. The first
request after that pays a cold start while the container boots and restores.

### 5. Point the domain at it

Dashboard: **Workers & Pages → third-angle → Settings → Domains & Routes → Add
custom domain**. Cloudflare issues the certificate. `SITE_URL` must match
exactly what you add here.

### 6. Close the two things the security review left open

Neither is in the source; both are things only you can do.

1. **Sign in and replace the temporary password.** The admin refuses to show you
   anything except the account page until you do, because a hand-over credential is
   one that has been transmitted somewhere and it is exempt from the twelve
   character floor a chosen password has to clear.
2. **Turn on two factor authentication** while you are on that page. Enrolment
   is two steps on purpose: the secret is stored unconfirmed until you prove a
   code works, so a QR code that never reached an authenticator cannot lock you
   out.

## Afterwards

**Watching it.** `npx wrangler tail` streams the Worker and container logs.
`restore:` and `final snapshot:` lines are printed on every boot and every
sleep, and they are what tell you persistence is working.

**Checking the backup is real.** The only backup that counts is one you have
restored from. `npx wrangler r2 object get third-angle/third-angle/db/third-angle.db --file /tmp/check.db --remote`,
then open it locally and confirm the row counts. Do this once now and once a
quarter; see [RESTORE.md](RESTORE.md) for the drill.

**Cost.** The $5 plan includes 25 GiB-hours of memory a month. At the `basic`
instance type, 1 GiB, that is about 25 hours of the container actually being
awake, so the sleep timer is not an optimisation, it is the plan. Traffic
beyond the included allowance is billed per GiB-hour; check the current rate
on Cloudflare's pricing page before assuming a busy month is still $5.

**Rolling back.** `npx wrangler rollback` returns the Worker to its previous
version. The database is not rolled back with it; restore that from R2
separately if a deploy corrupted data, which is what the object versioning on
the bucket is for.

**Changing the instance size.** `instance_type` in `wrangler.jsonc`. Move up to
`standard-1` if an upload of a very large photograph is killed; serving pages
does not need it, `sharp` re-encoding does.
