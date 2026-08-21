#!/usr/bin/env bash
#
# Provision a fresh box for Third Angle. Idempotent: safe to run again.
#
# Target: Oracle Cloud Always Free, VM.Standard.A1.Flex, arm64, Ubuntu 24.04.
# Also works unchanged on the named fallback (Hetzner CAX11, also arm64), which
# is the whole reason the fallback is arm64 rather than the cheaper x86 option.
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
apt-get install -y -qq curl ca-certificates gnupg git ufw ripgrep ne >/dev/null

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

log "Litestream"
# Pin ABOVE 0.5.7: releases 0.5.6 and 0.5.7 fail replication completely and
# SILENTLY, with no error output, which is the worst possible failure mode for
# a backup tool. See DESIGN.md risk R5.
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
SITE_URL=https://example.com
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
DATA_DIR=$DATA_DIR
EOF
  echo "    Created $ENV_DIR/env. EDIT SITE_URL before going live."
else
  echo "    $ENV_DIR/env exists, left alone."
fi
chown root:"$APP_USER" "$ENV_DIR/env"
chmod 640 "$ENV_DIR/env"

log "Services"
install -m 644 "$APP_DIR/deploy/third-angle.service" /etc/systemd/system/
[ -f /etc/caddy/Caddyfile.orig ] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig 2>/dev/null || true
echo "    Caddyfile NOT overwritten. Copy deploy/Caddyfile and set the domain."
install -m 644 "$APP_DIR/deploy/litestream.yml" /etc/litestream.yml
install -m 755 "$APP_DIR/deploy/backup.sh" /usr/local/bin/third-angle-backup
install -m 755 "$APP_DIR/deploy/restore-verify.sh" /usr/local/bin/third-angle-verify
install -m 644 "$APP_DIR/deploy/third-angle-backup.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/third-angle-backup.timer" /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now third-angle >/dev/null
systemctl enable --now third-angle-backup.timer >/dev/null

log "Firewall"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status numbered | sed 's/^/    /'

# Oracle images ship iptables rules that survive ufw and silently drop 80/443.
# Forgetting this is the classic "the site is up but nothing reaches it" hour.
if command -v netfilter-persistent >/dev/null; then
  log "Oracle iptables (the rule everyone forgets)"
  iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT || true
  iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT || true
  netfilter-persistent save >/dev/null || true
fi

log "Status"
systemctl is-active third-angle && curl -fsS localhost:3000/healthz || true

cat <<'NEXT'

Remaining, by hand:
  1. Edit /etc/third-angle/env and set SITE_URL to the real domain.
  2. Copy deploy/Caddyfile to /etc/caddy/Caddyfile, replace example.com,
     then: systemctl reload caddy
  3. Create the admin account:
       cd /srv/third-angle
       sudo -u app node scripts/create-admin.js you@domain "Your Name" "a long passphrase"
     then enrol TOTP with the printed otpauth URI and confirm it.
  4. Put the R2 credentials in /etc/third-angle/env, then:
       systemctl enable --now litestream
  5. RUN THE RESTORE DRILL. An unrehearsed backup is a belief, not a backup.
       third-angle-verify
     Record the measured time in RESTORE.md.

NEXT
