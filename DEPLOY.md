# Deploying Third Angle

Cloudflare in front, on the free plan, for DNS, TLS, caching and the WAF. The
origin on an Oracle Cloud Always Free machine. No paid plan on either side; the
domain is the only thing with a price on it.

Read [SECURITY.md](SECURITY.md) before the first deploy. Two of the steps below
are there because of it.

## What you need

- **ericjdean.com**, registered at Squarespace Domains, with its nameservers
  pointed at Cloudflare. See step 0.
- A Cloudflare account, free plan.
- An Oracle Cloud account, and one **VM.Standard.A1.Flex** instance, arm64,
  Ubuntu 24.04. The Always Free shape is 2 OCPU and 12 GB as of June 2026.
- SSH to that machine.

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

1. In Cloudflare, **Add a site**, enter `ericjdean.com`, choose the **Free**
   plan. Cloudflare scans the existing records and shows you two nameservers,
   something like `xxx.ns.cloudflare.com`.
2. In Squarespace: **Domains → ericjdean.com → DNS → Nameservers**, switch from
   Squarespace's defaults to **Custom nameservers**, and enter exactly those
   two. Remove any others.
3. Wait for Cloudflare to report the zone **Active**. Usually minutes; the
   registrar is allowed to take up to 48 hours.

Do this first. The tunnel step below creates DNS records through the Cloudflare
API, and it cannot until Cloudflare is authoritative for the zone.

Squarespace will keep trying to sell you a site on this domain. Ignore it: it
serves nothing here, and the parking page disappears the moment the nameservers
change.

### 1. Provision the machine

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

### 2. Set SITE_URL

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

### 3. Open the tunnel

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

### 4. Set the zone up

Everything here is on the free plan. **SSL/TLS → Overview → Full (strict)**,
and **Edge Certificates → Always Use HTTPS on**, **Minimum TLS 1.2**.

**A redirect rule, www to apex.** Rules → Redirect Rules. Hostname equals
`www.ericjdean.com`, dynamic redirect to
`concat("https://ericjdean.com", http.request.uri.path)`, status 301.
This is why the Caddyfile names no domain: the redirect never reaches the
origin.

**Cache rules.** Two of them, and the second one matters more than it looks.

1. Cache `/static/*`, `/media/*` and `/og/*`, Edge TTL **"Use cache-control
   header from origin"**. The `/media/*` and `/og/*` responses are content addressed;
   `/static/*` is not, so a stylesheet or font edit needs a cache purge. All
   three already say `public, max-age=31536000, immutable` in production.
2. Bypass cache for `/admin*`.

Do **not** add a "Cache Everything" rule with an Edge TTL that ignores origin
headers. Every HTML page on this site says `Cache-Control: private`, and it
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

### 5. Create the admin account

```sh
cd /srv/third-angle
sudo -u app npm run admin -- you@ericjdean.com "Eric J. Dean" "a long passphrase"
```

Then enrol TOTP with the printed `otpauth://` URI and confirm it:

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

### 6. Turn on replication

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

### 7. Run the restore drill

An unrehearsed backup is a belief, not a backup.

```sh
sudo third-angle-verify
```

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
