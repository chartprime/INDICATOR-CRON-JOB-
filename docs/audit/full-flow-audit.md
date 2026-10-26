# Full-flow audit

The working record of the full-flow audit on `audit/full-flow-refinement`:
the system map, the baselines every later change is measured against, and
the findings log. It is updated as the audit moves; Phase 3 folds the map
into the architecture docs.

## Plan

| Phase | What | Output |
|---|---|---|
| 0 | Map the system and measure it; no code changes | This document's map and baselines |
| 1 | Tooling: toolchain pin, mutation tool, ledger, stale specs, test speed, flaky tests, one gate command | Before and after timings |
| 2 | Audit in data-flow order: feeds, book engine, heatmap sampling and storage, server, browser data layer, indicators, chart, ops | Findings per area, fixed with a failing test and a mutant each |
| 3 | Docs against the code, dead code, stale reports and specs | Docs that match the code |
| 4 | Full gate and replay, before and after numbers, merge | Final report |

Severity: **critical** (wrong numbers shown, data lost, crash), **high**
(wrong under real conditions), **medium** (slow or wasteful), **low**
(cleanup). A change to what a trader sees goes to the owner first.

## System map

### Processes

| Process | Entry | Role |
|---|---|---|
| Runtime ("Terminal C") | `apps/runtime/scripts/serve/run-ws-server.js` → `src/server/app.js` | Provider sessions, the chart WebSocket `/ws`, `/health`, `/heatmap/columns`, `/heatmap/walls`, `/archive/*` |
| Collector | `apps/runtime/scripts/collect/run-collector.js`, `run-dxfeed-collector.js` | Records the feeds into the host's storage (owner's host only) |
| Live storage service | `apps/runtime/scripts/serve/run-live-storage-service.js` | Serves the host's recorded history to remote runtimes |
| Archive gateway | `apps/runtime/scripts/serve/run-archive-gateway.js` | Historical Mode queries and studies |
| Heatmap pyramid | `apps/runtime/scripts/serve/run-heatmap-pyramid.js` | Precomputed liquidity pyramid on the host |
| Web | `apps/web` (Vite) | The terminal: chart, panels, indicators |
| Conversion | `apps/runtime/conversion`, `tools/historical-conversion` (Python, uv) | Archive conversion, qualification, DuckDB reads |
| Host ops | `ops/linux-host` | systemd units, logrotate, frozen-release verification |

`run-stack.js` starts the runtime, optionally the collector, and Vite.

### Live data flow

1. **Feeds.** `providers/binance` (connection, book assembler, normalizer,
   backpressure queue, feed health, kline backfill) and `providers/dxfeed`
   (dxLink connector and handshake, token lifecycle and broker, book
   assembler, trade and candle adapters, session policy, instrument catalog).
   Both normalize into one canonical event shape (`data-contracts/v1`).
2. **Servers.** `server/market-data-server.js` (Binance, 3.7k lines),
   `dxfeed-market-data-server.js` (2.1k) and `dxfeed-eager-market-data-server.js`
   (2.6k), selected per client by `provider-router.js`; frames built in
   `frames.js`, `l2-frames.js`, `history-frames.js`; the L2 channels in
   `l2-channel.js`.
3. **Book memory.** `indicators/l2-memory`: the memory engine and level
   ledger, compact lanes, the liquidity store, the pyramid, backfill from
   recordings.
4. **Heatmap.** `indicators/passive_liquidity`: sampler, publisher (lane 0
   and zoom lanes; live, deep and coarse tiers), large-level tracker;
   served live on `/ws` and as history on `/heatmap/columns` and `/heatmap/walls`.
5. **Other host analytics.** `indicators/volume-profile`, `indicators/vpin`,
   `indicators/large-trade`; the analytics worker in `platform`.
6. **Storage.** `storage` (SQLite, write queue, worker thread, checkpoints,
   gap audit, archive readers) and `storage/dxfeed`.
7. **Browser data layer.** `workers/marketDataWorker.ts` owns the WebSocket
   and flow control; `hooks/useMarketData.ts` (1.7k lines) feeds the chart;
   `lib/l2`, `lib/indicators/passive-liquidity` (column history stream,
   request budget and in-flight pool, band history), `lib/archive`
   (Historical Mode).
8. **Chart and indicators.** `components/chart/ChartPanel.tsx` (3.4k lines)
   and `MainPanel.tsx` (2.1k); `lib/chart` (indicator registry and runtime,
   draw kernel); about 50 indicators under `lib/indicators`.

### Size

About 150k lines of source and 188k lines of tests. 144 mutation spec files
hold about 2,600 mutants; the ledger is about 11k lines and 14 MB.

## Baselines

Measured on `a85aa33`, 4 cores, run one at a time.

| Step | Time | Result |
|---|---|---|
| `docs:check` | 2.4 s | pass |
| root `eslint .` | 8.9 s | pass |
| web `oxlint` | 0.5 s | pass |
| web `tsc -b` | 18.9 s | pass |
| `vite build` | 1.5 s | pass; a chunk over 500 kB |
| runtime jest, whole suite | 99 s | 5,468 passed, 3 failed (F-1, F-2, F-3) |
| web vitest, whole suite | 140 s | 4,249 passed; 205 s of jsdom environment set-up summed over workers |

Mutation replay: about 7 s a mutant, one at a time, each running its test
command twice (clean, then mutated). The 721 mutants of the specs #47 touched
took about 85 minutes.

## Phase 1 results

### Mutation tool

`mutation-check` now takes several spec files and runs their mutants on a pool
of worker copies of the working tree (`--workers`, default one fewer than the
cores, at most four). The checkout is never edited, so a killed run cannot
leave a mutant behind; a mutant written in place (Python specs, or
`--in-place`) is journalled in `.mutation-inflight/` and put back by the next
run. A command's clean run is measured once per worker, not once per mutant;
`npx <bin>` runs the bin directly; a stale mutant is reported as `STALE` and
the run goes on; `--only <id,...>` and `--progress <file>` pick and resume.

| Spec files | Mutants | Before | After (3 workers) | Outcomes |
|---|---|---|---|---|
| `pr-47-review-fixes` (web) | 58 | about 394 s | 55 s | 58 killed, as before |
| `heatmap-latency-runtime`, `pr-47-lane-fold-store`, `l2-engine-p4c-audit`, `heatmap-hole-fill` (runtime and web) | 54 | about 378 s | 59 s | 53 killed, 1 survived, as before (F-6) |

### Web tests

Every web test file ran in jsdom, a simulated browser that costs set-up per
file. Vitest now defaults to Node; 60 files keep jsdom with a
`// @vitest-environment jsdom` line: the 41 that touch the DOM, and the 19 that
reach code which branches on a browser API (`requestAnimationFrame`,
`document`, `matchMedia`), so no test silently moves to the fallback branch.
The raster's random-walk property test (43 s in one file) runs as one file per
flavour, so a machine with more cores spreads it out.

| | Before | After |
|---|---|---|
| Web suite, 3 workers on 4 cores | 140 s | 75 s |
| Tests passing | 4,249 | 4,249 |
| jsdom set-up summed over workers | 205 s | 38 s |

### The gate

`npm run gate` runs every check side by side at the pinned Node, the conversion
suite included (it was in neither `npm run check` nor CI), and prints a report.
On 4 cores: about 190 s for docs, eslint, oxlint, the type check, the build,
5,497 runtime, 4,251 web and 1,117 conversion tests and the stale-mutant check,
with the three suites side by side (274 s two at a time); the same steps one
after another take about 420 s. See
[Testing and gates](../operations/10-testing-and-gates.md).

### Flaky tests

Repeated full gates, three suites at once on 4 cores, so every test ran with
the CPU starved. Two tests failed some of the time, and both were the tests'
fault, not the code's:

| Test | Failure | Cause | Fix |
|---|---|---|---|
| `ws-fanout-load` "a slow client is evicted…" | 1 run in 4: a healthy client missed trades | At 100 trades a pulse (F-3), the healthy clients' upstream queue drops its oldest events when the CPU is starved, which it is built to do | 60 trades a pulse: eviction at about 7 s, still within the 15 s budget, and no drops in 6 loaded runs |
| `marketDataWorker` "the byte cap pauses delivery…" | 21 sockets where one was expected | F-23 | Every worker copy is stopped after its test; the failure, reproduced by delaying one import by 3 s, no longer occurs |

The gate passed with both fixes in.

### Full mutation replay

Every spec on the new runner: 2,640 mutants, 2,513 killed at first. After
triage: the 13 stale and filtered-out groups retargeted, the real test gaps
closed (F-19, F-20), 5 mutants retired as equivalent or obsolete, and four
known survivors documented (F-22).

### Stale mutants

`npm run mutation:stale` lists every mutant whose find text no longer occurs
exactly once. With `--base <ref>` it fails only on what the branch did: a
mutant that matched at the base and does not now, or one the branch added or
changed that does not match. Mutants stale before the base are counted, not
blocking. Its first run found 125 stale mutants in the repository and one this
branch broke (`o0-m1.mutation-check.restore-skipped`, retargeted).

## Findings

| # | Area | Severity | Finding | Status |
|---|---|---|---|---|
| F-1 | Tooling | high | Local evidence ran on Node 22.22.2; the repository pins 24.21.0 and the launcher refuses anything else. The pin was only enforced by npm's `pretest` and `prebuild`, so `npx jest`, `npx vitest` and the mutation check ran on whatever Node was on PATH | Node 24.21.0 installed in the audit container; `mutation-check` refuses another Node and runs a spec's `node` as its own; the gate command will too |
| F-2 | Ops tests | low | The frozen-release verifier refuses to run as root by design, so its test could not pass in a root container | Fixed: as root the test checks the refusal; as a service account it runs the verification |
| F-3 | Bench tests | medium | `ws-fanout-load` "a slow client is evicted…" failed on Linux every run. A paused client's operating system buffers the stream before the server's buffer grows: a few hundred kB on Windows, up to 32 MB here, so at the test's rate the server buffer peaked at 67 kB, never reached the 150 kB threshold, and the run outlived jest's 5 s default. Not a server defect: eviction needs the OS buffers full first | Fixed: three times the rate fills them within seconds on either system (eviction at about 7 s), a 15 s budget and an explicit 30 s timeout; healthy clients still miss nothing, CPU starved or not (see Flaky tests) |
| F-4 | Mutation tool | medium | A baseline per mutant, one mutant at a time, in place; a stale mutant aborts the rest of its file; a killed process leaves the source mutated | Fixed: see Phase 1 results |
| F-5 | Mutation ledger | medium | One 14 MB append-only file conflicts on every merge | Fixed: the ledger keeps each mutant's latest run, one line per mutant sorted by id (18.5 MB and 13,934 lines down to 3.7 MB and 2,785); a run appends under a lock file, then folds its lines in. Two branches now touch the same line only when both ran the same mutant, and `merge=union` keeps both sides for the next run to fold. Earlier runs stay in git's history. Tests and 6 mutants |
| F-6 | Mutation specs | medium | 125 of about 2,600 mutants are stale (their find text no longer matches once), so they test nothing; `ge-11` survives (book map float residue); `p4c-audit.publisher-keeps-the-store-open` can only be killed on Windows | `npm run mutation:stale -- --base <ref>` now blocks new ones. All 125 retargeted or retired over Phases 2 and 3 (F-12, F-14, F-16, F-26, F-29, F-44): 0 stale |
| F-7 | Web build | low | A bundle chunk over 500 kB after minification: `indicators`, 592 kB (171 kB gzipped), next to `index` 262 kB, `react` 190 kB and `charts` 176 kB | Accepted, unchanged. Every indicator is registered when the page starts and the page is served from 127.0.0.1, so splitting the chunk further would move bytes without loading fewer; loading fewer means loading indicators on first use, which changes what a trader waits for when adding one and is a product decision. The warning stays on so growth past it is seen |
| F-8 | Server | none | `/ws` admits a connection with no `Origin` header; the allow-list only binds browsers | By design and documented (`P3.00-market-data-server-evidence.md`): the relay binds loopback only and serves local non-browser clients too; a browser always sends `Origin` on a WebSocket handshake, and a non-browser client can forge any, so the allow-list is the right guard against cross-site pages and the only one an `Origin` check can give. The Linux host keeps its services on loopback behind an authenticating gateway on WireGuard |
| F-10 | Heatmap lanes (`lane-rebuild.js`) | high | `startDeepBackfill` chained the deep tier, coarse backfill, host histories and the local fill without a final catch, and nested chains were not returned. The runtime treats an unhandled rejection as fatal (`run-ws-server.js` shuts down and exits 1), so one throw there, such as a host event window with a fractional timestamp reaching `eventHistory.merge`, would stop the whole server over one pair's background fill | Fixed: one returned chain with one catch; the failing stage is marked DEGRADED with the reason and logged. Test and 2 mutants |
| F-11 | Heatmap lanes (`lane-rebuild.js`) | low | The recording fill widened the event history's one fill range over a window whose events the history refused, and `uncovered()` counts that range as held: a hole that was never asked again, kept across restarts. The deep pass and the host fill already counted only what merged. Latent: the fill's own passes do not produce a batch the history refuses | Fixed: the fill stops at a refused window, as it does at a failed pass. Test and mutant |
| F-12 | Mutation specs | medium | 13 mutants on `lane-rebuild.js` were stale (11 from refactors, 2 from F-10's fix), so the history fill had no mutation coverage | Retargeted to the current code: 13 of 13 killed |
| F-13 | Mutation specs | medium | 12 mutants on the heatmap store, shelf and admission still named `liquidity-publisher.js` after the publisher was split into `compact/lane*.js`: the code moved, the mutants did not | Retargeted: 11 of 11 killed. `ge-13.prune-walks-a-shelf-with-nothing-to-drop` retired as equivalent: `dropShelfFront` now returns on its own when nothing aged out, so dropping the early return changes neither result nor cost |
| F-14 | Mutation specs | medium | 20 more stale mutants in `l2-memory` (store, replay source, memory engine, lane frames, L2 snapshots, wall service, event history, pyramid builder, service, store, reader and warm-up). The host-paging guards they protect (rows, wall cursor, event cursor) all still exist, restructured | 19 retargeted, 19 of 19 killed; `p4e3.service.tracker-on-a-store-that-cannot-keep-it` retired: every store keeps histories since `3226d52`, and the builder still refuses one that does not |
| F-15 | Mutation tool | medium | Found by this audit's own runs: a spec on a deleted file aborted the whole run and removed worker copies under the other lanes; and a second run's crash recovery restored a file a live run had mutated in place | Fixed: a missing file is STALE, any other failure is ERROR, the run goes on; journal entries carry their process and recovery waits for it to be gone |
| F-16 | Mutation specs | medium | 13 stale mutants in the chart integration (`indicatorRuntime.ts`, `ChartPanel.tsx`, `tooltipPriority.ts`, `l2BookMapPrimitive.ts`): code renamed, reindented, moved into helpers, or saved with LF where the spec had CRLF | 12 retargeted and killed (one names the test that guards its line: the book map's visible-time slice is what keeps a repaint from scanning all history); `steady.fill-points-handed-over-for-indicators-that-never-fill` retired as equivalent, since an indicator that never fills has no fill points to hand over |
| F-17 | Chart integration | low | `indicatorRuntime.ts` holds two copy-pasted pairs, `setL2` / `setLiquidity` and `onL2Advanced` / `onLiquidityAdvanced`: a fix to one copy can miss the other | Fixed: one `replayL2Indicators` behind both setters and one `refreshL2Tail` behind both advance hooks; the four mutants on the old copies retargeted to the shared code, and four more check that each entry point still reaches it (8 of 8 killed) |
| F-18 | Mutation specs | medium | A spec whose `-t` filter no longer matches the test it names runs nothing and reports SURVIVED: the five `pr39.held.*` mutants filtered on "PR #39 review" after their tests were renamed | Filters fixed (5 of 5 killed). The tool should catch this itself (next) |
| F-19 | Tests | medium | Survivors that were real test gaps, each closed with the case the test lacked: the age window's loss mark after a late cover (`event-history`), a range whose book starts late but runs on unbroken (`rangeStats`), a volume-profile read landing after stop (readiness compared, guard kept as defence in depth: its only effect is an unread readiness entry), and the closed equity session in both dxFeed servers (O-10: the lazy server's test named the closed case but asserted only the open one, its comment called a 10:00 ET clock 03:00 ET, and the eager server had no test) | Fixed: the gaps the mutants show are closed (o-6 aside); `pr27-tick-poc-taken-after-smoothing` retired: the POC is deliberately read off the smoothed bars now and the test it named is gone |
| F-20 | Tests | medium | More survivors that were test gaps: a page whose cursor did not move must wait before it is asked again (the column stream); the host's windows must count in the fill range reported when the local fill stops at once; a delta refused part-way must keep the columns it decoded first (the grid); the whale stream's twelve-hour chunks were tested on a timestamp where twelve-hour and six-hour chunks start together | Fixed with the missing case each; 4 of 4 killed. `l2-book-map.drop-recomputes-key-from-current-geometry` retired: every geometry or settings change clears the buckets, so a stored key always equals a recomputed one |
| F-21 | Tests | medium | 28 conversion tests read the host's real free disk: the backfill demands 50 GB, so below that 27 failed with INSUFFICIENT_FREE_DISK whatever the code does, and one passed only because the host had less than its 8 TiB reserve. The conversion suite is in neither `npm run check` nor the CI the team runs, so nobody saw it (3 tardis mutants could never run here) | Fixed: a conftest fixture gives every test an ample, fixed reading; tests about the refusal set their own, and the reserve test now sets its 4 TiB explicitly. 1,117 passed; the 3 tardis mutants killed |
| F-22 | Mutation specs | low | Known survivors, kept with their reason: `o-6` (the guard only spares an unread readiness entry after stop), `ge-11` (the bucket removal is structural now; the old residue needs the window's partial re-adds to reproduce), and two that only Windows can kill: `p4c-audit.publisher-keeps-the-store-open` (Linux deletes an open file) and `fa-5.refusal-closes-with-the-body-unread` (Linux keeps received data readable after a reset) | Documented |
| F-23 | Tests | medium | The worker's tests import a fresh copy of the worker for each test and most never stop it. A copy whose socket failed keeps reconnecting on real timers; when a later test's import is slow, that loop fires inside the later test, under its fake timers and with its fake socket class, and opens sockets there | Fixed: every copy a test loads is stopped after the test |
| F-24 | Chart integration | low | Reviewed `ChartPanel.tsx` and `MainPanel.tsx`: neither holds async code (every request leaves through a store or the worker), every listener, observer, timer and primitive the chart effect attaches is released in its cleanup, and the theme rebuild never runs in practice (each panel's theme is fixed for its life). The web lint did not check hook dependencies, so a stale closure in either panel's 63 effects would have gone unseen | The check run once over the web source: no findings. `react/exhaustive-deps` is now an error in `.oxlintrc.json`, so it stays that way |
| F-25 | Browser data layer (`useMarketData.ts`) | low | An L2 history request (wall or event pages for the L2 indicators) still out when the hook unmounts was never answered, and one made after it was queued on a worker already stopped: whoever awaited it hung, holding its closure. A pair switch and a dropped socket already answered null. The request routing had no test in the hook's suite | Fixed: unmount answers every pending request with null, and a request after it gets null at once. Tests for the routing by id, another pair's answer, and unmount; 4 mutants, all killed |
| F-27 | Browser data layer (`useMarketData.ts`, `marketDataWorker.ts`) | medium | The worker sends an L2 history request on only over an open socket and drops it otherwise, with no answer, while the hook kept the request's promise until the next socket close or pair switch. Order Flow Gaps marks its history backfill running until that promise settles: when the socket drops, its request is answered null and it retries 1.5 s later; if the reconnect has not finished by then, the retry is dropped and the backfill stays "running", so the indicator never fills its history again until the next drop or pair switch. The other requests (aggressive history, band history, delta profiles) are only made while the status is open and retry on their own timers | Fixed: the hook answers null at once while the socket is not open, so the backfill's retry pacing carries on. Test (no request sent, a request out when the socket closes, a retry while reconnecting); 2 mutants, killed |
| F-26 | Mutation specs | medium | 14 stale mutants on the data layer (`useMarketData.ts`, `marketDataWorker.ts`, `frames.ts`): code reformatted to one field per line, saved with LF where the spec had CRLF, routing folded into one `target` per reply kind, the capability list grown by `l2_walls_lanes` and sent from the list rather than spelled out; one named a test since renamed | Retargeted to the current code: 14 of 14 killed. Stale mutants in the repository: 55 (from 69) |
| F-28 | Historical Mode studies (`archiveStudyPlan.ts`, `archive-study.js`) | medium | On 1W and 1M the buy/sell flow study never reaches a candle. The client asks for flow in buckets of the timeframe's `intervalMs` (7 days, 30 days) and the server floors each minute to `floor(t / bucketMs) * bucketMs`, which puts a week on Thursdays (1970-01-01 was a Thursday) and a "month" on 30-day steps from the epoch, while the chart's weekly candles open on Mondays and its monthly candles on the 1st. The chart matches flow by exact open time, so nothing matches: the flow is read and sent, then dropped. Untested (the plan's test stops at 4h) | Fixed, as the user chose: above 1D the flow is asked for by day (the archive's daily buckets and the chart's both open at UTC midnight), over a span widened to whole weeks or months, and added up in the browser into the chart's own Monday weeks and calendar months. A week or month is shown only once every day of it the archive holds has loaded, so no candle shows part of its flow. Unit tests for the bucket, the span, the roll-up and the archive's edges; hook tests at 1W, including a week that starts in an earlier request chunk; 7 mutants, all killed |
| F-29 | Mutation specs | medium | 19 stale mutants on the Historical Mode studies (`archive-study.js`, `archive-study-route.js`, `useArchiveStudies.ts`, `archiveStudyClient.ts`): the four files were reformatted to one clause per line, and the study's fetcher now picks its client before building it. One (`web.late-study-from-old-viewport-applied`) targeted a second "still wanted?" check that ran right after the first with nothing between them | 18 retargeted and killed. The dead second check removed; the retired mutant's remaining target, the first check, only backs up the abort `setDesired` already sends a job the moment it stops being wanted, so it is equivalent and retired. A test now pins that a late refusal for a viewport no longer on screen is not reported |
| F-30 | Order Flow Gaps / Flowprint Blocks (`liquidity-voids`) | none | Reviewed against its README: the push model (window sample, hole reset, half-open push span, carried prints past ten minutes, mitigation only by a bar that holds none of the push), the Fixed and Learned thresholds, the per-instrument history slot. 244 mutants over its 1,367 lines, every one killed at its latest run. The one defect found on its path was in the data layer (F-27: its history backfill could stall after a reconnect) | No change |
| F-31 | Bench tests | low | `ws-fanout-load` "leaves no temp directory behind" counted every `ws-fanout-*` entry in the shared temp folder, so any run beside it (a mutation worker, a second suite) failed it: it broke the baseline of 10 of 11 mutants run in parallel | Fixed: the test records the directory its run makes and checks that one is gone; a mutant that skips the cleanup is killed |
| F-32 | Binance server (`market-data-server.js`) | medium | 3,668 lines with 20 mutants. Eleven new ones on slow-client eviction (grace window, hard ceiling, what each frame kind may send while over budget, the over-budget clock's reset, release after eviction or a failed send), message validation and the selection rate limiter: ten killed, one survived. A bulk history reply to a client over budget inside its grace window was never tested: dropping the branch that skips it would close a client that is still catching up. The test named for that case sent no bulk frame | Test added (a bulk reply inside the grace window is skipped without eviction and answered once the client drains); 11 of 11 killed |
| F-33 | Archive route and auth (`archive-route.js`, `archive-auth.js`) | medium | The authenticated proxy in front of the archive had one mutant over 692 lines. Eighteen new ones on the bearer check, token rules, the per-client rate budget and queue, and the reply contract: twelve killed, six survived. Each was a correct behaviour no test pinned: that the upstream always hears the authenticated client id even when the request carries its own `x-archive-client` header (a regression there would let a viewer read under another's identity and budget); that a reply of another family, with more rows than asked, or with a refusal code under the wrong status is refused; the shared queue's cap; the 4 KiB cap on `Authorization` | Six tests added; 18 of 18 killed. The code needed no change |
| F-34 | dxFeed servers (`dxfeed-market-data-server.js`, `dxfeed-eager-market-data-server.js`) | medium | Each of the three market data servers carried its own copy of the slow-client policy (send, grace window, hard ceiling, eviction), identical in logic. The Binance copy's tests kill every eviction mutant; in both dxFeed copies three survived: a bulk frame inside the grace window evicting the client, the grace clock never resetting after the client drains, and an evicted client never released (its timers, rate budget and history jobs kept) | Fixed by removing the copies: one `createClientSender` in `market-data-server-shared.js`, used by all three with each server's own release and close, tested through the Binance suite. A mutant per server checks it wires its own grace setting. 14 of 14 killed; the six server suites (546 tests) pass |
| F-35 | Storage (`storage-lock.js`) | low | The single-writer lock on the capture database is taken by creating the lock file, then writing the owner into it. A second collector starting in that instant read the still-empty file as a stale lock with no owner, took it, and both would write: two collectors on one database. The window is microseconds and needs two starts at once | Fixed: an empty lock file younger than one second is being written, so acquire waits for it (polling every 25 ms) instead of taking it; an older empty file is still reclaimed. Tested with a child process that holds the empty file, then names itself |
| F-36 | Storage (the capture path) | medium | About 5,000 lines of storage (service, database, reader, write queue, lock, checkpoint, workers) had no mutants. Sixteen on the lock, the write queue and the checkpoint: twelve killed, four survived, all in the write queue: `stop()` writing every batch rather than only the first (one batch lost to a shutdown would be up to 1,000 recorded rows), refusing a write after a fatal failure, the retry cap on a database that stays locked, and that cap resetting once a write lands. The code was right; nothing held it | Four tests added; 16 of 16 killed. Then 12 on the storage service's record paths: 7 killed, 5 survived. Four were validation no test exercised (a candle that is not one minute, a depth event whose last update id precedes its first, a spot depth event naming a previous update id, and a late older trade id moving the continuity mark back, which would report a false gap at the next trade); one is equivalent (a high below the low is already refused by high ≥ open ≥ low) and was dropped. Five tests added; 11 of 11 killed. Then 9 on the reader's windows, limits and daily rollup: 6 killed; the price range read's end bound was untested (a trade at the end of a range belongs to the next one; the volume profile's price span reads it) and so was the guard that drops a rollup total the schema's CHECK lets through (infinity); the candle window's end bound is checked twice, in SQL and again in the loop, so its mutant is equivalent and dropped. Two tests added; 8 of 8 killed |
| F-37 | dxFeed token lifecycle (`dxfeed-token-lifecycle.js`, `token-broker-client.js`) | low | The short-lived dxFeed token: fetched from the broker over HTTPS on a Tailscale host only, refused if expired, over 35 minutes long, malformed or oversized, and the collector stops five minutes before it lapses. Thirteen mutants: eleven killed; two survived, both untested hardening: the token request refusing to follow a redirect (so it cannot be bounced to another host), and a transport abort counting as a retryable timeout | Two tests added; 13 of 13 killed. No code change |
| F-38 | Event normalizers (`binance-event-normalizer.js`, `dxfeed-event-normalizer.js`) | none | The step that turns raw Binance messages into trades, candles, book tickers and depth had no mutants. Sixteen on its field mappings (open/close, high/low, bid/ask, first/last update id, taker against total volume), its candle time, grid and OHLC checks, the trade's own timestamp, and the hand-written decimal comparison: fifteen killed; the sixteenth is equivalent (a candle of another interval is refused earlier, in `buildEnvelope`). Thoroughly tested | A test pins the other-interval refusal; 15 of 15 killed. The dxFeed normalizer the same way: 13 mutants on quote sides and event time, trade size, aggressor side and sale type, order V2 prices, NaN sizes, the remove flag and its reduced fields, the index bounds: 13 of 13 killed by its existing tests |
| F-39 | Aggressive Orders tape (`aggressiveTape.ts`) | none | The store behind the bubbles and every print-priced indicator had no mutants. Seventeen on late-print ordering, duplicate ids, live stretches across a reconnect, prints the size cap drops, history coverage per floor, trimming and thinning, the automatic floor, clustering (sides, VWAP, gap, candle bucket) and the history asks: all seventeen killed by the existing tests | No change |
| F-40 | Session VWAP and VWAP Bands (`sessionVwap.ts`, `vwapBands.ts`) | medium | 950 lines with no mutants, and the numbers sit on the chart. Fourteen mutants: eight killed, two equivalent (a zero-volume bar adds zeros either way; the lookback sums are already reset when the pair changes). The other four were untested, and two tests were not testing what they said: "a four-hour bar" was a one-minute bar, so the rule that a bar longer than the session never hides the line was never exercised; and the typical-price test used a candle whose close is the middle of its range, so weighting at the close passed it. Also untested: band widths clamped to 0.5 to 4 sigma, and a bar that opened with no volume and then traded must not take the bar before it back out of the average | The two tests fixed and two added; 12 of 12 killed. The code was right. VWAP Bands, which prices each bar from its prints: 10 mutants, 8 killed; the same two behaviours were untested there (a bar longer than the session, a bar that opened with no prints); two tests added, 10 of 10 killed |
| F-41 | Market Structure (`marketStructure.ts`) | low | BOS and CHoCH breaks of swing highs and lows, graded by the delta traded across the move. Twelve mutants: eight killed. Untested: a close exactly at the swing is not a break; the bearish side refusing a wick below the swing low (only the bullish wick was tested); the bearish label sitting below the line; and a candle re-delivered while it forms counted once in the delta behind the grade (counted as a new bar each time, the grade would be skewed) | Three tests added; 12 of 12 killed. The code was right |
| F-42 | FVG Boxes (`fvgBoxes.ts`) | medium | The least-tested indicator so far: fourteen mutants, six killed, one equivalent (the buy share's clamp; volumes are never negative). Untested were: an open candle making or mitigating a zone; a gap of no size; the bearish zone's edges; a candle re-delivered while it forms (stored again, the next gap would be measured against the wrong candles); the same gap detected twice; a mitigated zone hiding a new overlapping one; and which zone a full store drops first | Five tests added; 13 of 13 killed. The code was right |
| F-43 | Conversion (`candle_rollup.py`, `roll_table.py`, `csv_decode.py`, `continuity.py`) | low | Most of the Python conversion that builds the archive had no mutants. The hourly and daily roll-ups (equity hours anchored at 09:30 New York, early closes, holidays) and the futures roll table behind the continuous contracts: 28 mutants, 24 killed. Untested were: the week between March's first and second Sunday, when the clocks have not yet changed (a wrong rule would move the equity open an hour for that week each year); minutes arriving out of order still giving the hour its first open and last close; a negative tick size or multiplier keeping its sign through the fixed-point conversion, so validation refuses it rather than seeing a positive number; and the roll table's version not depending on the order of its sources | Four tests added; 28 of 28 killed. Then the CSV decoders (Databento OHLCV, Binance monthly klines) and the depth continuity tracker: 15 mutants, 12 killed; untested were a kline file mixing microsecond and millisecond rows (part of a month would land a thousand times off), an OHLCV row with an empty field, and an epoch's span when its rows arrive out of order. Three tests added; 15 of 15 killed |
| F-44 | Mutation specs | medium | The last 30 stale mutants. Most guarded code since reformatted or grown: schema properties now one per line, route lists with more routes, the VPIN calibration moved into `vpin-compute.js`, the wall stream's chunk size and id base now per instance, the crypto tick sizes moved from Python into `config/archive-crypto-ticks.json`. Four pointed at the Delta, Volume and Net Delta Profile files merged into Session Profile. Three named tests that no longer select anything: two through a `-t` filter that is a regular expression, where `(Ticks)` does not match the literal parentheses in the test's name, so the mutant reported SURVIVED with no test run; one (argument quoting) only reaches its line on Windows | 28 retargeted, 28 of 28 killed; the quoting mutant now mutates `quoteArgument` itself, which its own test pins. Two retired: the Delta Profile's "Delta POC line" label went with the merge, and `pr27-tick-value-area-taken-after-smoothing` guarded the reverse of today's rule (the value area is now read off the smoothed bars on purpose, so it brackets the POC it names, and the test was renamed to say so). `mutation:stale` reports 0 stale mutants, down from 125 |
| F-9 | Structure | to review | Three market-data servers, 8.3k lines together; `ChartPanel.tsx` 3.4k and `MainPanel.tsx` 2.1k lines | The slow-client policy is now shared (F-34). The rest of the servers' overlap and the panels' size are left as they are: their hooks and listeners check out (F-24), and splitting them is a refactor with no defect behind it |

## Phase 2 order by risk

Read in full where the risk is, rather than every line at the same depth:
the feeds were audited hard before (the Binance assembler's sync rules and its
shadow refresh check out against Binance's published procedure). The ranking
weighs recent churn (commits in the last 300 touching the file), mutants gone
stale on the file (code that changed while its test stopped checking it), size
and coverage.

| Rank | Area | Signals |
|---|---|---|
| 1 | Heatmap lanes in the runtime: `lane-rebuild.js`, `lane.js`, `lane-store.js`, `liquidity-publisher.js` | 11, 4 and 8 stale mutants; 12 to 21 commits each |
| 2 | Chart integration: `MainPanel.tsx`, `ChartPanel.tsx`, `indicatorRuntime.ts` | the two most changed files (51 and 50 commits), 3.4k and 2.1k lines, 8 stale |
| 3 | Browser data layer: `useMarketData.ts`, `marketDataWorker.ts`, `frames.ts` | 7, 3 and 4 stale; 18 and 12 commits |
| 4 | Historical Mode studies: `archive-study.js`, `archive-study-route.js`, `useArchiveStudies.ts`, `archiveStudyClient.ts` | 19 stale across the four |
| 5 | Order Flow Gaps / Flowprint: `liquidity-voids` | 23 commits on the indicator |
| 6 | Binance server: `market-data-server.js` | 6 stale, 3.7k lines |
| 7 | dxFeed servers and token lifecycle, storage and its worker, live-storage route, archive routes and auth | size and exposure |
| 8 | The remaining indicators, ops, conversion Python | lowest churn |

## Phase 3 results

- **Stale mutants.** All 125 found in Phase 1 are retargeted or retired
  (F-6, F-12, F-14, F-16, F-26, F-29, F-44); `npm run mutation:stale` reports 0.
  The audit added 263 new mutants (`benchmarks/mutations/audit-*.json`), all killed.
- **Docs against the code.** `validate-docs.cjs` checks links, npm scripts, host
  units, environment variables and the configuration table, but not file names in
  backticks. Checked by hand: of 32 file names the docs give that no longer exist,
  29 are run-time outputs (`checkpoint.json`, `apps/web/dist`, data directories)
  or historical evidence that describes the code as it was. One live reference was
  wrong (the wire contract cited `dxfeed-config.js`, now
  `dxfeed-instrument-catalog.js`), and one statement was outdated by F-28: the
  archive-study contract said calendar timeframes have no per-candle studies,
  where bar flow on 1W and 1M is now drawn from daily bars added up in the browser.
  Both corrected.
- **Read in Phase 2.** Every area in the risk table, plus the dxFeed servers and
  token lifecycle, storage and its lock, the live storage and archive routes and
  their auth, the event normalizers, the Aggressive Orders tape, Session VWAP,
  VWAP Bands, Market Structure, FVG Boxes and the conversion roll-ups, roll table
  and CSV decoders. Not read line by line: the remaining indicators outside these
  (their mutants were already in place and killed), and `ops/linux-host`, whose
  units and scripts the docs check validates.
