# Test host recipe: one small VPS running the terminal for live testing

Purpose: a copy of the terminal you can open from anywhere to test indicators
on live Binance data. This is a TEST host, not the hardened data host in
`ops/linux-host/` (no collectors, no archive, no dxFeed). It serves Live Mode
on Binance spot and perpetual only. Written 2026-10-26 against `main`.

Two facts shape the recipe: the terminal has no sign-in, so the host must sit
behind a reverse proxy with a password; and the runtime opens WebSockets to
Binance, so the VPS must be in a region Binance serves (a US address gets
HTTP 451 from `api.binance.com`; pick an EU or Asian region, or wait for the
spot URL override and mirror support the platform brief adds).

## 1. Machine

Ubuntu 24.04, 2 vCPU, 4 GB RAM, 40 GB disk, a public IPv4, and a DNS name
pointing at it (below: `terminal.example.com`). Ports 22, 80 and 443 open;
everything else closed.

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git build-essential ufw curl
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
sudo adduser --system --group --home /srv/terminal terminal
```

## 2. Node 24.21.0 (the repo refuses any other version)

Use the repository's own pinned installer, which verifies the checksum:

```bash
sudo mkdir -p /opt/terminal-l1-l2
cd /tmp && git clone https://github.com/chartprime/INDICATOR-CRON-JOB-.git src
sudo bash /tmp/src/ops/linux-host/scripts/install-node.sh      # installs /opt/terminal-l1-l2/node-v24.21.0-linux-x64
export PATH=/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin:$PATH
node --version   # v24.21.0
```

## 3. Checkout, dependencies, build

```bash
sudo -u terminal -H bash -c '
  cd /srv/terminal
  git clone https://github.com/chartprime/INDICATOR-CRON-JOB-.git app
  cd app
  export PATH=/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin:$PATH
  npm ci --ignore-scripts
  cp -n .env.example .env
  npm run build --workspace web
'
```

`--ignore-scripts` is what the README uses; it skips the native SQLite build,
which Live Mode does not need (SQLite is for the local collector and warm-up
storage, neither of which runs here).

## 4. Environment

`/srv/terminal/app/.env` (read by the runtime at every start) gets:

```
EXTRA_ALLOWED_ORIGIN=https://terminal.example.com
VITE_ALLOWED_HOST=terminal.example.com
```

The first lets the runtime accept the browser's WebSocket origin; the second
lets the web preview answer for that host (see README, "share the frontend").

## 5. Two services

`/etc/systemd/system/terminal-runtime.service`:

```ini
[Unit]
Description=Terminal L1/L2 runtime (Binance live, port 8001)
After=network-online.target
Wants=network-online.target

[Service]
User=terminal
Group=terminal
WorkingDirectory=/srv/terminal/app/apps/runtime
Environment=PATH=/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin:/usr/bin:/bin
ExecStart=/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin/node ../../scripts/node-launcher.cjs scripts/serve/run-ws-server.js 8001 BTCUSDT
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/terminal-web.service`:

```ini
[Unit]
Description=Terminal L1/L2 web app (preview of the built bundle, port 8000)
After=terminal-runtime.service

[Service]
User=terminal
Group=terminal
WorkingDirectory=/srv/terminal/app
Environment=PATH=/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin:/usr/bin:/bin
ExecStart=/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin/npm run preview --workspace web -- --host 127.0.0.1 --port 8000 --strictPort
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now terminal-runtime terminal-web
curl -s http://127.0.0.1:8001/health | head -c 300      # runtime health
curl -sI http://127.0.0.1:8000/ | head -1                # web app
journalctl -u terminal-runtime -n 50 --no-pager          # look for route connected lines
```

The preview server proxies `/ws`, `/health`, `/heatmap` and `/archive` to the
runtime on 8001 (`apps/web/vite.config.ts`), so the browser only ever talks
to port 8000.

## 6. Reverse proxy with TLS and a password (Caddy)

```bash
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
caddy hash-password --plaintext 'choose-a-long-password'   # paste the hash below
```

`/etc/caddy/Caddyfile`:

```
terminal.example.com {
    basic_auth {
        alex <paste-the-hash-here>
    }
    reverse_proxy 127.0.0.1:8000
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains the certificate automatically and proxies WebSockets without
extra configuration. Open https://terminal.example.com, sign in with the
password, pick BTC spot, add indicators from the ◇ Indicators menu.

## 7. Updating to a new commit

```bash
sudo -u terminal -H bash -c '
  cd /srv/terminal/app && export PATH=/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin:$PATH
  git fetch origin && git checkout main && git pull --ff-only
  npm ci --ignore-scripts && npm run build --workspace web
'
sudo systemctl restart terminal-runtime terminal-web
```

To test a branch before it is merged, check out that branch in step 7 instead
of `main`.

## 8. What this host does not do

No dxFeed (ES, NQ, AAPL, TSLA, NVDA need the owner's token broker), no
Historical Mode (needs the archive gateway over WireGuard), no warm-up from
host storage (indicators start from live ticks and say so), no recording. The
selection is shared across every open browser tab by design: two testers on
the same host see the same symbol.

## 9. Checks when something is wrong

| Symptom | Look at |
|---|---|
| Chart loads, no candles | `journalctl -u terminal-runtime`: `route_error` means Binance refused the region or the network; `/health` on 8001 |
| 403 from the web app | `VITE_ALLOWED_HOST` does not match the DNS name; restart terminal-web |
| WebSocket closes at once | `EXTRA_ALLOWED_ORIGIN` must be exactly `https://terminal.example.com` |
| `requires Node 24.21.0` | the PATH in the unit does not point at the pinned Node |

## 10. Recording depth for the team (`enable-capture.sh`)

`pm/ops/enable-capture.sh` builds the SQLite binding, runs the repository's
Binance collector as a third service, and serves the capture directory
read-only at `https://<host>/captures/` behind a second login. The team
downloads a slice over HTTPS and replays it through the real L2 engine with
the runtime's replay source, which is how L2 indicators are validated without
a live book in the cloud container. The collector records every governed
Binance pair; its capacity guard stops it before the disk fills. Stop it with
`systemctl stop terminal-collector` when a capture is not needed.
