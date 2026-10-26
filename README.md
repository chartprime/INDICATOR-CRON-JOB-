# Terminal-L1-L2

The ChartPrime sandbox where L1/L2 market-data indicators are built and tested.

Live data from **Binance** (spot and perpetual) and **dxFeed** (ES, NQ, AAPL,
TSLA, NVDA) is normalized into one canonical event shape and served to a
React/TypeScript chart over a single local WebSocket. **Historical Mode** charts
BTC, ETH, ES, NQ, AAPL and TSLA from a published archive, with volume profile,
VPIN, large prints and buy/sell flow computed on the host.

All market data is collected and stored on the owner's host. As a developer you
run only the terminal: no collectors, no S3 keys, no SSH.

## What you can see depends on your access

| Layer | You need | You get |
|---|---|---|
| **0 · Repository** | this checkout and Node 24.21.0 | Live Mode on Binance, every indicator on Binance, all tests |
| **1 · Host data** | a WireGuard tunnel and your own gateway bearer | warm-up from the host's recorded history, and Historical Mode with its studies |
| **2 · dxFeed live** | Tailscale access to the dxFeed token broker | live ES, NQ, AAPL, TSLA and NVDA |

Every layer is optional and layers 1 and 2 are independent.
[Developer onboarding](docs/operations/00-developer-onboarding.md) explains how
to get each one, and `npm run doctor` reports which ones your machine has.

## Quick start

```powershell
npm ci --ignore-scripts
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run doctor
```

Then, in two shells from the repository root:

```powershell
# Terminal C: runtime, provider sessions and the chart WebSocket
cd apps/runtime
npm run dev
```

```powershell
# Terminal D: the web app
npm run dev --workspace web
```

Open **http://127.0.0.1:8000/**. The runtime's health is at
`http://127.0.0.1:8001/health`, also proxied at `:8000/health`.

The runtime reads the repository `.env` on every start. Symbol, market and
provider switch live from the chart, and the selection is shared: changing it
in one browser tab changes it for every connected viewer.

## Build an indicator

Start with [data for indicator authors](docs/architecture/indicators/data-for-indicator-authors.md):
where an indicator's data comes from, what each instrument has, the rules every
indicator follows (buy and sell sides, missing versus empty, capabilities), and
a worked example. Indicators live one folder each under
`apps/web/src/lib/indicators/`, and `apps/web/src/lib/chart/indicatorRegistry.ts`
is the authoritative registry. Every settings dialog has named presets; what a
new dialog declares for them is in
[setting presets](docs/architecture/indicators/setting-presets.md).

Before opening a pull request:

```powershell
npm run check     # docs check, lint, every workspace's tests, production web build
```

There is no repo-wide formatter. Match the style of the surrounding code, and
keep format-on-save from reflowing lines you are not changing: a
whitespace-only rewrite buries the real diff and collides with every other
branch touching that file. `.editorconfig` pins indentation, newline and
charset.

## Run modes

| Command (from `apps/runtime`) | Behaviour |
|---|---|
| `npm run dev` | Restarts the runtime when you edit its source. dxFeed connects when you select a dxFeed instrument. |
| `npm start` | The same without watching. |
| `npm run dev:dxfeed:live` | Connects every governed dxFeed instrument at start and keeps them live until stopped. Needs layer 2. |

For a stable frontend, run `npm run build --workspace web` from the repository
root, then
`npm run preview --workspace web -- --host 127.0.0.1 --port 8000 --strictPort`
instead of `dev`. Preview serves the built files; rebuild to pick up edits.

To share the frontend through a tunnel such as ngrok, set both of these before
starting the matching process:

```powershell
$env:EXTRA_ALLOWED_ORIGIN = "https://<host>.ngrok-free.dev"   # Terminal C
$env:VITE_ALLOWED_HOST    = "<host>.ngrok-free.dev"           # Terminal D
```

## Historical Mode

With layer 1 configured, choose **Historical Mode**, then an instrument and a
timeframe. Candles come from the archive's 1m, 1h and 1d rungs; indicators that
need trade data (volume and delta profile, VPIN, large trades) and buy/sell flow
ask the host for a study over what is on screen. Without layer 1, Historical
Mode says it needs host data access. The browser only ever holds your bearer,
never an S3 key or an internal service secret.

The first intraday view loads a recent bounded window; panning near either edge
fetches the adjacent window under the same immutable archive snapshot. At most
5,000 intraday bars are kept. Daily, weekly and monthly views fit the whole
published range.

## dxFeed sessions

With layer 2, each dxFeed selection opens a short-lived session with a fresh
token from the broker. Nothing secret is stored in `.env`, and only a token's
length and expiry are logged. The dxFeed account is monitored: open sessions
when you mean to use them, and stop the runtime with Ctrl-C when you are done.

Planned token rotations repeat for as long as you keep the instrument selected.
An unexpected disconnect gets **one automatic retry after 120 seconds, then a
hard stop**; successful recovery does not replenish it, and a browser reconnect
cannot reset it. Reselect or reload after investigating. Authentication,
configuration and capacity faults fail closed. Switching away, or the last
browser tab closing, ends a session.

`TT_DXFEED_TOKEN_TIMEOUT_MS` (default `30000`) bounds how long one token request
may wait for the broker.

## Lifecycle and incomplete data

A fatal browser worker failure clears market state and needs a deliberate
reload. Ordinary socket failures reconnect automatically. Background-tab queues
are bounded: an overflow clears the affected outputs and shows **Analytics
incomplete — reload to rebuild**. A new connection or selection rebuilds from
available history; complete event replay is not promised.

Runtime logs carry the run ID, PID and parent PID. Wait for shutdown to finish
after Ctrl-C; a failed shutdown or log flush exits nonzero.

## Layout

Organized concept-first: **who provides the data**, **what is computed from
it**, and **the platform underneath**.

```text
apps/runtime/src/          Node/CommonJS
  providers/               where data comes from
    binance/  dxfeed/  shared/
  indicators/              what gets computed on the server
    volume-profile/  vpin/  large-trade/
  server/                  routing and the wire only
                           provider-router.js switches a client between providers
  storage/                 persistence and the local or host-backed readers
  platform/                logging, telemetry, health monitoring
  archive/                 archive-query gateway foundations

apps/runtime/scripts/      grouped by purpose
  collect/ serve/ migrate/ verify/ qualify/ maintain/

apps/web/src/              React/TS/Vite, lightweight-charts
  lib/chart/               shared chart plumbing, nothing indicator-specific
  lib/indicators/          one folder per indicator, owning all of it:
                           computation, geometry, primitive and settings
  lib/archive/             Historical Mode: archive pages and host studies
  components/chart/        ChartPanel, MainPanel, DomPanel, TapePanel, Terminal
  components/chrome/       menus, legend rows, toolbar, logo
  hooks/ workers/ types/

config/market-instruments.json
  The governed instrument catalog: every symbol, market kind, asset class,
  order source and dxFeed tick size the runtime accepts. Validated at load, so
  a malformed entry stops the process instead of silently degrading a feature.
  See config/README.md for the futures-rollover procedure.
```

Web tests sit in `tests/` folders beside the code they cover; runtime tests
mirror the source tree under `apps/runtime/test/`.

## Documentation

The [developer handbook](docs/README.md) is the entry point for architecture,
contracts, storage and access. `docs/architecture/` holds final-state guides
and dated evidence; `docs/contracts/` holds the versioned wire, API and storage
contracts. Both are kept in sync with the code.

**Operators:** the host, conversion, publication and laptop-side operator tasks
(local collectors, Historical Mode straight from S3, storage maintenance, raw
backfill, offline qualification) are in the
[server runbook](docs/operations/03-server-runbook.md), the
[archive runbook](docs/operations/04-archive-runbook.md) and
[operator tooling on a laptop](docs/operations/08-operator-tooling.md). Their
settings are in `.env.operator.example`.
