# Deploying Third Angle

Cloudflare in front, on the free plan, for DNS, TLS, caching and the WAF. The
origin on an Oracle Cloud Always Free machine. No paid plan on either side; the
domain is the only thing with a price on it.

Read [SECURITY.md](SECURITY.md) before the first deploy. Two of the steps below
are there because of it.

## What you need

- **ericjdean.com**, registered at Squarespace Domains. Its nameservers move to
  Cloudflare in step 0.
- A Cloudflare account, free plan.
- An Oracle Cloud account. The machine itself is step 1.
- An SSH keypair. If you do not have one:

  ```sh
  ssh-keygen -t ed25519 -C "ericjdean.com deploy"
  ```

  Take the default path, set a passphrase. The **public** half — the file ending
  `.pub` — is what Oracle asks for. The other file never leaves your machine and
  never goes in the repository.

## The shape of it

```
  visitor
     |
     v
  Cloudflare edge          DNS, TLS, cache, WAF, rate limiting     free plan
     |
     |  outbound tunnel, opened FROM the origin
     v
  cloudflared              deploy/cloudflared.yml
     |
     v
  Caddy 127.0.0.1:8080     deploy/Caddyfile
     |
     v
  Node  127.0.0.1:3000     the app, on a disk that persists
     |
     +--> data/            SQLite + uploads
     |
     v
  R2 bucket                continuous replication, via Litestream
```

Nothing on that machine listens on the public internet. The tunnel dials out,
Caddy is bound to loopback, and the firewall allows SSH and nothing else. The
origin has no A record and its address is not published anywhere, so finding
the IP does not help: there is no port to knock on and no way to skip the WAF.

Caddy is still in the middle for the one thing Cloudflare cannot do — hold a
connection open across a `systemctl restart` and serve a real page instead of a
502 when Node is genuinely down.

Two processes must never run against one SQLite file, so there is one instance
of the app and no blue/green. See DESIGN.md risk R6.

## Steps

### 0. Move DNS to Cloudflare

The domain is registered at Squarespace, and it stays there. What has to move is
the **DNS**, because everything in this document depends on Cloudflare answering
for the zone: the tunnel creates proxied CNAME records, the WAF and the cache
rules only apply to traffic Cloudflare receives, and Email Routing requires
Cloudflare nameservers. A domain that merely points an A record at Cloudflare
gets none of it.

1. **Turn DNSSEC off at Squarespace first**, under the domain's security or
   advanced settings, if it is on. This is the one step here that can take the
   domain completely off the internet rather than merely leaving it unreachable.
   DNSSEC signs the answers a nameserver gives; the registry holds a DS record
   saying which key to trust. Move the nameservers without clearing it and every
   resolver gets an answer signed by Cloudflare's key, checks it against
   Squarespace's, finds a mismatch, and returns SERVFAIL — which is not "site
   down", it is "this domain does not resolve at all", including its mail.
   Cloudflare's own DNSSEC can be switched on later, once the zone is active.
2. In Cloudflare, **Add a site**, enter `ericjdean.com`, choose the **Free**
   plan. It scans the existing records and shows two nameservers, of the form
   `xxx.ns.cloudflare.com`.
3. **Delete the records it imported**, unless you recognise one. A domain fresh
   from a registrar carries parking records pointing at the registrar's "coming
   soon" page, and carrying those across means Cloudflare faithfully serves
   Squarespace's placeholder. Add nothing by hand: the tunnel creates the records
   it needs in step 4.
4. In Squarespace: **Domains → ericjdean.com → DNS → Nameservers**, switch from
   Squarespace's defaults to **Custom nameservers**, and enter exactly those
   two. Remove any others. Squarespace will warn that its own DNS features stop
   working, which is the point. The registration stays with Squarespace; only
   the answering moves.
5. Wait for Cloudflare to report the zone **Active** — it emails you. Usually
   minutes; the registrar is allowed 48 hours. **Check nameservers now** on the
   Cloudflare overview page prompts it to re-check rather than waiting.

Until the tunnel exists in step 4, the domain will answer with a Cloudflare
error page rather than the site. That is correct: DNS is pointing at Cloudflare
and Cloudflare has nothing behind it yet.

Do this first. The tunnel step below creates DNS records through the Cloudflare
API, and it cannot until Cloudflare is authoritative for the zone.

Squarespace will keep trying to sell you a site on this domain. Ignore it: it
serves nothing here, and the parking page disappears the moment the nameservers
change.

### 1. Create the machine

Oracle's console, not a command. What matters:

| Field | Value | Why |
|---|---|---|
| Region | your **home region** | Always Free resources exist only there. It cannot be changed later. |
| Shape | **VM.Standard.A1.Flex**, Ampere, arm64 | The free one. The x86 micro shapes are too small for the image pipeline. |
| OCPU / memory | **2 / 12 GB** | The whole Always Free A1 allowance as of June 2026. Taking less does not bank it. |
| Image | **Canonical Ubuntu 24.04**, aarch64 build | Node 24 needs a current distribution; the arm64 build must match the shape. |
| Boot volume | 50 GB default is fine | Always Free includes 200 GB of block storage in total. |
| Public IPv4 | **assign one** | The tunnel dials out over it. Nothing dials in. |
| SSH key | paste your public key | Oracle has no password login; without a key you cannot get in at all. |

**Expect "Out of host capacity."** A1 is the most contended shape Oracle sells
and a free-tier account sits at the back of the queue for it. This is the step
that stops people, and it is not a mistake you have made. In order of effort:
try each availability domain in your region; try again at a different hour;
then upgrade the account to Pay As You Go, which keeps every Always Free
resource free but moves you out of the free-tier capacity pool. The upgrade is
what usually works, and it is reversible.

Do not open ports 80 or 443 in the security list. The tunnel makes an outbound
connection, so the only inbound port this machine ever needs is 22, and every
port left open is a way around the WAF. `deploy/provision.sh` closes the host
firewall to match.

### 2. Provision the machine

```sh
ssh ubuntu@<the instance>
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/XrxcGH/Third-Angle.git /tmp/ta
sudo bash /tmp/ta/deploy/provision.sh
```

It is idempotent, so it is safe to run again after any step below. It installs
Node 24, Caddy, cloudflared and Litestream, creates the `app` user, clones the
source to `/srv/third-angle`, installs the `third-angle`, `cloudflared`,
`third-angle-backup` and `litestream-alive` units, and closes the firewall. It
prints what is left to do by hand.

### 3. Set SITE_URL

```sh
sudo nano /etc/third-angle/env      # SITE_URL=https://ericjdean.com
sudo systemctl restart third-angle
```

`SITE_URL` is not cosmetic. Every absolute URL on the site derives from it: the
canonical link, `og:url`, every `<loc>` in the sitemap, the Sitemap line in
robots.txt, both feeds, and the Contact line in security.txt. None of them are
visible in a browser, so getting it wrong looks perfect and publishes a sitemap
full of the wrong domain to every crawler that asks. The boot check refuses
`example.com`, `localhost` and anything that is not `https://`.

### 4. Open the tunnel

On any machine signed in to the Cloudflare account:

```sh
cloudflared tunnel login
cloudflared tunnel create third-angle              # prints the tunnel's ID
cloudflared tunnel route dns third-angle ericjdean.com
cloudflared tunnel route dns third-angle www.ericjdean.com
```

Copy `~/.cloudflared/<ID>.json` to `/etc/cloudflared/` on the origin, then edit
`/etc/cloudflared/config.yml` and replace `TUNNEL_ID` in both places. The
hostnames are already `ericjdean.com` and `www.ericjdean.com`.

```sh
sudo chown root:cloudflared /etc/cloudflared/<ID>.json
sudo chmod 640 /etc/cloudflared/<ID>.json
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

`cloudflared tunnel route dns` creates the DNS records for you, already
proxied. The site should answer on the domain at this point.

### 5. Set the zone up

Everything here is on the free plan. **SSL/TLS → Overview → Full (strict)**,
and **Edge Certificates → Always Use HTTPS on**, **Minimum TLS 1.2**.

**A redirect rule, www to apex.** Rules → Redirect Rules → Create Single
Redirect. The wildcard template does this with no expression to write:

| Field | Value |
| --- | --- |
| Request URL | `https://www.ericjdean.com/*` |
| Target URL | `https://ericjdean.com/${1}` |
| Status code | 301 |
| Preserve query string | on |
| Redirect POST requests | off |

The `*` captures the path and `${1}` puts it back, so `www.ericjdean.com/projects`
arrives at `ericjdean.com/projects` rather than at the home page.

Leave POST redirects off. A 301 turns a POST into a GET, which would matter if a
form were ever served from `www` -- but this rule is what stops that happening,
so nothing on `www` ever renders a form to submit.

The older custom filter expression still works if you prefer it: hostname equals
`www.ericjdean.com`, dynamic target `concat("https://ericjdean.com", http.request.uri.path)`.

This is why the Caddyfile names no domain: the redirect never reaches the
origin.

**Cache rules.** Two of them, and the second one matters more than it looks.

Both want a custom filter expression. Use "Edit expression" and paste these
rather than fighting the field/operator/value builder, which takes one path at a
time.

1. **Static assets.** Cache eligibility **Eligible for cache**, Edge TTL **"Use
   cache-control header from origin"**, everything else left alone.

   ```
   starts_with(http.request.uri.path, "/static/") or starts_with(http.request.uri.path, "/media/") or starts_with(http.request.uri.path, "/og/")
   ```

   The `/media/*` and `/og/*` responses are content addressed; `/static/*` is
   not, so a stylesheet or font edit needs a cache purge. All three already say
   `public, max-age=31536000, immutable` in production, and `publicAsset()` in
   `src/middleware.js` strips `Vary` from them so the edge will actually store
   them -- the free plan only varies on `Accept-Encoding`.

2. **Bypass the admin.** Cache eligibility **Bypass cache**.

   ```
   starts_with(http.request.uri.path, "/admin")
   ```

Put the bypass rule first. The two expressions do not overlap, so order is not
load bearing today, but a rule that protects something belongs above the rules
it protects it from.

Do **not** use the **Cache everything** template the dashboard offers at the top
of the New Cache Rule page, or any Edge TTL that ignores origin headers. Every HTML page on this site says `Cache-Control: private`, and it
means it: the theme is a cookie the server reads to emit
`<html data-theme="dark">` in the first byte, so one stored copy of the home
page serves one visitor's theme to the next person behind it. The admin renders
against a session. An Edge TTL override is the one setting in the dashboard
that can turn that into a real leak.

**Three toggles that must stay off**, because each injects JavaScript into the
page: **Rocket Loader**, **Email Address Obfuscation**, and **Bot Fight Mode**.
No public page ships executable JavaScript — the only `<script>` on any of them
is an `application/ld+json` block, which is data. That is a design property, and
it is what lets the CSP say `script-src 'self'` with nothing else in it. Each of
these three toggles injects a script into the page and would break the policy
before it broke anything visible. Use a WAF rule instead of Bot Fight Mode if
bots become a problem.

**One rate limiting rule**, which is all the free plan gives, so spend it on the
sign in form: `http.request.uri.path eq "/admin/login"` and
`http.request.method eq "POST"`, 5 requests per 10 minutes per IP, action
Managed Challenge. The app rate limits this too; this stops the traffic a step
earlier and off the origin entirely.

**The free managed ruleset**, under Security → WAF → Managed rules. On.

**Email Routing**, under the Email tab, forwarding to an inbox you read. Two
addresses need to exist: whatever the contact page publishes, and
`security@ericjdean.com` — the site serves an RFC 9116
`/.well-known/security.txt` that names it, and an address published for
reporting vulnerabilities that bounces is worse than not publishing one.

That is mail coming **in**. Mail going out is a separate thing and needs a
relay, because `src/mailer.js` is an SMTP submission client rather than a mail
server: it hands a message to something that already accepts mail for you.

**Brevo**, free plan. Create an account, verify `ericjdean.com` as a sender, and
add the DKIM and SPF records it gives you to this zone — Cloudflare is already
answering for it, so that is three records and a few minutes.

> **One SPF record. Not two.**
>
> Email Routing wants `v=spf1 include:_spf.mx.cloudflare.net ~all` and Brevo
> wants `v=spf1 include:spf.brevo.com ~all`, and a domain is allowed exactly one
> SPF TXT record. Publish both and the result is not "two policies", it is a
> permanent error: every receiver that checks SPF treats the domain as
> misconfigured and the mail is more likely to be junked than if there were no
> SPF at all.
>
> Merge them into a single record at the apex:
>
> ```
> v=spf1 include:spf.brevo.com include:_spf.mx.cloudflare.net ~all
> ```
>
> Whichever service you set up second will tell you to add its own. Edit the
> existing record instead.

Then, in `/etc/third-angle/env`:

```sh
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=       # the LOGIN from Brevo's SMTP & API page, not your Brevo email
SMTP_PASS=       # an SMTP KEY from that page, not your Brevo password
SMTP_FROM=contact@ericjdean.com
```

`SMTP_USER` catches everybody: Brevo's login is a generated address of the form
`9xxxxxx@smtp-brevo.com`, and the address you sign in with does not authenticate.
`SMTP_FROM` has to be a sender Brevo has verified or every send is rejected.

Then `systemctl restart third-angle`, and in the admin under Settings turn
**Forward contact messages by email** on and set **Forward messages to**.

Nothing here is load-bearing for the site. Every message is stored in the admin
inbox first and forwarded second, so a relay that is missing or broken costs a
notification and never a message, and each row has its own retry.

### 6. Create the admin account

```sh
cd /srv/third-angle
sudo -u app npm run admin -- you@ericjdean.com "Eric J. Dean" "a long passphrase"
```

The command prints a base32 secret and an `otpauth://` URI. To enrol, draw the
URI as a QR code in the terminal and scan it with the authenticator app on your
phone:

```sh
qrencode -t ANSIUTF8 'PASTE THE otpauth:// URI HERE IN SINGLE QUOTES'
```

The single quotes matter: the URI contains `?` and `&`, which the shell would
otherwise treat as its own.

**Do not paste that URI into an online QR generator.** It carries the secret in
plain text, and handing it to a website hands over the second factor. `qrencode`
runs locally, which is the whole reason provisioning installs it. If you would
rather not scan anything, every authenticator can take the base32 secret typed
by hand instead: choose "enter a setup key", and the defaults it asks about are
the ones the URI declares -- time based, SHA1, six digits, thirty seconds.

It appears in the app as **Third Angle** with your address underneath.

Then confirm it, which is what makes it required at sign in:

```sh
sudo -u app npm run admin -- --confirm you@ericjdean.com 123456
```

Enrolment is two steps on purpose: the secret is stored unconfirmed until you
prove a code works, so a QR code that never reached an authenticator cannot
lock you out.

If you used `--temp` with a short hand-over password, the admin will show you
nothing except the account page until you replace it. A credential that has
been transmitted somewhere is exempt from the twelve character floor a chosen
password has to clear, and it is not allowed to quietly become the permanent
one.

### 7. Put the content on the box

Provisioning leaves an empty database. The site serves, but every page is bare
and `/healthz` reports `facets=0` instead of `facets=8`. Three seed scripts
rebuild the written content out of the repository:

```sh
cd /srv/third-angle
sudo -u app npm run seed        # projects, disciplines, links, metrics, the now page
sudo -u app npm run seed:pages  # the written pages
sudo -u app npm run seed:edu    # schools, courses, activity
```

Confirm it took:

```sh
curl -fsS localhost:3000/healthz    # ok facets=8
```

They need no `DATA_DIR`: it falls back to a path relative to the source, which
is the same `/srv/third-angle/data` the service reads.

`npm run seed` deletes projects before inserting, and `seed:edu` does the same
for courses and activity. That is what makes them re-runnable while setting a
machine up, and it is equally why they are not something to run casually later:
on a box whose content has been edited since, they discard those edits.

Photographs and documents are not seeded, because they are files rather than
rows -- the database holds the record, `data/uploads` holds the bytes. Add them
through the admin once the tunnel is up: Media for the photo wall, Documents for
the resume and CV. Uploading is also what derives the thumbnails and the PDF
page images, so copying files into `data/uploads` by hand does not work.

Nothing else needs to move. Sessions, login attempts and the audit log belong to
the machine that produced them and deliberately do not travel.

### 8. Turn on replication

The machine has a real disk, so the database survives a reboot on its own. Replication is for the other failure: Oracle
changing the free tier again, or closing the account. That has happened once
already — see the note in `costs.yml`.

Put the R2 credentials in `/etc/third-angle/env`, then:

```sh
sudo systemctl enable --now litestream
sudo systemctl enable --now litestream-alive.timer
```

Then set the three heartbeat URLs in `/etc/third-angle/env`, where the
provisioning script left them commented out. Each script pings its URL on
success and `/fail` on failure, so a **missing** ping is what alerts:

| Variable | Script | Runs |
|---|---|---|
| `BACKUP_HEALTHCHECK_URL` | `third-angle-backup` | nightly |
| `VERIFY_HEALTHCHECK_URL` | `third-angle-verify` | nightly, straight after the snapshot |
| `LITESTREAM_HEALTHCHECK_URL` | `third-angle-alive` | every fifteen minutes |

Without them a backup can fail every night on a machine nobody is watching and
nothing will say so, which is worse than having no backup at all, because this
one is trusted. Healthchecks.io's free tier covers all three.

R2's free tier is 10 GB and this database is a rounding error against it. Any
S3-compatible bucket works, including Oracle Object Storage — but keeping the
backup at the same provider as the machine defeats the point of it, so use the
other account.

### 9. Run the restore drill

An unrehearsed backup is a belief, not a backup.

Run it inside `tmux`, which provisioning installs. This step restores a whole
database and times itself, and it is long enough that an SSH connection dropping
partway would cost you the measurement:

```sh
tmux new -s drill
sudo third-angle-verify
```

If the connection does drop, reconnect and `tmux attach -t drill` returns you to
it still running.

Record the measured time in [RESTORE.md](RESTORE.md).

## Afterwards

**Watching it.** `journalctl -u third-angle -f`, `journalctl -u cloudflared -f`,
and `/var/log/caddy/third-angle.log`. Litestream answers on
`localhost:9090/metrics`, and `litestream-alive.timer` scrapes it every fifteen
minutes: it asserts the replica index has not gone backwards and that the
endpoint still answers, which catches the process simply being gone where
tailing a log would not. The tunnel's own metrics endpoint,
`127.0.0.1:2100/metrics`, is not scraped by anything.

**Deploying a change.**

```sh
cd /srv/third-angle
sudo -u app third-angle-backup            # always first
sudo -u app git pull --ff-only
sudo -u app npm ci --omit=dev
sudo systemctl restart third-angle
npm run smoke -- https://ericjdean.com
```

Caddy holds connections for up to five seconds while the new process comes up,
so a restart is invisible from outside.

The last line is the one that matters. `npm run smoke` goes over the wire
against the deployed site and checks that every public page answers, that every
admin address still redirects a signed-out visitor to the sign in screen, and
that the security and cache headers are on the response. It catches what the
test suite cannot see, because the suite runs in process against a database it
controls: a proxy that did not reload, a tunnel pointing at the wrong port, an
origin serving a stale build, a cache rule that strips a header. It exits
non-zero, so it can be the last line of a deploy and mean something.

Schema changes apply themselves on start. New tables are created when missing
and new columns are added by the migration helper in `src/db.js`. Nothing is
ever dropped or rewritten automatically, which is what makes the rollback below
safe: returning the code does not destroy data written by the newer version.

**Rolling back.** If the smoke check fails and the cause is not obvious in a
minute, go back first and diagnose afterwards.

```sh
cd /srv/third-angle
sudo -u app git log --oneline -5          # find the commit that was working
sudo -u app git checkout <that commit>
sudo -u app npm ci --omit=dev
sudo systemctl restart third-angle
npm run smoke -- https://ericjdean.com
```

That returns the code and nothing else. If the deploy also corrupted data,
restoring is a separate operation and [RESTORE.md](RESTORE.md) is the runbook
for it: the database is not rolled back by checking out an older commit, and
you would not want it to be, because the two failures are rarely the same
failure.

To come back to the branch afterwards, `sudo -u app git checkout main`.

**Cost.** Nothing here has a bill attached. The one number to re-read is in
`costs.yml`, which `npm run check:costs` fails on when it goes stale.

## Why the origin is a machine

Worth writing down, because "put it on Workers and stop paying for a server" is
a reasonable thing to suggest and the answer is not obvious.

Workers are V8 isolates, not machines. This application opens a SQLite file
with `node:sqlite`, writes uploads to a directory and reads them back, and
re-encodes every image with `sharp`, which is a native binary. None of those
three has an equivalent in an isolate: the database becomes D1 and every query
becomes `await`, the uploads become R2, and the re-encode has to move to a paid
image service or into the browser.

That re-encode is not a convenience. It is what proves an uploaded file is
actually an image rather than a payload wearing an image's extension, and it is
what strips the GPS coordinates a phone writes into a photograph.

The machine costs nothing and does all of it today. Cloudflare is in front,
where it is very good and also free.
