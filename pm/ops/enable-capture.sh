#!/usr/bin/env bash
# Turn the test host into a recorder: run the Binance collector as a service
# (depth, trades, klines for every governed Binance pair into SQLite) and
# serve the capture directory read-only over HTTPS behind a second password,
# so the team can download slices and replay them through the L2 engine.
#
# Run after install-test-host.sh, as root:
#   bash enable-capture.sh terminal.example.com alex 'owner-password' team 'team-password'
set -euo pipefail
HOSTNAME_FQDN=${1:?hostname}; OWNER=${2:?owner user}; OWNER_PW=${3:?owner password}; TEAM=${4:?team user}; TEAM_PW=${5:?team password}
NODE_DIR=/opt/terminal-l1-l2/node-v24.21.0-linux-x64
APP=/srv/terminal/app
test "$(id -u)" = 0 || { echo "run as root"; exit 1; }
apt-get install -y -qq python3 make g++ >/dev/null

# The installer used --ignore-scripts, so the SQLite binding is not built yet.
sudo -u terminal -H bash -c "cd $APP && export PATH='$NODE_DIR/bin:\$PATH' && npm rebuild better-sqlite3 --silent"
DATA_ROOT=$(sudo -u terminal -H bash -c "cd $APP/apps/runtime && grep -E '^TT_DATA_ROOT=' ../../.env | cut -d= -f2-")
DATA_ROOT=${DATA_ROOT:-$APP/apps/runtime/data}
sudo -u terminal -H mkdir -p "$DATA_ROOT"

cat > /etc/systemd/system/terminal-collector.service <<UNIT
[Unit]
Description=Terminal L1/L2 Binance collector (records depth, trades and klines to SQLite)
After=network-online.target
Wants=network-online.target
[Service]
User=terminal
Group=terminal
WorkingDirectory=$APP/apps/runtime
Environment=PATH=$NODE_DIR/bin:/usr/bin:/bin
ExecStart=$NODE_DIR/bin/node ../../scripts/node-launcher.cjs scripts/collect/run-collector.js
Restart=always
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now terminal-collector

OWNER_HASH=$(caddy hash-password --plaintext "$OWNER_PW")
TEAM_HASH=$(caddy hash-password --plaintext "$TEAM_PW")
cat > /etc/caddy/Caddyfile <<CADDY
$HOSTNAME_FQDN {
    handle_path /captures/* {
        basic_auth {
            $TEAM $TEAM_HASH
            $OWNER $OWNER_HASH
        }
        root * $DATA_ROOT
        file_server browse
    }
    handle {
        basic_auth {
            $OWNER $OWNER_HASH
        }
        reverse_proxy 127.0.0.1:8000
    }
}
CADDY
systemctl reload caddy || systemctl restart caddy
sleep 5
echo "collector: $(systemctl is-active terminal-collector)"
echo "captures listing: https://$HOSTNAME_FQDN/captures/  (user $TEAM)"
echo "data root: $DATA_ROOT"
journalctl -u terminal-collector -n 5 --no-pager
