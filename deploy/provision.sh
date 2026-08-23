#!/usr/bin/env bash
#
# Provision a fresh box for Third Angle. Idempotent: safe to run again.
#
# Target: Oracle Cloud Always Free, VM.Standard.A1.Flex, arm64, Ubuntu 24.04,
# with Cloudflare in front for DNS, TLS, caching and the WAF.
#
# Also works unchanged on the named fallback (Hetzner CAX11, also arm64), which
# is the whole reason the fallback is arm64 rather than the cheaper x86 option.
#
# Nothing listens on the public internet when this finishes. The tunnel dials
# OUT to Cloudflare, Caddy is bound to loopback, and the firewall allows SSH
# and nothing else. See DEPLOY.md.
#
# This script IS the disaster recovery plan. The box is disposable; the backup
# is the system of record. If Oracle changes the free tier again, or closes the
# account, recovery is: new machine, run this, run restore. Target under an hour.
#
#   sudo bash deploy/provision.sh
#
set -euo pipefail

APP_USER=app
APP_DIR=/srv/third-angle
DATA_DIR="$APP_DIR/data"
ENV_DIR=/etc/third-angle
NODE_MAJOR=24
REPO=https://github.com/XrxcGH/third-angle.git

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

log "Architecture check"
ARCH="$(uname -m)"
echo "    $ARCH"
[ "$ARCH" = "aarch64" ] || echo "    WARNING: expected aarch64. sharp prebuilds are architecture specific."

log "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw ripgrep ne rclone >/dev/null

log "Node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

# FTS5 and the trigram tokenizer are hard requirements. Some Node 22 and 23
# builds ship without FTS5 and the app would fail confusingly later, so fail
# here instead, before anything is installed.
log "SQLite capability check"
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('create virtual table t using fts5(a)');
d.exec(\"create virtual table g using fts5(a, tokenize='trigram')\");
console.log('    FTS5 and trigram present, SQLite', d.prepare('select sqlite_version() v').get().v);
"

log "Caddy"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
caddy version

log "cloudflared"
if ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
fi
cloudflared --version
id -u cloudflared >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared
mkdir -p /etc/cloudflared
chown root:cloudflared /etc/cloudflared
chmod 750 /etc/cloudflared

log "Litestream"
# Pin ABOVE 0.5.7: releases 0.5.6 and 0.5.7 fail replication completely and
# SILENTLY, with no error output, which is the worst possible failure mode for
# a backup tool. See RESTORE.md and deploy/litestream.yml.
LITESTREAM_VERSION=0.5.16
if ! command -v litestream >/dev/null || [ "$(litestream version 2>/dev/null | tr -d 'v')" != "$LITESTREAM_VERSION" ]; then
  curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-arm64.deb" \
    -o /tmp/litestream.deb
  dpkg -i /tmp/litestream.deb >/dev/null
  rm -f /tmp/litestream.deb
fi
litestream version

log "Application user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR/uploads" "$DATA_DIR/backups" "$ENV_DIR" /var/log/caddy
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 750 "$ENV_DIR"

log "Source"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  sudo -u "$APP_USER" git clone --depth 20 "$REPO" "$APP_DIR"
fi

log "Dependencies and fonts"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund
sudo -u "$APP_USER" npm run fonts

log "Environment file"
if [ ! -f "$ENV_DIR/env" ]; then
  cat > "$ENV_DIR/env" <<EOF
NODE_ENV=production
PORT=3000
SITE_URL=https://ericjdean.com
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
DATA_DIR=$DATA_DIR

# Off-site replication. Litestream reads these; so does backup.sh, for the
# nightly snapshot it copies up with rclone.
#R2_BUCKET=
#R2_ACCOUNT_ID=
#R2_ACCESS_KEY_ID=
#R2_SECRET_ACCESS_KEY=

# Outbound mail. A relay, not a mailbox: src/mailer.js hands the message to
# something that already accepts mail for you. Brevo's login is a generated
# address from its SMTP & API page, not the address you sign in with, and
# SMTP_FROM has to be a sender Brevo has verified. See DEPLOY.md step 5.
#SMTP_HOST=smtp-relay.brevo.com
#SMTP_PORT=587
#SMTP_USER=
#SMTP_PASS=
#SMTP_FROM=contact@ericjdean.com

# Dead man's switches. Each script pings its URL on success and /fail on
# failure, so a MISSING ping is what alerts. Without these a backup can fail
# every night on a machine nobody is watching and nothing will say so, which is
# worse than having no backup, because this one is trusted.
#   BACKUP     third-angle-backup, nightly
#   VERIFY     third-angle-verify, nightly, straight after the snapshot
#   LITESTREAM third-angle-alive, every 15 minutes
#BACKUP_HEALTHCHECK_URL=
#VERIFY_HEALTHCHECK_URL=
#LITESTREAM_HEALTHCHECK_URL=
EOF
  echo "    Created $ENV_DIR/env. EDIT SITE_URL before going live."
else
  echo "    $ENV_DIR/env exists, left alone."
fi
chown root:"$APP_USER" "$ENV_DIR/env"
chmod 640 "$ENV_DIR/env"

log "Services"
install -m 644 "$APP_DIR/deploy/third-angle.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/cloudflared.service" /etc/systemd/system/

# The Caddyfile names no domain and needs no editing, so unlike the tunnel
# config it can simply be installed.
[ -f /etc/caddy/Caddyfile.orig ] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig 2>/dev/null || true
install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile

# The tunnel config DOES need editing: it names the tunnel and the domain.
# Never overwritten, because a second run would replace a working one.
if [ ! -f /etc/cloudflared/config.yml ]; then
  install -m 640 -o root -g cloudflared "$APP_DIR/deploy/cloudflared.yml" /etc/cloudflared/config.yml
  echo "    Installed /etc/cloudflared/config.yml. EDIT the TUNNEL_ID and the domain."
else
  echo "    /etc/cloudflared/config.yml exists, left alone."
fi
install -m 644 "$APP_DIR/deploy/litestream.yml" /etc/litestream.yml
install -m 755 "$APP_DIR/deploy/backup.sh" /usr/local/bin/third-angle-backup
install -m 755 "$APP_DIR/deploy/restore-verify.sh" /usr/local/bin/third-angle-verify
install -m 755 "$APP_DIR/deploy/alive.sh" /usr/local/bin/third-angle-alive
install -m 644 "$APP_DIR/deploy/third-angle-backup.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/third-angle-backup.timer" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/litestream-alive.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/litestream-alive.timer" /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now third-angle >/dev/null
systemctl enable --now third-angle-backup.timer >/dev/null
systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy >/dev/null

# NOT enabled here. Starting a tunnel whose config still says TUNNEL_ID puts
# cloudflared into a restart loop that fills the journal, and the operator has
# to edit the file before it can work anyway.
if grep -q TUNNEL_ID /etc/cloudflared/config.yml 2>/dev/null; then
  echo "    cloudflared NOT started: /etc/cloudflared/config.yml is still a template."
else
  systemctl enable --now cloudflared >/dev/null
fi

log "Firewall"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
# 80 and 443 stay CLOSED. The tunnel dials out; nothing dials in. Opening them
# would put the origin back on the internet beside Cloudflare rather than
# behind it, and every request that found the IP would skip the WAF.
ufw --force enable >/dev/null
ufw status numbered | sed 's/^/    /'

log "Status"
systemctl is-active third-angle && curl -fsS localhost:3000/healthz || true

cat <<'NEXT'

Remaining, by hand:
  1. Edit /etc/third-angle/env and set SITE_URL to the real domain.
       systemctl restart third-angle
  2. Create the tunnel, then edit /etc/cloudflared/config.yml with its ID and
     your domain. The file has the four commands in its header.
       systemctl enable --now cloudflared
       systemctl status cloudflared
  3. Create the admin account:
       cd /srv/third-angle
       sudo -u app npm run admin -- you@domain "Your Name" "a long passphrase"
     then enrol TOTP with the printed otpauth URI and confirm it.
  4. Put the R2 credentials in /etc/third-angle/env, then:
       systemctl enable --now litestream
  5. Set the zone up at Cloudflare. DEPLOY.md has the list, and two of the
     settings there are the difference between a fast site and a site that
     serves one visitor's theme to the next one.

  6. RUN THE RESTORE DRILL. An unrehearsed backup is a belief, not a backup.
       third-angle-verify
     Record the measured time in RESTORE.md.

NEXT
