# Host data layout

See the [platform guide](../../../docs/operations/01-hosted-platform.md) for the full flow and the [runbook](../../../docs/operations/03-server-runbook.md) for operations.

## Storage boundaries

The dedicated data NVMe is mounted at `/srv/terminal-data`. The OS and data drives are separate, not mirrored. Verify the mounted source with `findmnt` before operating on data. Formatting scripts are retained provisioning artifacts and must not be rerun on this populated volume.

| Path | Purpose |
|---|---|
| `/srv/terminal-data/capture` | Collector databases, WAL and companion stores; service-owned |
| `/srv/terminal-data/scratch` | Conversion temporary files; build/conversion-owned |
| `/srv/terminal-data/curated-staging` | Outputs awaiting validation |
| `/srv/terminal-data/curated` | `ttconvert`-owned published partitions, locks and local catalog snapshots |
| `/srv/terminal-data/query-cache` | `ttquery`-owned verified Parquet serving cache; never a publication source |
| `/srv/terminal-data/qualification` | Isolated qualification fixtures |
| `/srv/terminal-data/backup-staging` | Local staging, not an off-host backup |
| `/var/lib/terminal-l1-l2` | Small service state |
| `/var/log/terminal-l1-l2/collect` | Collector file logs managed by periodic retention |
| `/etc/terminal-l1-l2` | Protected environment files loaded by systemd |
| `/opt/terminal-l1-l2` | Runtime tools, operational scripts and versioned application releases |

## Protection layers

- Mount guards prevent capture from falling back onto the OS disk when the data volume is absent.
- Disk monitoring checks available capacity without deleting data.
- Application capacity limits must reflect the deployed configuration and measured capture growth.
- Log retention preserves active logs; its target budget is not a hard filesystem quota. The systemd journal is separate.
- Filesystem quotas are not assumed enabled. Enabling them requires a separately validated filesystem-specific procedure and workload sizing.

Retention and archive policy must use sustained measurements, including WAL, conversion scratch and operating headroom. Short capture samples do not establish months of usable capacity. Do not delete SQLite WAL files or copy only an active database file as a backup strategy.
