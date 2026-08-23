# Restore runbook

The box is disposable. The backup is the system of record.

That is not a slogan, it is a design decision with a specific cause: on 15 June
2026 Oracle halved the Always Free allowance this site runs on, with no blog
post, no email, and no customer notification. There is no contract, no SLA, and no
support channel. So the plan is not to trust the host, it is to be able to leave
it in under an hour.

An unrehearsed backup is a belief, not a backup.

---

## What exists, and what each layer is for

| Layer | Covers | Recovery point |
|---|---|---|
| Litestream to R2 | Machine loss, disk loss | About 1 second |
| Nightly snapshot to R2 | A bad migration or an accidental delete, which Litestream replicates faithfully | Up to 24 hours |
| Weekly copy to Backblaze B2 | Losing the Cloudflare account itself | Up to 7 days |
| `git` on GitHub | The code | Every push |
| Media in R2 | Uploads, which never live only on the box | Immediate |

Two providers, because two copies with one vendor is one copy.

---

## Drill: run this quarterly

Takes about five minutes and needs no outage.

```bash
sudo third-angle-verify
```

That restores from the Litestream replica **and** from the newest snapshot, then
puts each through five assertions: structural integrity, referential integrity,
FTS5 index consistency, actual content, and recency. Each catches a different way
a restore can be quietly wrong. A restored database that is structurally perfect
and more than 45 days stale passes the first four and fails the fifth, which is
the point.

Then deliberately break it and confirm the alert lands:

```bash
sudo systemctl stop litestream
# wait 30 minutes, confirm the Healthchecks email arrives
sudo systemctl start litestream
```

If no email arrives, the monitoring is decorative and the backups are unverified.
Fix that before anything else.

---

## Full rebuild, from nothing

The situation: the machine is gone, the Oracle account is gone, or the free tier
changed again. You have the domain, the GitHub repository, and the R2 credentials.

### 1. Get a machine, 5 to 40 minutes

Oracle Ampere A1, arm64, Ubuntu 24.04. Expect to retry: A1 capacity is
region dependent and Oracle publishes no guarantee for free shapes, so the create
call may return "Out of host capacity" for a while. Loop it rather than clicking.

If capacity will not clear, do not wait on it:

- An Always Free AMD `E2.1.Micro` is far easier to obtain and will run this site,
  though 1 GB of RAM is thin for concurrent image processing.
- The named paid fallback is a **Hetzner CAX11**, about $91 a year. It is arm64
  specifically so this same script and the same `sharp` prebuilds work unchanged.

### 2. Provision, about 5 minutes

```bash
git clone https://github.com/XrxcGH/third-angle.git
sudo bash third-angle/deploy/provision.sh
```

Installs Node 24, Caddy, cloudflared, Litestream, the service units, and the
firewall, and asserts up front that this SQLite build has FTS5 and the trigram
tokenizer. If that assertion fails, stop: the app would fail later and more
confusingly.

Nothing needs to listen on 80 or 443: the firewall allows SSH only and
cloudflared dials out to Cloudflare. The classic lost hour here is instead a
tunnel that never started, because the provision script deliberately leaves
cloudflared stopped while `/etc/cloudflared/config.yml` still says `TUNNEL_ID`.

### 3. Restore the database, about 1 minute

```bash
sudo systemctl stop third-angle

# Preferred: the continuous replica, roughly one second of data loss.
sudo -u app litestream restore -config /etc/litestream.yml \
  -o /srv/third-angle/data/third-angle.db \
  /srv/third-angle/data/third-angle.db

# Or from a snapshot, if you are recovering from a bad migration rather than
# from machine loss. Pick a snapshot from BEFORE the mistake.
# rclone copy r2:BUCKET/snapshots/third-angle-YYYYMMDDTHHMMSSZ.db.gz /tmp/
# gunzip -c /tmp/third-angle-*.db.gz > /srv/third-angle/data/third-angle.db

sudo -u app node /srv/third-angle/scripts/db-tool.mjs verify \
  /srv/third-angle/data/third-angle.db
sudo systemctl start third-angle
```

**Verify before starting the app, not after.** Serving a corrupt database is
worse than serving the maintenance page, because Litestream will then dutifully
replicate the corruption over your good replica.

### 4. Restore the media, about 2 minutes

```bash
sudo -u app rclone sync r2:BUCKET/media /srv/third-angle/data/uploads
```

In production media is served from an R2 custom domain, so this step is only for
the local fallback path. Check for orphans afterwards in the admin: rows whose
file is missing, or files with no row.

### 5. Point the domain, 1 to 20 minutes

Re-point the tunnel at the new machine: `cloudflared tunnel create third-angle`,
then `cloudflared tunnel route dns third-angle ericjdean.com` for the apex
and again for www, copy the credentials JSON to `/etc/cloudflared/`, and
`systemctl enable --now cloudflared`. There is no A or AAAA record for the
origin — the tunnel's records are proxied CNAMEs and the machine's address is
never published. Set the real
domain in `SITE_URL` in `/etc/third-angle/env`, then
`systemctl restart third-angle`. `/etc/caddy/Caddyfile` names no domain and
needs no editing, and TLS is Cloudflare's: Caddy runs with `auto_https off` on a
loopback socket and issues no certificate. Propagation is usually quick because
the TTL is short by default.

### 6. Confirm

```bash
curl -fsS https://ericjdean.com/healthz          # ok facets=8
curl -sI https://ericjdean.com/ | grep -i content-security
sudo systemctl status third-angle cloudflared litestream third-angle-backup.timer
```

Then in a browser: sign in to `/admin`, load one project page, run one search,
and confirm an image renders. The keyword monitor in UptimeRobot asserts a real
project title appears, which proves SQLite and FTS5 are alive rather than merely
that Node answered.

---

## Recovering one deleted project, without a full restore

Every admin write is recorded in `audit_log`, and a project delete records the
whole row as JSON. So a deleted project is recoverable by hand without touching
backups:

```bash
sudo -u app node -e "
const db = require('/srv/third-angle/src/db.js');
const rows = db.all(
  \"SELECT id, at, action, snapshot FROM audit_log WHERE table_name='project' AND action='delete' ORDER BY id DESC LIMIT 5\"
);
for (const r of rows) console.log(r.id, r.at, JSON.parse(r.snapshot).title);
"
```

Then re-create it from the snapshot through the admin. That is deliberately
manual: an automatic undelete is a feature with its own failure modes, and this
happens rarely enough that ten minutes of care is the right trade.

---

## When to give up on free

Move to the paid fallback without hesitating if any of these happen:

- A1 capacity has not cleared after a day of retrying and the site is down.
- Oracle changes the Always Free terms a second time.
- You have spent more than two hours in a quarter administering the box.

$91 a year against a portfolio that is down during application season is not a
close decision. The whole point of the provisioning script and this runbook is
that the move costs an hour and nothing else, which is what makes running on a
free tier a reasonable risk rather than a gamble.
