#!/usr/bin/env bash
# One-command test host for Terminal-L1-L2 on a fresh Ubuntu 24.04 VPS.
# Full stack: the Node runtime (Binance live, L2 engine included) plus the web
# app, behind Caddy with TLS and a password. TEST hosting only; see
# pm/ops/test-host-recipe.md for what it does and does not do.
#
# Usage (as root, with DNS for the hostname already pointing at this machine):
#   bash install-test-host.sh terminal.example.com alex 'a-long-password' [git-ref]
set -euo pipefail
HOSTNAME_FQDN=${1:?hostname}; USER_NAME=${2:?login user}; PASSWORD=${3:?password}; REF=${4:-main}
REPO_URL=https://github.com/chartprime/INDICATOR-CRON-JOB-.git
NODE_DIR=/opt/terminal-l1-l2/node-v24.21.0-linux-x64
test "$(id -u)" = 0 || { echo "run as root"; exit 1; }

apt-get update -qq && apt-get install -y -qq git build-essential ufw curl debian-keyring debian-archive-keyring apt-transport-https >/dev/null
ufw allow OpenSSH >/dev/null && ufw allow 80 >/dev/null && ufw allow 443 >/dev/null && ufw --force enable >/dev/null
id terminal >/dev/null 2>&1 || adduser --system --group --home /srv/terminal terminal

# Pinned Node 24.21.0 through the repository's checksum-verified installer.
if [ ! -x "$NODE_DIR/bin/node" ]; then
  rm -rf /tmp/tt-src && git clone -q --depth 1 "$REPO_URL" /tmp/tt-src
  bash /tmp/tt-src/ops/linux-host/scripts/install-node.sh
fi
export PATH="$NODE_DIR/bin:$PATH"

# Checkout, dependencies, web build.
if [ ! -d /srv/terminal/app/.git ]; then
  sudo -u terminal -H git clone -q "$REPO_URL" /srv/terminal/app
fi
sudo -u terminal -H bash -c "cd /srv/terminal/app && git fetch -q origin && git checkout -q '$REF' && (git pull -q --ff-only || true) \
  && export PATH='$NODE_DIR/bin:\$PATH' && npm ci --ignore-scripts --silent && cp -n .env.example .env \
  && grep -q EXTRA_ALLOWED_ORIGIN .env || printf 'EXTRA_ALLOWED_ORIGIN=https://%s\nVITE_ALLOWED_HOST=%s\n' '$HOSTNAME_FQDN' '$HOSTNAME_FQDN' >> .env \
  && npm run build --workspace web --silent"

# Two services.
cat > /etc/systemd/system/terminal-runtime.service <<UNIT
[Unit]
Description=Terminal L1/L2 runtime (Binance live, port 8001)
After=network-online.target
Wants=network-online.target
[Service]
User=terminal
Group=terminal
WorkingDirectory=/srv/terminal/app/apps/runtime
Environment=PATH=$NODE_DIR/bin:/usr/bin:/bin
ExecStart=$NODE_DIR/bin/node ../../scripts/node-launcher.cjs scripts/serve/run-ws-server.js 8001 BTCUSDT
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/terminal-web.service <<UNIT
[Unit]
Description=Terminal L1/L2 web app (preview of the built bundle, port 8000)
After=terminal-runtime.service
[Service]
User=terminal
Group=terminal
WorkingDirectory=/srv/terminal/app
Environment=PATH=$NODE_DIR/bin:/usr/bin:/bin
ExecStart=$NODE_DIR/bin/npm run preview --workspace web -- --host 127.0.0.1 --port 8000 --strictPort
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now terminal-runtime terminal-web

# Caddy: TLS plus a password.
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
HASH=$(caddy hash-password --plaintext "$PASSWORD")
cat > /etc/caddy/Caddyfile <<CADDY
$HOSTNAME_FQDN {
    basic_auth {
        $USER_NAME $HASH
    }
    reverse_proxy 127.0.0.1:8000
}
CADDY
systemctl reload caddy || systemctl restart caddy

sleep 8
echo "runtime health: $(curl -s http://127.0.0.1:8001/health | head -c 200)"
echo "web: $(curl -sI http://127.0.0.1:8000/ | head -1)"
echo "Open https://$HOSTNAME_FQDN and sign in as $USER_NAME."
echo "Logs: journalctl -u terminal-runtime -f"
