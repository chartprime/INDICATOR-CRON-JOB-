# Linux host operations

This directory is the implementation surface for the managed Linux host. It is
not the place to infer current service health from committed files.

Start with the operator guides:

1. [Platform architecture](../../docs/operations/01-hosted-platform.md) —
   process, storage, network, and trust boundaries.
2. [Developer access](../../docs/operations/02-developer-access.md) — separate
   SSH control-plane and WireGuard data-plane access.
3. [Server runbook](../../docs/operations/03-server-runbook.md) — health checks,
   deployment, lifecycle, rollback, and incidents.

The [developer handbook](../../docs/README.md) is the documentation entry
point. The [archive runbook](../../docs/operations/04-archive-runbook.md) covers
hosted conversion. Check current service health and publication evidence
separately from implementation availability.

The archive-query and live-storage units are loopback-only. The separate
supervised `ttgateway` process authenticates callers and relays only to those
internal services. In the approved lab topology the gateway may bind to the
host's WireGuard address, never the public NIC. It is not a public browser
transport or a user interface. Do not broaden that boundary without a new
security review.

## Implementation index

| Location | Purpose |
|---|---|
| [scripts/](scripts/) | Installation, deployment, environment guards, disk monitoring and log retention |
| [systemd/](systemd/) | Service units, resource controls and timers |
| [config/](config/) | Placeholder configuration templates; real secrets belong outside Git |
| [Data layout](docs/data-layout.md) | Storage boundaries and protection layers |

The tracked files describe what can be installed. Determine what is deployed,
enabled, and running with the read-only commands in the server runbook. Those
states are deliberately not inferred from the presence of a unit file.

`deploy.sh` resolves a commit, builds in a bounded unprivileged unit, verifies
the candidate, freezes permissions, runs a service-user WAL/persistence check
against the frozen release, and selects it atomically. It does not start a
collector or another application service.

Operational artifacts have their own immutable release pointer at
`/opt/terminal-l1-l2/ops`. Run `scripts/install-ops.sh` from the reviewed source
checkout to validate unit syntax, copy a root-owned ops release, record its
manifest, atomically select it, and reload systemd. The first conversion from
an unmanaged `/opt/terminal-l1-l2/ops` directory requires the explicit
`--adopt` flag. Installation does not imply enabling or starting application
services. A journald configuration change reports that a separately scheduled
journald restart is required.

`prepare-data-disk.sh` is a one-time provisioning artifact, not a normal setup
step for developers. Never rerun it on the populated data disk. Monitoring
detects pressure; it does not delete capture data. External alert delivery and
recovery must be tested separately.
