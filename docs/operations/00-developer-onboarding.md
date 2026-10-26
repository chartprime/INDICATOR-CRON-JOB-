# Developer onboarding

[Handbook](../README.md) · [Architecture](01-hosted-platform.md) ·
[Access](02-developer-access.md) · [Data for indicator authors](../architecture/indicators/data-for-indicator-authors.md)

You build indicators on your laptop. All market data is collected and stored on
the owner's host. You never run a collector, hold an S3 key or need SSH. What
you can see depends on which access layers you have. Each one is optional and
each adds to the last:

| Layer | You need | You get |
|---|---|---|
| **0 · Repository** | the checkout and Node 24.21.0 | Live Mode on Binance, every indicator on Binance, all tests |
| **1 · Host data** | a WireGuard tunnel and your own gateway bearer, from the owner | warm-up for live indicators from the host's recorded history, and Historical Mode with its studies for Binance, ES, NQ, AAPL and TSLA |
| **2 · dxFeed live** | Tailscale access to the dxFeed token broker, from the owner | live ES, NQ, AAPL, TSLA and NVDA |

Layers 1 and 2 are independent: you can have either, both or neither.
`npm run doctor` tells you which layers this machine has and whether each one
works.

## Day one: layer 0

Use **Node 24.21.0**. It is pinned in `.nvmrc` because the runtime loads a
native SQLite binding. Tests and builds refuse any other version. `npm start`,
`npm run dev` and the web dev server go through a launcher: if your shell runs
another Node, it runs 24.21.0 from nvm, fnm, volta or the folder you name in
`.env` as `TT_NODE_BIN`, and otherwise refuses to start. The npm workspace
root is the repository root, not `apps`. From the root:

```powershell
npm ci --ignore-scripts
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run doctor
```

`.env.example` is organized by layer and every layer starts switched off, so
`doctor` should report layer 0 working and layers 1 and 2 *not configured*.
That is a pass. Never copy values from `.env.operator.example`; a developer
needs none of them. Every setting, the values it accepts and who reads it is
in [configuration](09-configuration.md). The runtime refuses to start on an
invalid value and names it; `doctor` reports the same before you start.

Start the terminal in two shells, both from the repository root:

```powershell
# Terminal C: runtime, live provider sessions and the chart WebSocket
cd apps/runtime
npm run dev
```

```powershell
# Terminal D: the web app
npm run dev --workspace web
```

Open `http://127.0.0.1:8000/`. The runtime's health is at
`http://127.0.0.1:8001/health`. `npm run dev` restarts the runtime when you edit
its source; `npm start` runs it without watching.

When someone else views the terminal through a tunnel, serve the built bundle
instead of the dev server in Terminal D. The dev server sends every module
separately, which is slow over a tunnel. The preview uses the same address,
hosts and proxies, so the tunnel does not change:

```powershell
# Terminal D, for tunnel viewers: build once, then serve the bundle
npm run build --workspace web
npm run preview --workspace web
```

Rebuild after a web change; the preview does not reload.

## Adding layer 1: host data

1. Install WireGuard (Windows and macOS: the official app; Linux: the
   distribution's tools) and choose **Add empty tunnel**. The app generates a
   key pair. The private key never leaves your laptop.
2. Send the owner your name and the tunnel's **public** key. It is safe to send
   in chat.
3. The owner sends back two things: the tunnel settings, in chat, and your
   gateway bearer, through a one-time secret link. Paste the settings into the
   tunnel, keeping the `PrivateKey` line the app generated, and activate it.
4. In `.env`, uncomment the four layer-1 lines and put your bearer in both
   bearer lines:

   ```text
   TT_ARCHIVE_PROXY_URL=http://10.88.0.1:8001
   VITE_ARCHIVE_CLIENT_TOKEN=<your-bearer>
   TT_LIVE_STORAGE_SERVICE_URL=http://10.88.0.1:8001/live-storage
   TT_LIVE_STORAGE_CLIENT_TOKEN=<your-bearer>
   ```

5. Restart both terminals and run `npm run doctor`. Layer 1 should report
   *working*. If it fails, the line names where: the WireGuard tunnel, the
   gateway, your bearer, the archive, or live storage. See
   [developer access](02-developer-access.md#when-doctor-reports-a-failure).
6. Open **Historical Mode**, choose ES Continuous at 1h, and turn on a volume
   profile. A chart and a profile mean the whole path works.

Live ticks still come from your own runtime. The host never streams them, and
`/ws` and `/health` always stay on your laptop.

## Adding layer 2: dxFeed live

Ask the owner for Tailscale access to the dxFeed token broker. Once your laptop
is on the tailnet, set the broker's address in `.env`:

```text
TT_DXFEED_TOKEN_BROKER_URL=https://<broker-name>.<tailnet>.ts.net
```

Restart Terminal C. Its start-up banner changes from *dxFeed unavailable* to
*available on select*, and ES, NQ, AAPL, TSLA and NVDA stream live when you select
them. Each selection opens a short-lived session that closes when you move away,
and the token is fetched fresh every time; nothing secret is stored in `.env`.
Without layer 2, a dxFeed instrument shows **History only · dxFeed live not
configured**. With layer 1 you still get everything the host recorded for it
(candles, profiles, large trades, VPIN warm-up); only new ticks are missing.

## Build an indicator

Read [data for indicator authors](../architecture/indicators/data-for-indicator-authors.md)
first. It covers the three data sources, what each instrument has, the rules
every indicator follows, and a worked example. Then:

| Boundary | Where |
|---|---|
| Indicators, one folder each | `apps/web/src/lib/indicators/` |
| Registration and Historical Mode policy | `apps/web/src/lib/chart/indicatorRegistry.ts` |
| Chart plumbing | `apps/web/src/lib/chart/` |
| Runtime, providers and live storage | `apps/runtime/src/` |
| Governed instruments | `config/market-instruments.json` |

Before you open a pull request, run the full gate from the repository root:

```powershell
npm run check
```

It runs the documentation check, lint, every workspace's tests and the
production web build. There is no repo-wide formatter: match the surrounding
code, and do not let format-on-save reflow lines you did not change.

## Access you do not need

Operating the host, running conversions, publishing archive data and holding
provider keys are separate roles. They are described in the
[server runbook](03-server-runbook.md), the [archive runbook](04-archive-runbook.md)
and [operator tooling on a laptop](08-operator-tooling.md). Access to the
repository grants none of them.
