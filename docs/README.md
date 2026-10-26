# Terminal-L1-L2 developer handbook

This handbook describes the supported market-data terminal, its hosted capture
and query services, and the contracts between them. Start here instead of using
roadmap tickets as operating instructions.

## Choose your task

| I need to… | Start with |
|---|---|
| Run the terminal on my laptop | [Developer onboarding](operations/00-developer-onboarding.md) |
| Build an indicator: where its data comes from and the rules it follows | [Data for indicator authors](architecture/indicators/data-for-indicator-authors.md) |
| Understand the complete laptop/host/S3 topology | [Hosted platform architecture](operations/01-hosted-platform.md) |
| Get WireGuard, dxFeed broker or SSH access, or fix a failing `npm run doctor` | [Developer access](operations/02-developer-access.md) |
| Issue, rotate or revoke a developer's access | [Server runbook, section 8](operations/03-server-runbook.md#8-issue-rotate-and-revoke-developer-access) |
| Inspect, deploy, restart, or recover host services | [Server runbook](operations/03-server-runbook.md) |
| Run or reconcile archive conversion | [Archive runbook](operations/04-archive-runbook.md) |
| Audit a long conversion run | [Run-closure audit](operations/05-run-closure-audit.md) |
| Operate or troubleshoot Historical Mode | [Archive-query service](operations/06-archive-query-service.md) |
| Accept an external-developer handoff | [Handoff acceptance](operations/07-external-developer-acceptance.md) |
| Run collectors, S3-backed Historical Mode or raw backfill on a laptop (operators) | [Operator tooling](operations/08-operator-tooling.md) |
| Look up a setting: what reads it, the values it accepts, where it is set | [Configuration](operations/09-configuration.md) |
| Understand recent live-storage history | [Storage architecture](architecture/storage/storage.md) |
| Understand versioned archive objects | [Archive contract](contracts/archive/v1/README.md) |
| Find the contract for a boundary | [Contract index](contracts/README.md) |
| Change the instrument catalog or roll futures | [Governed catalog](../config/README.md) |
| Prove a change locally: the gate, mutation checks, stale mutants | [Testing and gates](operations/10-testing-and-gates.md) |
| Follow the full-flow audit: system map, baselines, findings | [Full-flow audit](audit/full-flow-audit.md) |

## Current system boundary

The repository contains two distinct historical-data paths:

- The **live-storage path** reads recent Binance or dxFeed collector SQLite
  data. The host service is loopback-only; the authenticated gateway exposes
  its bounded API only on the approved WireGuard interface. A laptop runtime
  can use it for indicator warm-up and supported replay/backfill while keeping
  live provider connections local.
- The **curated archive path** reads immutable published S3 partitions through
  the loopback archive-query service and the same authenticated gateway.
  Historical Mode reaches it through Vite's `/archive` proxy, and asks the
  gateway's `/archive/study` route for studies computed on the host.

Hosted Binance capture, hosted weekday dxFeed capture, the live-storage
service, archive-query service, and authenticated gateway have operational
implementations. This statement describes available system capabilities, not
current process health. Use the read-only checks in the
[server runbook](operations/03-server-runbook.md) to determine what is running.

The local market-data WebSocket remains local. The gateway does not distribute
live ticks to laptops.

## Work by subsystem

| Subsystem | Final-state entry | Detailed evidence or contract |
|---|---|---|
| Binance live feed | [Binance final-state overview](architecture/binance/README.md) | [Phase evidence](architecture/binance/P1.06-binance-phase1-exit-evidence.md), [feed-health contract](contracts/binance-feed-health/v1/binance-feed-health-v1.md) |
| dxFeed live feed | [dxFeed final-state overview](architecture/dxfeed/README.md) | [Capability reference](architecture/dxfeed/dxfeed-data-capability-reference.md), [event contract](contracts/dxfeed-canonical-event/v1/dxfeed-canonical-event-v1.md) |
| Recent capture/storage and replay | [Storage, warm-up, replay, and archive](architecture/storage/README.md) | [Binance storage contract](contracts/storage-layer/v1/storage-layer-v1.md), [dxFeed storage contract](contracts/dxfeed-storage-layer/v1/dxfeed-storage-layer-v1.md) |
| Curated history | [Conversion architecture](architecture/historical-conversion.md) | [Market-observation contract](contracts/market-observation/v1/README.md), [archive contract](contracts/archive/v1/README.md) |
| Indicators and UI | [Final-state indicator index](architecture/indicators/README.md) | [Indicator SDK evidence](architecture/indicator-sdk/TA.01-indicator-authoring-core-evidence.md) |
| L2 memory | [L2 memory system](architecture/l2/memory-system.md), [heatmap lanes](architecture/l2/heatmap-lanes.md) | Provider order-book contracts in `contracts/` |
| Host operations | [Server runbook](operations/03-server-runbook.md) | `ops/linux-host/` |

The governed instrument membership, exact provider symbols, order sources, and
tick sizes live in [`config/market-instruments.json`](../config/market-instruments.json).
Documentation should refer to that catalog instead of duplicating a count that
will become stale at the next futures roll or instrument addition.

## How to interpret these documents

| Document class | Meaning |
|---|---|
| Final-state guide | Supported architecture or procedure. Keep it synchronized with code and operations. |
| Contract | Versioned meaning and invariants at a boundary. Do not change semantics through prose alone. |
| Runbook | Commands, preconditions, expected evidence, recovery, and ownership for an operational task. |
| Evidence | A dated implementation or qualification observation. It is traceability, not proof of current deployment or health. |
| Generated report | Output from a particular run. Reproduce or refresh it before relying on current coverage. |

Files named `*-evidence.md` and generated `*-report.json` are historical or
dated evidence unless an authoritative guide explicitly says otherwise.
“Implemented,” “deployed,” “enabled,” “running,” and “live-accepted” are not
interchangeable:

- **Implemented:** reviewed code and tests exist.
- **Deployed:** a revision is installed on the host.
- **Enabled:** the supervisor is configured to start it automatically.
- **Running:** a current observation shows the process active.
- **Live-accepted:** the real provider/network/storage path passed its recorded
  acceptance check.

## Documentation rules

Raw means provider bytes; capture means locally recorded live data; curated
means validated conversion output. A partition is an
instrument/family/version/UTC-date unit. A manifest describes its exact files.
A catalog snapshot indexes published partitions. A successful process is not
proof of complete market coverage.

Keep secrets, private keys, personal peer configurations, and reusable bearer
values out of Git and documentation. Update a data-format contract, executable
validation, and tests together. Update the relevant runbook in the same change
as an operational script, unit, port, environment variable, or lifecycle
change.
