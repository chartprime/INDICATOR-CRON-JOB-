# Archive query service

The separate historical L2 route and reader are described in [Historical L2 service](10-historical-l2-service.md). Their activation does not change the candle/L1 contract below.

[Handbook](../README.md) · [Hosted platform](01-hosted-platform.md) · [Archive query contract](../contracts/archive-query/v1/archive-query-v1.md)

The archive query service is a one-process Python service that reads the local
catalog and verified Parquet cache as `ttquery`. It binds only to
`127.0.0.1:8002`. It is not an internet-facing endpoint, and the browser never
contacts it directly.

The supervised `terminal-archive-query.service` and
`terminal-archive-gateway.service` implement this boundary. The Python service
remains loopback-only; the gateway authenticates archive callers and reaches
only that service. The gateway defaults to loopback. The reviewed private lab
topology permits its WireGuard address `10.88.0.1`, never the public NIC. The
Python service never accepts browser credentials.

## Security and activation invariants

These requirements apply to first activation, redeployment, credential
rotation, and incident recovery. Do not infer that they hold merely because a
unit is active:

1. A supervised Node gateway runs in the same host or network namespace as the
   Python unit and reaches only `http://127.0.0.1:8002/query`.
2. The gateway's protected environment contains `TT_ARCHIVE_CLIENT_TOKENS`,
   `TT_ARCHIVE_SERVICE_URL`, and the same `TT_QUERY_SERVICE_SECRET` that is in
   `/etc/terminal-l1-l2/query/service.env`. Browser tokens and the service
   secret remain separate credentials.
3. The browser reaches the Node gateway only across the independently
   authenticated lab WireGuard network, where the gateway binds `10.88.0.1`.
   Do not bind the Python unit beyond loopback, use the public NIC, or put the
   shared service secret in a browser build.
4. `prepare-query-role.sh` has granted `ttquery` read-only access to curated
   data, installed the reviewed provider source map at
   `/srv/terminal-data/query-catalogs/archive-sources.json`, and created the
   owner-only cache directories. Both provider snapshot roots contain a readable
   `CURRENT.json` produced by the verified catalog-sync operation before the
   query unit starts.
5. The query IAM identity is proven to read only the intended curated objects.
   It must not write, delete, list unrelated data, or access raw data.
6. A real catalog/S3 request passes through the actual gateway and Python
   process, returns a schema-valid page, pages without duplication, rejects an
   unauthenticated caller, and records cold and warm latency separately.

The unit deliberately has one process. Snapshot tokens and cursor signatures
are process-local, so a second instance would invalidate an in-progress page
chain unless shared session state or explicit request affinity is added first.

## Historical Mode paths

The host-backed path is how developers use Historical Mode (layer 1 in
[onboarding](00-developer-onboarding.md)). A developer with their own WireGuard
peer and gateway bearer sets `TT_ARCHIVE_PROXY_URL=http://10.88.0.1:8001` and
`VITE_ARCHIVE_CLIENT_TOKEN=<issued-token>` in the repository `.env`, then runs
only Terminal C and Vite. The Vite proxy keeps `/ws` and `/health` on Terminal
C and sends `/archive` to the host gateway. Vite reads those proxy values while
it starts, so restart it after changing them. This path needs no laptop S3 key,
local Python query service, local Node gateway, or catalog sync. It does not
centralize live ticks.

The gateway also serves `/archive/study`, which computes profiles, VPIN, large
prints and bar flow from the derived trade families on the host
([contract](../contracts/archive-study/v1/archive-study-v1.md)). The archive
service admits two reads at a time overall and one per client. Each client has
72 reads a minute for chart pages and a separate 360 a minute for studies,
under the client id `<clientId>.study`, so a study never spends the chart's
budget. A study pinned to the chart's snapshot keeps that budget: the archive
resolves a viewer's pointer token for its `.study` name. Deploy the archive query
service before the gateway when this changes; until then the gateway falls back
to the viewer's own name for a pinned study, which works but shares the chart's
budget.

### Local S3-backed fallback (operators)

Historical Mode runs entirely on the operator's machine, with the read-only
query S3 identity that developers are never given; the laptop steps are in
[operator tooling](08-operator-tooling.md#historical-mode-from-s3-on-a-laptop). It does not use the
Poland host, the collector, or any conversion service. It reads the two
historical control pointers below and the immutable candle objects they name:

```text
curated/databento/_historical/_catalog/CURRENT.json
curated/binance/_historical/_catalog/CURRENT.json
```

The query identity requires `GetObject` on those exact control objects and
their curated data objects. It deliberately does not require bucket listing,
write permission, raw-data access, or access to the live L1 catalog.

Before starting a local workspace, place the protected query credentials,
`TT_QUERY_SERVICE_SECRET`, `TT_ARCHIVE_SERVICE_URL`, and
`TT_ARCHIVE_CLIENT_TOKENS` in the repository-root `.env`. Set
`TT_ARCHIVE_CLIENT_TOKENS` to `terminal-web:<browser-token>` and set
`VITE_ARCHIVE_CLIENT_TOKEN` to that same `<browser-token>` in that same file.
Vite uses the repository root as its environment directory. The browser receives
only that bearer token; it never receives the S3 credentials or the service
secret. Do not commit any of these values.

Create a local source map from the committed example. The file contains paths
only, so it belongs beside local caches rather than in the repository:

```powershell
New-Item -ItemType Directory -Force C:\ttq\historical-mode | Out-Null
Copy-Item .\apps\runtime\conversion\archive-sources.example.json C:\ttq\historical-mode\archive-sources.json
```

Synchronise both verified catalog snapshots before starting the Python service.
Each command only writes the local reader root; neither changes S3.

```powershell
Set-Location .\apps\runtime\conversion
uv run --frozen python archive_catalog_sync.py --bucket chartprime-historical-data --catalog-prefix curated/databento/_historical --catalog-root C:/ttq/historical-mode/catalogs/databento
uv run --frozen python archive_catalog_sync.py --bucket chartprime-historical-data --catalog-prefix curated/binance/_historical --catalog-root C:/ttq/historical-mode/catalogs/binance
uv run --frozen python archive_http.py --bucket chartprime-historical-data --curated-prefix curated --sources-file C:/ttq/historical-mode/archive-sources.json --min-free-disk-bytes 8589934592
```

Leave that service running, then start the local Node runtime gateway on port
8001 and Vite on port 8000 using the normal repository commands. The Vite
process must inherit `VITE_ARCHIVE_CLIENT_TOKEN`; the Node process must inherit
the other archive variables. Vite proxies `/archive` to the gateway. A browser
can then select BTC, ETH, AAPL, or TSLA and receive one bounded archive page.
ES and NQ use the Historical Mode client's explicit, source-validated contract
roll manifest. It requests every contract intersecting the displayed window
under one snapshot token, refuses an incomplete sequence, and labels each
roll on the chart. The screen never substitutes a single quarterly contract
for a continuous series.

The Historical Mode client begins an intraday selection with a recent
500-display-bar window and fetches an adjacent window when the user pans within
100 logical bars of either retained edge. It retains at most 5,000 intraday
display bars; an evicted side is re-read under the same snapshot if the user
returns to it. `1D`, `1W`, and `1M` views retain the whole published range.
The archive contract's 10,000-row page limit remains a transport limit, and the
service also closes a page at 8 MiB of encoded rows, so a window of roughly
5,500 or more one-minute candles arrives as a cursor chain. The client follows
that chain before it renders. A cursor, snapshot, fingerprint, family, or
coverage mismatch fails the window rather than drawing a partial series; each
page's `coverage.served` is that page's own span by contract, so the client
compares coverage without it, requires the served spans not to move backwards,
and reports the union of the spans it joined.

## Refreshing the historical control pointer

The service reads the `_historical` control namespace
(`curated/<provider>/_historical/_catalog/CURRENT.json`), not the converter's
own catalog. Newly converted families become visible only when a snapshot that
lists them is published there and the reader root is synced. The converter
catalog and the served catalog are separate lineages, so the served snapshot is
a reconciliation of the two. This chain was run for the Databento L1 refresh on
2026-09-21 (fence 48 → 49, 3,384 → 6,886 partitions); every step runs on the
host through `systemd-run` with the owning role's `EnvironmentFile`, one
approval each, and nothing restarts.

1. **Reconcile** as `ttconvert` with the convert environment:
   `catalog_reconciliation.py --parent-snapshot <served sqlite> --parent-sha256 <served sha> --addition-snapshot <converter CURRENT sqlite> --addition-sha256 <its sha> --output <work>/_catalog/<new key>.sqlite --dataset-version <new version>`.
   Authority is `(instrument, family, date)`; a value that differs between the
   two inputs stops the merge. Copy the served snapshot into the work directory
   first: the reader root is `ttquery`-owned and not readable by `ttconvert`.
   For an identical carried-forward partition, the served and converter
   snapshots may differ only in `published_to_s3`; reconciliation retains true
   if either snapshot has it. An identical dataset version may differ only by
   `PUBLISHED` versus `SUPERSEDED`; reconciliation retains `SUPERSEDED`.
   Identity, content hashes, timestamps and every other field must still match.
   Step 3 verifies every merged partition against S3 before it can be served.
2. **Pointer**: write `<work>/pointer.json` from the served `CURRENT.json` as
   the template, with the new `dataset_version`, `catalog_key`,
   `catalog_sha256`, `published_at` and the next `publisher_fence`. The
   published pointer must carry exactly the contract's eight fields — the
   archive-query response schema forbids additional pointer properties.
3. **Attest** as `ttconvert`, but with the **query** environment file:
   `catalog_attestation.py --catalog-root <work> --pointer <work>/pointer.json --output <work>/attested-root/_catalog/<new key>.sqlite --bucket <bucket> --data-prefix curated/<provider>`.
   The tool builds its S3 client from `TT_QUERY_S3_*`, which only the query
   environment carries, and `--catalog-root` is the directory above
   `_catalog/`. It verifies every catalogued partition's manifest and part
   checksums against S3 (6,886 partitions took 227 s) and prints the attested
   pointer, which includes two extra bookkeeping fields to drop before step 4.
4. **Publish** as `ttconvert` with the convert environment:
   `s3_publish.py --curated-root <work>/attested-root --intent <work>/intent.json --bucket <bucket> --catalog-control-prefix curated/<provider>/_historical --data-prefix curated/<provider>`
   where the intent is `{"pointer": <eight-field attested pointer>, "parent": <served CURRENT.json>}`.
   It verifies the partitions again, refuses if any parent authority is
   missing or changed, then writes intent → immutable snapshot → `CURRENT`
   (conditional on the parent's ETag) → receipt. Re-running with the same
   intent is idempotent.
5. **Sync** as `ttquery` with the query environment:
   `archive_catalog_sync.py --bucket <bucket> --catalog-prefix curated/<provider>/_historical --catalog-root /srv/terminal-data/query-catalogs/<provider>`.
   The snapshot lands next to the previous one and `CURRENT.json` is swapped
   atomically; the registry re-reads the root on the next pin, so no restart.
   Rollback is the same chain with the previous pointer as the intent.
6. **Prove** with one real page per family through the gateway and confirm the
   response's `pointer.publisher_fence` is the new one.

The Historical Mode browser gates Binance trade-study selection on a bounded
read of all four derived families for the first accepted trade day, pinned to
the same served catalog token as its candle page. This proves the selected
snapshot exposes those families at that day; it is not a proof of all 360 days.
Each study response must still account for its requested range as complete,
empty or missing. The accepted trade window starts 2025-09-06, while Binance
candles may begin 2025-09-01. Verify every derived family and date in the
published catalog during the served refresh before claiming full coverage.

**Serving a correction.** When the converter catalog replaced published days
(runbook 04, "Publish a correction"), the served snapshot differs from it on
exactly those authorities, and both step 1 and step 4 refuse a changed day by
default. Pass the owner-approved allowlist to step 1 with
`--supersede-allowlist <file>` (the same `{reason, approved_by, authorities}`
file the correction used). For those authorities the addition's row replaces
the served one, any other conflict still stops the merge, and the output's
`supersedes` lists exactly the days replaced. Put that record in the step 4
intent as `"supersedes"`; publication verifies that exactly those
authorities changed and records it in the intent and receipt.

## Query role preparation

`ops/linux-host/scripts/prepare-query-role.sh` is an idempotent privileged
operation. It installs the reviewed provider source map atomically, creates the
cache root, and gives `ttquery` read and search access to curated data through
POSIX ACLs. It does not change ownership of curated data and asserts that
`ttquery` cannot write it. Run it only after reviewing the active data mount and
before enabling or restarting the unit.

## Operational acceptance evidence

Retain the release identifiers, effective systemd unit, query-role ACL output,
IAM evidence, request and response hashes, catalog pointer, cache hit/miss
metrics, and the exact command used for the gateway-to-service proof. A green
unit status only means the process is listening; it does not prove that the
gateway, credentials, catalog, S3 access, cache, or browser path works.
