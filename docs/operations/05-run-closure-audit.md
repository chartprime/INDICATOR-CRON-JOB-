# Run closure audit — long unattended conversion runs

An L1 phase converts 48 symbol-months and ~110 GB of compressed raw over
roughly eight days. A run that long cannot be judged by watching it. This
defines what must be true before it starts, what is watched while it runs, and
what must be evidenced before it is called done. It applies to any phase
(`ohlcv`, `l1`, `l2`) driven by `terminal-backfill@<phase>.service`.

Three rules hold throughout. Evidence beats inference: every gate below names
something to execute or read, never something to assume. Absence of a failure
is not proof — a check that never ran against real data has not passed. And a
gate that cannot fail is not a gate; each one must have been observed failing
at least once, in a test or a deliberate injection.

## 1. Pre-flight gate

All must pass immediately before the start. Fresh each time — an hour-old
result is not a pre-flight.

| # | Gate | Evidence |
|---|---|---|
| 1 | Deployed release is the reviewed commit | `readlink -f /opt/terminal-l1-l2/current` ends in the reviewed short SHA; `ops` likewise |
| 2 | Installed unit is the reviewed unit | `systemctl show terminal-backfill@<phase> -p Restart -p RestartPreventExitStatus -p Type -p StartLimitBurst` matches the repository file |
| 3 | Target namespace is empty | zero S3 keys under the phase's `dataset_version`; a namespace already holding output turns any later semantic correction into a new version, not an overwrite |
| 4 | Frozen raw identities match | every object's live `HeadObject` key, size and ETag equal the frozen inventory |
| 5 | Every source action is accepted | a census of action codes over the archive is a subset of the contract's allowlist |
| 6 | Roll tables build and validate | for each futures symbol-month, `roll_table.build()` then `validate()` from the real definition reference — no `DEFINITION_GAP`, no `NON_CONTIGUOUS_ROLL_TABLE` |
| 7 | A real roll day converts | one isolated conversion of a known roll date from a **fresh** checkpoint in a throwaway namespace, asserting no `UNPLANNED_OUTPUT_RECORD` — roll tables are embedded in checkpoints, so a reused checkpoint proves nothing |
| 8 | Capacity | free space on the data volume exceeds the reserve plus the largest single month's expansion (~19× compressed) |
| 9 | Collector unaffected | `terminal-collector.service` active, and its health file fresh |
| 10 | Service stopped and clean | target unit inactive, no stale `.guard` holder, previous failure reset |

Gate 7 is the one most often skipped and the one that has actually caught a
production failure. Mapping and coverage passing in isolation does not
exercise writer, finalize, publication or catalog intent.

## 2. In-flight watch

Cheap, periodic, read-only. Nothing here changes state.

- **Cadence** — `day_complete` events arriving within the expected band for
  the symbol. A sustained slowdown usually means disk pressure or collector
  contention, not conversion work.
- **Quarantine** — count of `day_quarantined` events, and the
  `_sequence/<version>-partial.json` receipts. One is data; a cluster on the
  same date across symbols is a contract gap and should stop the run.
- **Capacity** — free space trend on the data volume. It should fall during a
  month and recover at each `month_complete`. A monotonic fall across months
  means partial months are accumulating.
- **Restarts** — `NRestarts`. Any non-zero value deserves the journal around
  it; the run is designed not to restart on a permanent error.
- **Collector** — still active, ack latency unchanged.

## 3. Post-run closure

The run is not done when the unit exits. It is done when all of these hold.

1. **Exit status is explained.** `0` fully published; `3` partial, with a
   receipt for every partial month; `1`/`2` are failures and the phase is not
   closed.
2. **Every symbol-month is accounted for.** Each has a
   `_sequence/<version>-complete.json` or `_sequence/<version>-partial.json`.
   A complete receipt takes precedence when it includes a
   `resolved_partial_receipt` whose SHA-256 matches the retained partial
   receipt; that pair documents a reviewed recovery rather than an open gap.
   A month with neither was never attempted — find out why.
3. **The catalog chain verifies.** `_catalog/CURRENT.json` resolves, each
   published month's receipt matches its intent, and the parent SHA-256 chain
   walks back without a break. The local `_catalog/*.sqlite` files are part of
   this chain and must not be deleted.
4. **Coverage has no unexplained gaps.** Run
   `coverage_report_cli.py --catalog-root … --reference-root … --staging-root …
   --verify-manifests --bucket … --curated-prefix …` and require zero `MISSING`,
   zero `FAILED`, zero `CORRUPT` and zero `UNKNOWN`.
   Every date resolves to exactly one of the eight states `PUBLISHED`, `QUIET`,
   `MARKET_CLOSED`, `QUARANTINED`, `MISSING`, `FAILED`, `CORRUPT` or
   `UNKNOWN`; a closure is corroborated against the staged `status` reference
   per venue rather than assumed to be a holiday, and `UNKNOWN` means no status
   object covers that month — never that the market was shut. Two cautions the
   report already encodes, both found against production data: venues do not
   share a calendar (CME trades Sunday evenings, Nasdaq does not), and a
   futures contract is only expected inside the span it was front month.

   `--verify-manifests` is what makes `CORRUPT` reachable at all: without it
   every entry reads `NOT_REQUESTED` and requiring zero `CORRUPT` proves
   nothing. Measured at 157.8 s for a full 1,144-partition sweep. `--verify-limit N`
   is acceptable for an interim check only — it strides across the whole sorted
   population so every instrument is reached, reports `mode: SAMPLE`, and marks
   the partitions it skipped `NOT_SAMPLED`. A closure audit uses the full sweep.
   `FAILED` needs `--staging-root`, which is where the authority plan lives; a
   date the job planned and never published is a failure, not a gap.
5. **Statistics are compared as independent evidence.** Session open and close
   are compared with the staged `statistics` reference under
   `/srv/terminal-data/reference/` — `stat_type` 1 and 11, or 3 for a futures
   settlement — skipping any value carrying the DBN sentinel
   `9223372036854775807`. Every difference is retained for review.

   **Compare by containment, not equality.** The first trade of a *UTC day* is
   not the session open: a UTC day begins at 20:00 ET and opens with
   extended-hours prints, so the two are different quantities and equality fails
   on every date — measured on AAPL 2025-09, 42 of 42 comparisons differ. The
   invariant that holds is that an official print falls **inside** the day's
   traded range, `low <= reference <= high`. Under that rule the same data gives
   42 of 42 inside, and the ES+NQ two-worker output a further 20 of 20. A print
   outside the range is real evidence of dropped or corrupted trades; an
   inequality on its own is not.

   **Do not assert volume equality.** Measured against AAPL 2025-09, converted
   trade volume runs 3.19–4.01× `stat_type=11` quantity with a ratio that
   varies by day, so the two count different populations — that statistic is an
   auction figure, not the session total. Official venue volume is not an
   equality invariant in general either: it can include block, auction, OTC or
   other activity outside the electronic feed. A difference is evidence to
   explain, never permission to rewrite canonical output.
6. **Every quarantined date has readable evidence.** The archived
   `rejections/rejections-<date>.json` exists, its SHA-256 matches the value
   recorded in `checkpoint.json`, and it names a reason, source position and
   sample rows.
7. **Remediation is owned.** Each partial month's `operator_action_required`
   has a decision recorded against it — fix and `retry_quarantined`, or accept
   and document the gap. An unreviewed partial month means the archive has a
   hole nobody has agreed to.

## 4. Reference data

`/srv/terminal-data/reference/` holds a local mirror of the three small
non-market schemas, used for diagnosis and for closure check 5. S3 `raw/`
remains the authority if the mirror ever drifts.

- `definition` — which contract an alias resolves to, tick size, multiplier,
  expiration. The authority on roll boundaries.
- `status` — trading-session state: halts, pauses, open and close. Explains
  short or empty-looking days.
- `statistics` — settlement, open interest, session high/low, cleared volume.
  The independent cross-check.

Pairing for any failure: the evidence file names the row, the reference data
explains why that row is unusual. Neither alone is a diagnosis.
