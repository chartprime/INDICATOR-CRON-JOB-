# Live-storage benchmark manifests

These manifests freeze the first O2 workload shape. They use exact timestamps
so repeated runs query identical data and can be compared across revisions.
They do not contain credentials.

Set `TT_BENCH_LIVE_STORAGE_URL` to the authenticated gateway path ending in
`/live-storage` and set `TT_LIVE_STORAGE_CLIENT_TOKEN` to the developer token.
Then run, from `apps/runtime`:

```powershell
npm run bench:live-storage -- ../../benchmarks/live-storage/one-user-binance.json
npm run bench:live-storage -- ../../benchmarks/live-storage/five-user-binance.json
npm run bench:live-storage -- ../../benchmarks/live-storage/one-user-dxfeed.json
npm run bench:live-storage -- ../../benchmarks/live-storage/five-user-mixed.json
npm run bench:live-storage -- ../../benchmarks/live-storage/one-user-binance-replay-4h.json
```

An optional second argument writes the report atomically instead of printing it:

```powershell
npm run bench:live-storage -- ../../benchmarks/live-storage/one-user-binance.json ../../benchmarks/results/process-cold-one-user.json
```

The runner executes each virtual user sequentially within that user's stream,
starts all user streams together, generates a unique correlation ID for every
request, and prints raw samples plus per-route and aggregate p50/p95/p99. Save
the JSON alongside the revision, host/database size, cache state, and UTC test
interval. Run cold and warm states at least five times; do not compare results
that used different manifests.

Every sample includes a SHA-256 digest of the exact response body and an
explicit failure class. `responseBytes` is the body as the runner received it
(inflated); `wireBytes` is the gateway's declared `content-length`, which is
the compressed size when the response carries `contentEncoding: "gzip"`
(the gateway gzips bodies of 1 KiB and more for clients that accept it, from
2026-09-21). Compare a before/after pair without treating latency or wire
size as part of semantic equality:

```powershell
npm run bench:live-storage:compare -- before.json after.json
```

`DATA_UNAVAILABLE` is distinct from transport, authentication, admission,
request, and service failures. Provider-session failures observed outside this
HTTP path must be recorded separately; do not relabel them as storage latency.
The minute-rollup requests use the production volume-profile cache grain of 32
instrument ticks (`0.32` for BTCUSDT and AAPL at a `0.01` catalog tick). A raw
one-tick rollup is a separate stress workload: over this seven-day BTC window it
materializes millions of rows and is not representative of the actual warm-up
caller.

The fixed endpoint timestamp is `2026-09-18T00:00:00.000Z`. Update by creating
a new versioned manifest instead of silently editing historical benchmark
inputs.

The four-hour replay manifest freezes `2026-09-17T20:00:00.000Z` through
`2026-09-18T00:00:00.000Z` and follows signed cursors until completion (with
an explicit 20-page experimental ceiling). It measures page cost and density;
it does not claim full-window completion. Run it into a distinct report file
for every repetition; a sibling `.samples.jsonl` is appended after every page
so an interruption retains valid partial evidence. Do not use `rounds` to
combine cold and warm runs because that would erase their cache-state boundary.

`one-user-binance-replay-4h-sparse.json` is the same frozen window with
`bookMode: "sparse"`: a READY book frame then carries the whole book only where
the consumer must seed or resync from it (the first READY frame after each
page's anchor, and after any gap) and only its best prices otherwise. The
default, and every older manifest, is `bookMode: "full"`, which repeats the
whole book on every frame. Run both against the same host to measure the wire
saving; frame kinds and deltas are identical between the two.

## Archive requests

A request with `"kind": "archive-query"` (and `"route": "archive-query"`) is
sent to the archive gateway's fixed `/archive/query` path instead of a
live-storage route. Its `body` must carry `instrumentId`, `family`, `from` and
`to`; the runner adds `contractVersion: "archive-query/1"`. Pagination puts the
returned `nextCursor` and the pinned `pointerToken` at the top level of the
next request. The archive manifests live in `benchmarks/archive/`.

| Variable | Meaning |
| --- | --- |
| `TT_BENCH_ARCHIVE_TOKEN` | Archive bearer token. Falls back to `VITE_ARCHIVE_CLIENT_TOKEN`. Required only when the manifest has archive requests. |
| `TT_BENCH_ARCHIVE_URL` | Optional. Overrides the origin the archive path is resolved against; by default it is the origin of `TT_BENCH_LIVE_STORAGE_URL`. |
| `TT_LIVE_STORAGE_CLIENT_TOKEN` | Live-storage bearer token. Required only when the manifest has live-storage requests. |

Archive reports record only the bounded `scan` fields the gateway contract
already exposes. Stage timings (`admissionWaitMs`, `fetchMs`, `queryMs`, and so
on) are not part of the versioned response; read them from the Python service's
`/health` `telemetry` block instead.

## Report identity

Every report written by `bench:live-storage` carries a `source` block so a
result can be traced to the exact inputs that produced it:

- `git.commit`, `git.dirty`, `git.trackedChanges`, `git.untrackedFiles` and
  `git.trackedDiffSha256` (a digest of `git diff HEAD --binary`, or `null` when
  no tracked file differs). A clean commit hash alone would overstate the
  claim for a working tree with uncommitted edits, so the digest pins those
  edits. Untracked files are counted but not hashed.
- `scriptSha256` and `manifestSha256`: digests of the exact bytes of the runner
  and of the manifest file, not of the parsed JSON.
- `nodeVersion`, `contractVersions` and `endpoints` (origin only, never a token,
  path, query or credentials, and only for the request kinds the manifest uses).

The block identifies the client tool and the workload. It cannot identify the
server revision under test, because the client cannot see it; record the
deployed release separately, or pull it from the server's own telemetry.

`bench:live-storage:compare` treats a manifest mismatch as a semantic
difference. Missing identity (a report written before this block existed), a
dirty tree and a changed runner script are surfaced under `warnings`. Pass
`--strict-identity` to turn every one of those warnings into a failure; use it
for any comparison that will be cited as evidence.

Samples are matched on user, round, request index, route **and page**, so
every page of a paginated request is compared. A report with a repeated key is
reported as ambiguous instead of being collapsed to its last sample, and a
pagination that ended earlier in one report than the other is reported as
missing pages.

## Cancellation workloads

A request may carry `"abort": { "afterMs": N }` (1 to 600000). The runner's own
timer aborts that request after `N` ms, so a manifest can model a browser that
navigates away mid-request. The `cancel-*` manifests do this for replay pages,
the seven-day minute rollup, an archive query, and a five-user rapid
start/abort storm.

Failure classes are strict about who ended the request:

| Class | Meaning |
| --- | --- |
| `CLIENT_ABORTED` | The benchmark's own abort timer fired first and the request ended with the abort error. |
| `CLIENT_TIMEOUT` | The runner's overall timeout (`TT_BENCH_TIMEOUT_MS`, default 60 s) fired first. |
| `PROCESS_INTERRUPTED` | The runner received SIGINT or SIGTERM. In-flight requests are aborted, nothing new starts, and the report is written with `interrupted: true`. |
| `TRANSPORT_FAILURE` | Any other failure to complete the request, including a remote socket closure. |
| `SERVICE_FAILURE` | The server answered with a 5xx status, including a server-side timeout. |

A sample with a requested abort records `abort: { afterMs, fired }`. If an abort
was issued but the request ended some other way (the response finished first, or
the socket failed at the same moment) the sample keeps its real classification
and carries `abortRaced: true`; a completed response always wins the race. A
response that had already delivered its headers keeps that `status` if the abort
lands during the body.

`bench:live-storage:compare` does not compare the status, body digest or failure
class of a sample that requested an abort, because which side wins the race is
timing, not contract. It reports `abortSamples` with the outcome distribution on
each side instead, and still fails on a missing sample. Compare cancellation
runs by that distribution and by `serverDelta`.

## Server delta

A manifest with `"serverDelta": true` scrapes the live-storage service's
unauthenticated `/health` before the run and after it, waits up to
`TT_BENCH_HEALTH_SETTLE_MS` (default 5000) for `inFlight` to fall back to its
starting level, and records the per-route counter differences (`requests`,
`cancelled`, `timedOut`, `overloaded`, `coalesced`, cache hits and misses, and
failure reasons). Set `TT_BENCH_HEALTH_URL` to the service's `/health` URL; it is
normally only reachable from the host, so run such manifests there.

The delta is always labelled `attribution: "HOST_WIDE"`. The server keeps
cumulative counters with no per-request attribution, so the difference includes
every request the host served between the two scrapes, including other users. The
report gives two ways to judge how far to trust it:

- `unattributedRequests` per route is the number of requests the server counted
  beyond the ones this run made. Anything above zero proves other traffic was
  present. Zero does not prove isolation: requests aborted before they reached the
  server are not counted, which can hide other traffic.
- `inFlight.drained` is `true` when the in-flight count returned to its starting
  level within the settle window, `false` when work was still running (for
  example an abandoned coalesced query), and `null` when the service did not
  report it.

Never cite a delta as the benchmark's own cost unless `unattributedRequests` is
zero on every route and the host was otherwise idle. A restart between the
scrapes is reported as `SERVER_COUNTERS_RESET` and an unreachable health endpoint
as `HEALTH_UNAVAILABLE`; neither discards the run's samples.

## Deep tier

The `deep-*` manifests are the heaviest shapes the service accepts, each in its
own file so cold and warm runs stay separate:

| Manifest | Shape |
| --- | --- |
| `deep-binance-replay-11h` | Paginated replay, 11 h window, 60-page ceiling |
| `deep-binance-replay-1d` | Paginated replay, 24 h window, 100-page ceiling |
| `deep-binance-daily-notional-21d` / `-31d` | `daily-notional`; 31 days is the route maximum |
| `deep-binance-minute-rollup-31d` | `minute-rollup` at the production 0.32 grain over the 31-day route maximum |
| `deep-binance-large-trades` | 45,000-row limit, plain and hour-bucketed over seven days |
| `deep-binance-aggressive-prints-1d` | 20,000-row limit over one day |
| `deep-binance-volume-profile-7d` | Seven days at a USD 10 row width |

The pagination ceilings are experimental caps, not claims of completion: a report
states how many pages were fetched and whether a cursor remained. A unit test
checks every committed manifest against the service's own request validators, so a
manifest the route would reject fails the test suite instead of a benchmark run.

## WebSocket fan-out

`benchmarks/ws/*.json` are a separate manifest kind (`"kind": "ws-fanout"`) run
by `ws-fanout-load.js`, not by `bench:live-storage`:

```powershell
node scripts/bench/ws-fanout-load.js ../../benchmarks/ws/fanout-8-clients-1k-trades.json ../../benchmarks/results/ws-fanout-8-run-01.json
```

The runner starts the real application server in this process (the same
`createApp` the production entry point uses, with an offline Binance
connection), connects real `ws` clients to it over loopback, feeds a
deterministic seeded trade stream in through the exchange connection, and
reports what each client received. The stream has a random-walk price, an
exponential size distribution and about 1% large prints, from `upstream.seed`
(default 1). A constant price and size is not usable: it makes every trade a
large print, which floods the client with `marker` frames and produces a
delivery collapse that belongs to the input, not the server. Manifests are
strict about their keys, so a misspelled setting fails validation.

| Manifest | Shape |
| --- | --- |
| `fanout-8-clients-1k-trades` | 8 clients, 1000 trades per second, 20 s measured |
| `fanout-32-clients-500-trades` | 32 clients, 500 trades per second, 20 s measured |
| `slow-client-eviction` | One of four clients stops reading; thresholds shrunk to 300 KB / 3 MB / 300 ms; ends when the server evicts it |
| `slow-client-transient-stall` | One of four clients stops reading for three seconds and resumes; production thresholds; nobody is evicted |

What the report contains:

- `latencyMs.healthy`: end-to-end delay from the trade entering the server to a
  healthy client parsing its frame, pooled and per client. Everything shares one
  clock but the resolution is 1 ms, and client parsing runs on the same thread as
  the server, so the numbers measure this pipeline plus that client cost, not a
  network. Samples go into fixed-size one-millisecond histograms (60 s cap,
  exact maximum kept separately), so memory does not grow with the length of the
  run, the number of clients or the trade rate; the percentiles are exact nearest
  rank for whole-millisecond latencies.
- `timelineClient0`: one bucket per second for client 0 with trades received, the
  latency summary and the count of each non-trade frame type. Use it to tell a
  steady tail from a backlog that grows, and to see whether latency spikes line up
  with `snapshot` or `analytics_status` frames.
- `clients[].maxBufferedBytes` and, for slow clients, `bufferedSeriesMs`: the
  server-side `bufferedAmount` of each client's socket, sampled every
  `sampleEveryMs`.
- Eviction is observed on the server side, by watching the server's socket
  `close` and `terminate` calls, because a client that has stopped reading never
  sees the close frame. `serverClose` carries the code (1013 for a slow client)
  and the time since measurement began.
- `invariants`: `producerKeptUp` (the injected rate reached 95% of nominal),
  `healthyClientsReceivedEverySentTrade`, `duplicatesOrReordered`,
  `gapsOnHealthyClients` (trade ids skipped inside the measured window),
  `slowClientsEvictedByServer`, `serverCloseCodes`,
  `resumedSlowClientsReceivedEverySentTrade`, and `incidents`, which counts server
  telemetry events named dropped, overflow or fatal. A run with
  `producerKeptUp: false` or a non-zero `incidents` says more about the rig than
  the server.

Limits of the rig, measured on a development laptop with the seeded stream: three
clients at 5,000 trades per second are clean (p95 37 ms, no incidents), and at
10,000 per second the shared thread saturates (p95 above 400 ms and ingest
incidents). The committed manifests stay at or below 1,000 trades per second and
16,000 client deliveries per second. The server runs against an empty capture
database, so its background warm-up jobs retry and re-broadcast `snapshot` and
`analytics_status` frames for roughly the first five seconds; every manifest
warms up for six seconds before measuring. Server thresholds below the size of the
initial snapshot burst (about 100 KB) evict healthy clients during connect, so
shrunk thresholds must sit above it. Representative tails on real data need the
fixture-backed variant.

## Browser scenarios

`benchmarks/browser/*.json` (`"kind": "browser"`) are run by `browser-load.js`.
The runner serves the built web app from `apps/web/dist`, starts headless
Chrome under the DevTools protocol, and feeds it a synthetic server over a real
WebSocket. It measures what the page does with the frames, not what the server
does.

```powershell
npm run build --workspace web
node scripts/bench/browser-load.js ../../benchmarks/browser/steady-tape-500.json ../../benchmarks/results/browser-steady-500-run-01.json
```

Chrome comes from `TT_BENCH_CHROME_PATH` if set, otherwise the standard install
location for the platform (Program Files, Program Files (x86) or the local app
data directory on Windows). Manifests hold no host paths.

| Manifest | Scenario |
| --- | --- |
| `cold-start` | Navigate, connect, first trade committed to the DOM; 5 s |
| `steady-tape-500` | 500 trades per second for 30 s |
| `steady-tape-2000` | 2,000 trades per second for 30 s |
| `selection-change` | The server switches the selection from BTC-USDT to ETH-USDT at second 10 and the run measures how long the first new trade takes to appear |

The report has `timings` (navigation to WebSocket connect, first published trade
to first DOM commit, and for the selection scenario the selection frame to the
first new trade's DOM commit), `tape.eventToDomCommitMs` (a MutationObserver stamps
each tape row the moment it appears), long-task durations, heap and DOM-node
samples every five seconds, and `invariants` (every published trade reached the DOM,
no page errors, the tape stays bounded, the charts drew, the tape empties on
disconnect, and for the selection scenario the page honoured it). `tape.committed`
can be lower than `tape.published` at high rates because a row replaced within a
single frame is never observed; `newestCommittedId` is the completeness check.

`source.webDist` is a digest over the names and contents of every file in
`apps/web/dist`, and `source.browser` is the Chrome version. The digest identifies
the build that was measured; it does not prove the build came from the checked-out
commit, so rebuild before a run that will be cited.

These scenarios are workload definitions for later work. They deliberately do not
measure paint, input latency or indicator computation, and they do not enable the
indicator set; those belong to the browser phase of the audit. The real-browser
test in `browser-load.test.js` runs only when `TT_TEST_REAL_BROWSER=1` and needs
Chrome and a built `apps/web/dist`, so it is qualification evidence for a
developer machine, not a CI guard.

## O2 campaign

`benchmarks/o2/campaign-v1.json` is the executable O2 matrix. It keeps every
repetition in a separate process and report, distinguishes cold, warm and
neutral states, distinguishes progressive replay from full-window completion,
and includes explicit external cells where a local synthetic runner would be
misleading (all-indicator Chrome, a genuinely backgrounded tab, and five
independent WireGuard peers).

Validate and print every expected evidence slot:

```powershell
npm run bench:o2 -- plan benchmarks/o2/campaign-v1.json
```

Before each run, copy `benchmarks/o2/cache-evidence.example.json` outside the
results directory and fill it from current host/client observations. `cold`
must name the cache-clearing or fresh-generation procedure; `warm` must name
the exact priming request. A label alone is rejected. Execute one automated
slot without overwriting prior evidence:

```powershell
npm run bench:o2 -- run benchmarks/o2/campaign-v1.json binance-spot cold 1 cache-evidence.json benchmarks/results/o2-v1
```

The runner writes the raw report and a sibling `.evidence.json` containing its
digest, cache/data/release identity and acceptance result. External workloads
produce the small report specified by their procedure (`pass` plus the named
`metrics`) and enter the same evidence set through `import`:

```powershell
npm run bench:o2 -- import benchmarks/o2/campaign-v1.json browser-hidden-tab neutral 1 cache-evidence.json hidden-tab-report.json benchmarks/results/o2-v1
```

Once all slots exist, produce the deterministic SLO matrix and ranked pressure
list:

```powershell
npm run bench:o2 -- assess benchmarks/o2/campaign-v1.json benchmarks/results/o2-v1 benchmarks/results/o2-v1-assessment.json
```

Assessment is deliberately fail-closed: missing repetitions are `UNMEASURED`,
HTTP failures and incomplete required pagination fail, progressive replay may
stop at its declared page budget but may not contain failed pages, report
digests must match, and no missing metric is converted into a pass.

Every live-storage campaign cell requires `serverDelta` and is rejected when
the health scrape is missing, reports an error, or fails to drain. Keep the
request path on WireGuard and reach the service-only health endpoint through a
separate authenticated SSH local forward when running from a laptop; do not
publish `/health` merely to satisfy the benchmark. Archive-only cells retain
their own stage telemetry and the cache-evidence identity because the
live-storage counters cannot attribute archive work.

Cancellation cells declare `CLIENT_ABORTED` as their expected outcome rather
than pretending an intentional abort is a successful response. The storm cell
is explicitly marked as a multi-round burst; the campaign still executes five
bursts as five separate processes. Mixed and same-window five-user cells are
local shared-uplink capacity evidence. The independent-peer cell remains
external and cannot be substituted by five virtual users on one laptop.

Four-hour, 11-hour and one-day replay each have distinct progressive and
full-completion cells. The seven-day cell is progressive by design. Its
first-result/page latency is qualified; full seven-day reconstruction remains
`UNMEASURED` until materialization makes that promise operationally meaningful.

## Mutation ledger

`benchmarks/mutations/*.json` describe deliberate code mutations and the test
that must catch each one. Replay them with:

```powershell
npm run verify:mutation -- ../../benchmarks/mutations/o0-m1-comparator-and-identity.json
```

The runner first requires the suite to pass unmutated, applies the mutation,
requires the named test to fail, restores the file and verifies the restored
bytes by digest, and records the mutation's latest run in
`benchmarks/mutation-ledger.jsonl`, one line per mutant (mutation text, commit,
worktree state, baseline and mutated exit codes, the failing test names, and an
output digest); earlier runs are in git's history.
A surviving mutant or one caught only by an unrelated test exits non-zero.
