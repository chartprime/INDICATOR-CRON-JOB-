# Historical L2 August release

## Scope

August 2026, ESU6/NQU6/AAPL/TSLA. This release derives level events,
one-second states and coverage from retained Databento sources. It does not
enable Historical Mode or exact Replay. The output contract is
[historical core](historical-core-contract.md).

## Source inventory

`plan_historical_core_month.py` reads an immutable, SHA-256-pinned catalog.
It accounts for every calendar date for all four instruments. Each required
family has exactly one authority; duplicate versions are refused. Futures
require depth/trade; equities additionally require independent quote anchors.
The planner never marks data available.

The verified host catalog on 2026-10-06 has 124 instrument-days:

| Disposition | Days | Action |
|---|---:|---|
| Awaiting full-day qualification | 92 | Independently qualify each session |
| Single snapshot with trades | 2 | Repair with evidence or keep unavailable |
| Required source absent | 30 | Keep unavailable; no claim of exchange closure |

The two sparse sources are ES/NQ on August 2. Catalog presence is not proof
of upstream completeness. The source snapshot is pinned at
`b89800519f0ff067f7d410f3f5947079e1d97d520d287b9b0b6c5b2660fafb38`.
Its August 5 depth manifests match the four accepted local pilots. The
inventory plan ID is
`b6b8f78f9e7637ecd931ccbd3f35d8042fa3d5b72b8b9e250f03211687476d56`.

## Isolated host rehearsal

Use a frozen candidate checkout under a new
`/srv/terminal-data/qualification/` directory. Do not select it as the
production release or restart live services. The script's ignored
`apps/runtime/data/historical-l2-pilot/` directory is confined to that run.
Use the converter identity and existing service environment without copying
credentials into the checkout or printing them.

`rehearse_historical_core_day.py` accepts one admitted August session. It:

1. Reconciles catalog authorities and authenticates every source manifest/part.
2. Fetches one bounded native file and verifies its canonical lineage hash.
3. Runs the independent L1-flow check and, for equities, native ordering proof.
4. Generates complete-day families with the existing bounded producer.
5. Checks the full source and every stored state independently.
6. Prepares the local descriptor and measures strict reads.

Source transfers require a 40 GiB free-disk reserve, exact size and SHA-256.
Failures leave no admitted partial source. A durable status file records the
active stage, completed receipt hashes and elapsed times. Existing rehearsal
identities are refused; inspect a failed attempt before creating another
isolated run. There is no automatic retry, upload or publication.

Canonical `source_rank` is assigned by the conversion job's sorted source
keys; it is not a fixed market or schema identifier. CME verification requires
one nonnegative rank per native authority, complete unique lineage positions
and exact trade correspondence. It preserves the stored rank and never
renumbers canonical data to make a pilot assumption pass. Flow samples remain
monotone across quiet periods and segment boundaries.

The candidate helper exposes `describe()` for read-only revalidation of an
existing descriptor's source/state receipt chain and authenticated families.
`prepare()` uses the same validation and retains exclusive descriptor creation.
Resumption/publication must compare the recomputed descriptor with the pinned
existing descriptor; an existing completion file alone is insufficient.

NQ and TSLA August 5 run under separate transient converter units, bounded
to four CPU cores each with idle I/O priority. TSLA has a 3 GiB memory
threshold and 4 GiB hard cap. NQ's initial 3/4 GiB limits caused frequent
reclaim; at 22:00:18 UTC on 2026-10-06 they were raised to 6/8 GiB without
restarting it. No OOM kills occurred before that change. NQ's Node process
reported 279 MiB peak RSS while the unit was reclaiming near 3 GiB; cgroup
memory includes other children and file cache and is not interchangeable
with Node RSS. The collector remained healthy, with zero write lag after
the adjustment; its existing source-quality status was `DEGRADED`.

The code and source catalog remain frozen. Record unit resource peaks,
collector health and stage timings. TSLA started after NQ's flow check;
the runs overlap during encoding. The mixed limits and staggered start make
this a capacity rehearsal, not a controlled parallel speedup measurement.

## Monthly release gates

- Freeze the source plan, code/runtime versions and an isolated output root.
- Measure host throughput and disk growth before selecting monthly concurrency.
- Preserve per-day receipt chains; refuse changed sources/code on resumption.
- Every admitted day needs full-source and every-state qualification. Failed
  days receive explicit unavailable dispositions, never empty success markers.
- Upload only qualified immutable objects/descriptors into `curated/l2-core/`.
- Verify remote hashes, reconcile complete-month dispositions, publish the
  catalog last with a conditional parent check and retain rollback.
- Keep candles/L1 catalogs and serving unchanged.

## Monthly execution and resumption

`run_historical_core_month.py` executes the frozen August plan on the Linux
converter host, with one or two workers. Run it under an isolated systemd
unit with `KillMode=control-group`, CPU/memory limits and the converter's
existing environment. Source code and the source catalog remain read-only;
only the isolated data directory is writable. It does not publish anything.

The runner pins all conversion/input code and Python/Node versions. Each day
has a process-lifetime lock, an isolated attempt name and a six-hour work
budget. Stop signals cancel active worker process groups and prevent further
launches. Failed/interrupted attempts remain as diagnostics; `--retry-failed`
starts new attempts without overwriting them. Other admitted days can finish.

On resumption, `validate_historical_core_day.py` verifies the full receipt
chain, checker versions, source authorities, sealed files, descriptor and
strict reads before reusing a completed day. A worker that completed before
the monthly journal recorded success can be recovered this way. A changed
source plan, code/runtime or completed output is refused. Existing accepted
rehearsals can be admitted with repeated `--adopt-day` arguments.

Adoption accepts both original rehearsal names and sealed numbered attempts.
When verification code changes, use a new frozen checkout and isolated data
directory; do not bypass the old journal's code pin. Revalidate imported sealed
days and cached sources, preserve the previous run and failed evidence, and
keep monthly concurrency at the admitted limit during handoff.

```bash
PYTHONPATH=apps/runtime/conversion python apps/runtime/scripts/verify/databento/run_historical_core_month.py \
  --catalog SOURCE.sqlite --catalog-sha256 SOURCE_SHA256 \
  --node NODE_24_21_0 --workers 2 \
  --adopt-day stage3-nqu6-2026-08-05 --adopt-day stage3-tsla-2026-08-05
```

The durable journal is `month-2026-08-PLAN_ID_PREFIX/run.json` under the
isolated pilot data directory. `LOCAL_VERIFIED` requires every planned day
to be either independently accepted or explicitly unavailable from the source
inventory. A processing failure leaves the month incomplete, not published
as an empty successful day. Read per-attempt status/progress/log files for
in-flight work; the monthly journal records durable scheduling outcomes.

## Separate L2 publication

`publish_historical_core_month.py` uses `curated/l2-core/` only. It revalidates
each available day, verifies the exact descriptor/object graph and uploads
immutable files with remote SHA-256 verification. Bounded upload batches have
at most eight objects in flight. The cumulative JSON release catalog includes
every planned date and explicit unavailable reasons. It leaves candles and
L1 catalogs unchanged.

The L2 pointer is `_catalog/CURRENT.json` in that namespace. Catalog snapshots
are content-addressed under `_catalog/releases/`; their names, hashes and
byte lengths are pinned by `historical-l2-pointer/1`. The expected parent is
provided explicitly. A conditional update prevents stale publishers from
advancing the pointer; previously qualified days cannot disappear or be
silently replaced. Prior immutable snapshots remain available for rollback.

```bash
PYTHONPATH=apps/runtime/conversion python apps/runtime/scripts/verify/databento/publish_historical_core_month.py \
  --data-root PILOT_DATA --journal FROZEN_RUN_JOURNAL.json --node NODE_24_21_0 \
  --bucket HISTORICAL_BUCKET --expected-parent PRIOR_L2_POINTER.json
```

Omit `--expected-parent` only for first publication. Use a stable copy of the
journal when monthly work is active; preparation refuses a changing journal.
`--partial` permits the first qualified chart dates to be released while other
days remain explicitly unavailable. Without it, unfinished/failed days refuse
publication. The uploaded candidate retains its local qualification status;
visibility is established by the separately verified release catalog/pointer.

Historical chart integration can proceed on accepted fixtures while monthly
generation runs. Crypto qualification is a separate parallel track; it does
not block the futures/equities chart release. Exact Replay remains a later
shared acceptance gate. No month-wide ETA or availability claim follows from
local pilot timings alone.
