# Operator tooling on a laptop

[Handbook](../README.md) · [Server runbook](03-server-runbook.md) ·
[Archive runbook](04-archive-runbook.md) · [Archive-query service](06-archive-query-service.md)

Everything on this page is for the owner and operators. A developer building
indicators needs none of it: the host already runs the collectors, the archive
and the gateway, and [onboarding](00-developer-onboarding.md) covers everything
a developer does. The settings these tasks need are in
`.env.operator.example`; copy the sections you need into the same
repository-root `.env`.

## Local collectors

The hosted collectors normally own capture. Running one on a laptop builds a
local SQLite history that the local runtime reads for warm-up when no
`TT_LIVE_STORAGE_SERVICE_URL` is set. Each captures every instrument in the
governed catalog and takes no arguments.

```powershell
cd apps/runtime
npm run collector              # Binance
npm run collector:dxfeed:live  # dxFeed; needs TT_DXFEED_TOKEN_BROKER_URL and opens a real session
```

Never run a laptop collector alongside the hosted one for the same purpose, and
stop it yourself when you are done: a dxFeed collector holds a licensed session
open for as long as it runs.

## Historical Mode from S3 on a laptop

The normal Historical Mode path is the host gateway over WireGuard. This local
path serves the same archive from S3 on the laptop and needs the read-only
`TT_QUERY_S3_*` identity, which developers are never given.

When its archive settings are present, the local runtime on port 8001 also
serves the authenticated `/archive/query` route. The hosted gateway fronts the
hosted query service instead and binds only to `10.88.0.1`. Do not run both on
one machine.

A local, read-only workspace. It never contacts Poland, a collector, or a
conversion job — its Python query service binds only to `127.0.0.1:8002`, and
the browser reaches it through the local Node route on `8001` and Vite's
`/archive` proxy.

### One-time setup

1. Add to the repository root `.env` (keep out of Git): the read-only
   `TT_QUERY_S3_*` identity, `TT_QUERY_SERVICE_SECRET`, `TT_ARCHIVE_SERVICE_URL`,
   and `TT_ARCHIVE_CLIENT_TOKENS=terminal-web:<browser-token>`.
2. Add this to the repository-root `.env`:
   ```text
   VITE_ARCHIVE_CLIENT_TOKEN=<browser-token>
   ```
   The browser token and the Python-service secret are different credentials —
   the browser receives only the former, never S3 credentials or the service secret.
3. Create the source map once, from the repository root:
   ```powershell
   New-Item -ItemType Directory -Force C:\ttq\historical-mode | Out-Null
   Copy-Item .\apps\runtime\conversion\archive-sources.example.json C:\ttq\historical-mode\archive-sources.json
   ```

### Start it

Three terminals. `--env-file` loads the protected local values without
printing them.

```powershell
# 1 - sync catalog snapshots, then leave the Python query service running
cd Terminal-L1-L2\apps\runtime\conversion
uv run --frozen --env-file ../../../.env python archive_catalog_sync.py --bucket chartprime-historical-data --catalog-prefix curated/databento/_historical --catalog-root C:/ttq/historical-mode/catalogs/databento
uv run --frozen --env-file ../../../.env python archive_catalog_sync.py --bucket chartprime-historical-data --catalog-prefix curated/binance/_historical --catalog-root C:/ttq/historical-mode/catalogs/binance
uv run --frozen --env-file ../../../.env python archive_http.py --bucket chartprime-historical-data --curated-prefix curated --sources-file C:/ttq/historical-mode/archive-sources.json --min-free-disk-bytes 8589934592
```

```powershell
# 2 - the normal local runtime; it auto-loads the root .env
cd Terminal-L1-L2\apps\runtime
npm start
```

```powershell
# 3 - the frontend
cd Terminal-L1-L2\apps
npm run dev --workspace web
```

Open **http://127.0.0.1:8000/**, choose **Historical Mode**, then a symbol and timeframe.

### Behavior

- The service reads immutable catalog pointers under
  `curated/databento/_historical/_catalog/` and `curated/binance/_historical/_catalog/`.
  Their records intentionally refer to the doubled provider paths
  `curated/databento/databento/...` and `curated/binance/binance/...`.
- The first intraday view requests a recent bounded window; panning near
  either edge fetches the adjacent verified window under the same immutable
  snapshot. Only 5,000 intraday display bars are retained. Daily, weekly and
  monthly views fit the full published range.
- See [the archive-query runbook](06-archive-query-service.md)
  for the service security boundary and hosted deployment gate.

## Storage maintenance

Run from `apps/runtime`. **Stop the relevant collector first**: the dxFeed
writer is deliberately validate-only and refuses an old schema rather than
migrating mid-capture. The runbook defines ordering and acceptance gates.

| | Binance | dxFeed |
|---|---|---|
| Apply schema migrations | `migrate:storage-schema` | `migrate:dxfeed-storage-schema` |
| Check integrity | `verify:storage-integrity` | `verify:dxfeed-storage-integrity` |
| Continuity audit | `audit:storage-continuity` | `audit:dxfeed-order-book-continuity` |
| Acceptance gate | `qualify:collector-storage` | `qualify:dxfeed-storage` |

| Command | Purpose |
|---|---|
| `maintain:storage` | Reclaim free pages after a migration drops data or indexes |
| `backup:manual` | Back up the stores to the configured drive |
| `qualify:server-live` | End-to-end check against a running server, both providers |

dxFeed connection probes — each **opens a real session**, so use deliberately:
`verify:dxfeed-auth:live`, `verify:dxfeed-capability-probe:live`,
`verify:dxfeed-extended-probe:live`,
`verify:dxfeed-order-book-feasibility-probe:live`,
`verify:dxfeed-storage-capture:live`.

## Raw data backfill

`npm run backfill:tardis:live` and `npm run backfill:databento:live` (from
`apps/runtime`) pull missing raw provider history into local storage. Each
makes a real, potentially billed request to a live provider — use them
deliberately, and preview first:

```powershell
# Tardis - preview then run
npm run backfill:tardis:live -- --dry-run          # lists every gap it would close; pulls nothing
npm run backfill:tardis:live                       # cost-guards each gap, streams only missing days

# Databento - preview then run
npm run backfill:databento:live -- --quote-only    # runs the $0 cost-guard quotes; pulls nothing
npm run backfill:databento:live                    # closes the ~1-month staleness; extends L2 while the free window lasts
```

This is local raw acquisition, separate from the hosted conversion worker —
see the [archive runbook](04-archive-runbook.md) for that.

## Offline pipeline qualification

From the repository root, after building the web app:

```powershell
node apps/runtime/scripts/qualify/qualify-day3-pipeline.js 300 day3-pipeline.json
node apps/runtime/scripts/qualify/qualify-day3-browser.js 'C:/Program Files/Google/Chrome/Application/chrome.exe' 60 day3-browser.json
```

These use isolated stores, local fixture feeds and an isolated browser profile.
Choose a new report filename for each run. The pipeline checks eight-client
delivery, durable counts, history-query interference and local backup/restore;
the browser measures tape DOM updates in the production build. Synthetic
results do not certify peak-market capacity or cloud archive content.

Historical backfill compares expected object paths, including interior gaps,
and stops if inventory cannot be read reliably. Uploads own their source stream
and rclone process through completion, with a 15-minute deadline. Uploaded or
listed objects still need the provider content/reconciliation checks before
they count as verified historical coverage.
