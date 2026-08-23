# Deploying Third Angle

Cloudflare in front, on the free plan, for DNS, TLS, caching and the WAF. The
origin on an Oracle Cloud Always Free machine. No paid plan on either side; the
domain is the only thing with a price on it.

Read [SECURITY.md](SECURITY.md) before the first deploy. Two of the steps below
are there because of it.

## What you need

- A domain, added to a Cloudflare account as a zone, using Cloudflare's
  nameservers.
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

### 1. Provision the machine

```sh
ssh ubuntu@<the instance>
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/XrxcGH/Third-Angle.git /tmp/ta
sudo bash /tmp/ta/deploy/provision.sh
```

It is idempotent, so it is safe to run again after any step below. It installs
Node 24, Caddy, cloudflared and Litestream, creates the `app` user, clones the
source to `/srv/third-angle`, installs every unit file, and closes the
firewall. It prints what is left to do by hand.

### 2. Set SITE_URL

```sh
sudo nano /etc/third-angle/env      # SITE_URL=https://your-domain.example
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
cloudflared tunnel route dns third-angle your-domain.example
cloudflared tunnel route dns third-angle www.your-domain.example
```

Copy `~/.cloudflared/<ID>.json` to `/etc/cloudflared/` on the origin, then edit
`/etc/cloudflared/config.yml`: replace `TUNNEL_ID` in both places and
`example.com` in both hostnames.

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
`www.your-domain.example`, dynamic redirect to
`concat("https://your-domain.example", http.request.uri.path)`, status 301.
This is why the Caddyfile names no domain: the redirect never reaches the
origin.

**Cache rules.** Two of them, and the second one matters more than it looks.

1. Cache `/static/*`, `/media/*` and `/og/*`, Edge TTL **"Use cache-control
   header from origin"**. Those responses are content addressed and already say
   `immutable, max-age=31536000`.
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
The site ships no client-side JavaScript at all — that is a design property, it
is what lets the CSP say `script-src 'self'` with nothing else in it, and it is
stated on /attributions. Turning any of these on makes that untrue. Use a WAF
rule instead of Bot Fight Mode if bots become a problem.

**One rate limiting rule**, which is all the free plan gives, so spend it on the
sign in form: `http.request.uri.path eq "/admin/login"` and
`http.request.method eq "POST"`, 5 requests per 10 minutes per IP, action
Managed Challenge. The app rate limits this too; this stops the traffic a step
earlier and off the origin entirely.

**The free managed ruleset**, under Security → WAF → Managed rules. On.

### 5. Create the admin account

```sh
cd /srv/third-angle
sudo -u app npm run admin -- you@your-domain.example "Your Name" "a long passphrase"
```

Then enrol TOTP with the printed `otpauth://` URI and confirm it:

```sh
sudo -u app npm run admin -- --confirm you@your-domain.example 123456
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

The machine has a real disk, so unlike the container route the database
survives a reboot on its own. Replication is for the other failure: Oracle
changing the free tier again, or closing the account. That has happened once
already — see the note in `costs.yml`.

Put the R2 credentials in `/etc/third-angle/env`, then:

```sh
sudo systemctl enable --now litestream
sudo systemctl enable --now litestream-alive.timer
```

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
and `/var/log/caddy/third-angle.log`. The tunnel answers on
`127.0.0.1:2100/metrics`, and the liveness timer scrapes it: a dead tunnel stops
answering and the missing answer is what alerts, where tailing a log would not
catch the process simply being gone.

**Deploying a change.**

```sh
cd /srv/third-angle
sudo -u app git pull --ff-only
sudo -u app npm ci --omit=dev
sudo systemctl restart third-angle
```

Caddy holds connections for up to five seconds while the new process comes up,
so a restart is invisible from outside.

**Cost.** Nothing here has a bill attached. The one number to re-read is in
`costs.yml`, which `npm run check:costs` fails on when it goes stale.

## The other route

[DEPLOY-containers.md](DEPLOY-containers.md) is the Cloudflare Containers
version of this, which needs the $5/month Workers Paid plan. Its files —
`Dockerfile`, `worker/index.js`, `wrangler.jsonc`, `src/backup.js` — are still
in the tree and still work. Nothing in this document uses them.
