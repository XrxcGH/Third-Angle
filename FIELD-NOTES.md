# Field notes

Everything that went wrong bringing this stack up on a real machine, what
caused it, and what fixed it. [DEPLOY.md](DEPLOY.md) is the procedure and
already has the fixes folded in; this is the reasoning behind them, written for
the next deployment rather than for this one.

Most entries are not about this site. They are about Oracle Cloud, Cloudflare
Tunnel, systemd, and a minimized Ubuntu image, so they transfer to anything
else put on the same stack.

Read the last section first if you are short of time. It is the five rules the
rest of this document is evidence for.

---

## Oracle: the account

**"Out of host capacity for shape VM.Standard.A1.Flex."**

A1 is the most contended shape Oracle sells and the error is a queue, not a
verdict. Two things move it:

- **Upgrade the tenancy to Pay As You Go.** Free Tier tenancies compete for the
  same Always Free capacity and lose. Always Free resources stay free on a Pay
  As You Go account, so the upgrade costs nothing by itself.
- **Check how many availability domains your region has.** Some regions offer
  one. Advice that says "try another AD" does not apply there, and a region
  with three is worth choosing at signup for this reason alone.

Pay As You Go also stops the other Free Tier behaviour worth knowing about:
idle Always Free compute can be reclaimed on a Free Tier tenancy and cannot on
a paid one.

**What Pay As You Go costs you.** Anything outside the Always Free allowance now
bills to a card instead of failing to launch. Note what an OCI *budget* is
before relying on one: it is **alert only** and never caps spend, whatever the
name suggests. The only hard stop is a **compartment quota policy**. Set one if
you want a ceiling; otherwise the allowance is enforced by not exceeding it.

## Oracle: networking

**The "assign a public IPv4 address" checkbox is greyed out.**

The instance creation form lets you make a VCN inline, and the VCN it makes has
no Internet Gateway. Without one there is nothing for a public address to route
through, so the checkbox disables itself rather than explaining.

Use the **VCN Wizard** ("VCN with Internet Connectivity") *before* creating the
instance, and pick that VCN in the instance form.

**SSH times out even though the security list allows port 22.**

Same cause, later symptom. A security list is a firewall rule; it does not
create a route. If the VCN was made inline, it has:

- no Internet Gateway, and
- no `0.0.0.0/0` route rule in its route table

Both are needed. Add the gateway first — the route rule form will not let you
select a target that does not exist yet, which is why the "Add Route Rules"
button appears dead.

Worth knowing the layers, because three separate things can each silently block
inbound SSH: the **Internet Gateway** (does traffic have a way in), the **route
table** (does the subnet know to use it), and the **security list** (is the port
allowed). All three must agree, and only the third produces an obvious form to
fill in.

## Moving DNS to Cloudflare

**The domain still shows the registrar's parking page after the nameservers
change.** Propagation, plus the registrar's own resolver caching. Check with a
resolver you did not just talk to, and remember your own machine caches too.

**Success looks like NXDOMAIN, not an error page.** Once Cloudflare is
authoritative and the zone has no records, the correct answer for the apex is
NXDOMAIN. That is the zone working. A Cloudflare **1016** means a record exists
and points nowhere, which is a different and later problem.

**Turn DNSSEC off at the old registrar before moving.** A DNSSEC record that
still validates against nameservers that no longer serve the zone takes the
domain down hard, and the failure looks like a total outage rather than a
configuration error.

## Writing a provisioning script that cannot half-finish

Two separate failures, one cause.

**`git clone` cannot work if the data directory lives inside the app
directory.**

```
==> Source
fatal: destination path '/srv/third-angle' already exists and is not an empty directory.
```

`DATA_DIR` was `$APP_DIR/data`, and the step above Source created
`$DATA_DIR/uploads`. So `$APP_DIR` always contained `data/` by the time Source
ran, and clone refuses a non-empty directory. This was deterministic — the
script could never have completed a first run on any machine.

Use `init` + `fetch` + `checkout` instead. It does the same work with no
constraint on what the directory already holds, and it makes the step
re-runnable over a box left half-provisioned by an earlier failure, rather than
demanding an `rm -rf` of a directory that by then holds uploads.

**A pinned download URL rotted, and `set -e` took the whole run down with it.**

Litestream's git tag is `v0.5.16` but its release asset is
`litestream-0.5.16-linux-arm64.deb` — no `v`. The pinned URL 404'd, and under
`set -euo pipefail` everything after that step never ran: the app user, the
source clone, `npm ci`, the env file, every unit, `systemctl enable`, the
firewall. The only symptom was one `curl` line, on a machine that then looked
provisioned.

Two fixes, and the second matters more:

- **Try both spellings** rather than trusting one. Asset naming moves.
- **Decide, per step, whether failure should be fatal.** Litestream is off-site
  replication, not the site. A machine that serves nothing is worse than one
  that serves without a replica. The failure now sets a flag, provisioning
  continues, and a loud block prints at the end next to the remaining manual
  steps.

The same reasoning applied to `npm run fonts`, which reaches
`fonts.googleapis.com` and `process.exit(1)`s — one transient 503 away from
aborting everything after it. Losing webfonts costs typography, not the site,
because every stack in the CSS names real fallbacks. `npm ci` stayed fatal: no
`node_modules`, no site.

> **The rule.** Under `set -e`, every non-essential step is a single point of
> failure for every step after it. Decide fatality deliberately, per step, and
> make the non-fatal ones shout at the end where the output will not scroll past.

## The machine provisions empty

The site served, and `/healthz` reported `facets=0` instead of `facets=8`.
Nothing was broken: provisioning creates an empty database. But nothing in the
procedure said so, so it ran to its last step and handed over a bare site with
no indication a step was missing.

Two things worth separating for any similar project:

- **Text content** can be rebuilt from seed scripts in the repository, so it
  costs one command per script and needs no transfer.
- **Binaries — images, PDFs — cannot.** They are files, not rows: the database
  holds the record and the uploads directory holds the bytes. They go through
  the application's own upload path, which is also what derives thumbnails and
  page images, so copying files onto the box does not work.

Operational data — sessions, login attempts, audit log — belongs to the machine
that produced it and should not travel at all.

## The image is minimized

Oracle's Ubuntu image says so at login and it is not decoration. Missing, and
each one found the hard way:

| Missing | Wanted for |
|---|---|
| `tmux` | the restore drill, and any step long enough that a dropped connection costs it |
| `nano` | hand-editing the env file |
| `dig` | checking DNS from the box |

`tmux` and `nano` are now installed by provisioning. `dig` is not, because
`curl` against DNS-over-HTTPS answers the same question without a package:

```sh
curl -s -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=example.com&type=TXT' \
  | python3 -c 'import sys,json;[print(a["data"]) for a in json.load(sys.stdin).get("Answer",[])]'
```

Parse that with `python3`, not `grep`. TXT records contain escaped quotes and a
naive pattern returns fragments that look like a DNS failure but are a parsing
failure.

## Working over SSH

**`ssh -i` takes a path to the private key file, not the key.** The public key
text — `ssh-ed25519 AAAA…` — is not what the flag wants. The private key is the
same filename without `.pub`.

**Idle connections get reset.** A connection can die while you read
documentation, and the next keystroke reports
`client_loop: send disconnect: Connection reset`. The command you just typed
never reached the machine. Put this in the client's `~/.ssh/config`:

```
Host <name>
  HostName <ip>
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
  ServerAliveCountMax 6
```

And run anything long inside `tmux`, so a drop costs the connection rather than
the work.

**Diagnose the disconnect before assuming the network.** A dropped session
during a memory-hard operation looks like an OOM kill. Check rather than guess:

```sh
uptime                  # did it reboot
free -h                 # is memory actually tight
sudo journalctl -k --since "-2h" | grep -iE "oom|killed process"
```

Here it was the network every time — no reboot, 5.3 GiB free of 5.8, no OOM.

## systemd environment files

This cost more time than anything else in the deployment, in two distinct ways.

**A silent editing failure looks exactly like a configuration failure.**

Four rounds of edit-and-restart went by against a file that never changed. The
editor's save keystroke was wrong, so nothing was written; systemd restarted
perfectly every time; and no log anywhere said the file was unchanged, because
from systemd's point of view nothing had gone wrong.

Verify the file, not the restart. These print names only, never values:

```sh
# what the running service actually received
sudo systemctl show <unit> -p Environment | tr ' ' '\n' | grep -oE '^[A-Z_]+' | sort

# what the file contains, values hidden
sudo grep -nE '^[[:space:]]*#?[[:space:]]*SMTP_' /etc/<app>/env | sed 's/=.*/=…/'
```

A variable missing from the first command and present in the second is an
editing problem. Restarting will not fix it.

**systemd's env file format is not shell.** Three ways to write a line that is
silently ignored or silently wrong:

- `KEY = value` — spaces around `=`. Ignored.
- `KEY=value  # comment` — there are no inline comments. The value becomes
  `value  # comment`.
- `#KEY=value` — still commented. Easy to miss when five lines look alike.

**Third-party units do not read your environment file.**

Your own units carry `EnvironmentFile=` because you wrote them. A unit that
ships in someone's `.deb` does not. Litestream's config named its bucket and
keys as `$R2_BUCKET` and friends, expanded from its process environment — and
`litestream.service` came from Litestream's package and knew nothing about
`/etc/third-angle/env`. Starting it produced a service that reported itself
`active`, ran, and replicated nowhere.

Fix with a drop-in, never an edit to the packaged unit:

```
/etc/systemd/system/litestream.service.d/env.conf

[Service]
EnvironmentFile=/etc/third-angle/env
```

A drop-in survives the package's upgrades. An edited unit does not.

**A script run by hand has no `EnvironmentFile` at all.** The nightly path gets
its credentials from systemd; the drill and any real recovery start with a human
typing the command, and get nothing. If a script is meant to be run both ways,
load what it needs itself — and load only what it needs. The same file usually
holds a session secret and a mail password, and neither belongs in a restore
process.

## Cloudflare

**The dashboard drifts faster than any document describing it.** Two of these
instructions were written against a UI that had moved on, and both were the kind
of stale that costs twenty minutes rather than failing outright. Expect to
translate, and check the current form before following a written click-path.

**Redirect rules** now lead with a Single Redirect wildcard template, which
needs no expression:

| Field | Value |
|---|---|
| Request URL | `https://www.example.com/*` |
| Target URL | `https://example.com/${1}` |
| Status | 301 |
| Preserve query string | on |

Leave "Redirect POST requests" off. A 301 turns POST into GET, which would
matter if a form were served from `www` — except this rule is what stops that.

**Cache rules** want a custom filter expression, and the field/operator/value
builder takes one path at a time, which does not express "three prefixes"
without a fight. Use "Edit expression" and paste.

**The dangerous setting is one click from the right one.** "Cache everything"
sits as a template at the top of the New Cache Rule page, directly above the
rule you are meant to be building. If HTML responses are per-visitor — a theme
cookie the server reads to emit `<html data-theme>` in the first byte, a page
rendered against a session — then one stored copy serves one visitor's state to
the next person behind it. An Edge TTL that overrides origin headers is the one
dashboard setting that turns a working site into a real privacy leak.

**Three toggles inject JavaScript** and will break a strict `script-src`:
Rocket Loader, Email Address Obfuscation, and Bot Fight Mode. **Email Address
Obfuscation is on by default** — it is the one you must actively turn off. Do
not trust the switches; ask the page:

```sh
curl -s https://example.com/ | grep -o '<script[^>]*>'
```

## Mail

**Inbound and outbound are unrelated problems.** Email Routing forwards mail
*to* you and does nothing for mail *from* the site. Sending needs a relay,
because an application SMTP client is a submission client, not a mail server:
it hands a message to something that already accepts mail on your behalf.

**Verify the provider's current record set rather than a remembered one.**
Brevo's domain authentication asked for six records and **none of them was
SPF** — a verification TXT, two DKIM CNAMEs, a DMARC TXT, and three optional
branding CNAMEs. Guidance written around an `include:` it no longer hands out
sends you looking for a step that does not exist.

**One SPF record per name. Always.** Even where a provider does not ask for one,
Email Routing publishes an SPF record at the apex, so a record is already there
for the next service to collide with. Two SPF TXT records at the same name is
not "two policies", it is a permanent error, and mail is more likely to be
junked than with no SPF at all. If something tells you to add one, edit the
existing record and merge the includes.

**Distinguish the credentials.** A relay's SMTP *login* is usually a generated
address, not the address you sign in with, and its *password* is a generated key,
not your account password. Getting this wrong authenticates as nothing and the
error is not obvious.

**Stored status is not live status.** A message row that recorded "SMTP is not
configured" at send time keeps saying so forever; it is a record of what
happened then. The live answer comes from whatever computes it fresh — here, a
settings page calling `isConfigured()` on each render. Check the live indicator
before debugging the configuration.

## Replication and the drill

**`active` is not `working`.** The Litestream drop-in above is the reason this
sentence is in the document. Prove replication rather than reading a service
status:

```sh
litestream snapshots /path/to/db          # a listed generation is the proof
curl -s localhost:9090/metrics | grep litestream_replica_operation_total
```

An empty snapshot list under an `active` service is the exact failure a missing
environment file produces.

**Order the first drill correctly.** A verifier that restores from *both* the
replica and the newest local snapshot cannot run on a machine that has never
taken a snapshot — it stops before reaching the interesting half. Run the real
nightly path first, so the drill rehearses the actual procedure rather than an
approximation, then time the verifier separately once a snapshot exists.

**Put the backup somewhere the machine's failure cannot reach.** A backup in
the same provider's object storage does not survive losing that provider's
account, which is the failure replication exists for.

**Heartbeat every scheduled job.** Each script pings a URL on success, so a
*missing* ping is what alerts. Without that, a nightly backup can fail every
night on a machine nobody watches, and nothing says so — which is worse than
having no backup, because this one is trusted.

## Verifying the result

Ask the deployed system, not the dashboard. This set catches most of what the
sections above describe:

```sh
# exactly one line: <script type="application/ld+json">
curl -s https://example.com/ | grep -o '<script[^>]*>'

# HSTS, CSP, nosniff, referrer policy all present
curl -sI https://example.com/ | grep -iE "strict-transport|content-security-policy|x-content-type|referrer-policy"

# 301, and the path preserved rather than dumped at the home page
curl -sI https://www.example.com/some/path | grep -iE "^HTTP|^location"

# assets HIT; HTML must be DYNAMIC or BYPASS, never HIT
curl -sI https://example.com/static/css/app.css | grep -i cf-cache-status
curl -sI https://example.com/ | grep -iE "cf-cache-status|cache-control"
```

`cf-cache-status` values worth knowing apart: **HIT** served from edge cache,
**MISS** cacheable but not yet stored, **DYNAMIC** not cached because nothing
said to, **BYPASS** not cached because a rule said not to. On per-visitor HTML,
`DYNAMIC` or `BYPASS` is correct and `HIT` is the leak.

Check the sitemap advertises nothing that 404s, since a route can exist and
still be absent — an optional page renders only once its content exists:

```sh
for u in $(curl -s https://example.com/sitemap.xml | grep -oE '<loc>[^<]*</loc>' | sed 's/<[^>]*>//g'); do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$u")" "$u"
done | grep -v '^200 ' || echo "all fine"
```

---

## The five rules

Everything above is evidence for these.

1. **`active` is not `working`.** Every layer will report success while doing
   nothing: a systemd unit with no credentials, a tunnel to a dead port, a cache
   rule that never matched. Verify the effect, never the status.

2. **Under `set -e`, decide fatality per step.** A non-essential install that
   aborts the run is a single point of failure for everything after it, and the
   machine ends up looking finished. Non-fatal failures must shout at the end.

3. **The units you did not write do not read your environment file.** Yours
   carry `EnvironmentFile=` because you wrote them. Packaged ones do not. Fix
   with a drop-in so an upgrade cannot revert it.

4. **Stored status is not live status.** Anything written into a row at the time
   an action was attempted is history. Find what computes the answer fresh.

5. **Verify the file, not the restart.** A silent editing failure is
   indistinguishable from a configuration failure, and restarting cannot fix it.
   Print what the process actually received.
