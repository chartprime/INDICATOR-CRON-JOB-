#!/usr/bin/env bash
# Run the L1 release gate under the same service identity and credentials as
# the backfill worker. It only reads S3 and host state; preflight_l1.py keeps
# its temporary scan files and durable report under curated-staging.
#
# Usage: sudo run-l1-preflight.sh <reviewed-commit> [pool-size]
set -euo pipefail

expected_commit=${1:?usage: run-l1-preflight.sh <reviewed-commit> [pool-size]}
pool_size=${2:-1}
opt_root=${TT_OPT_ROOT:-/opt/terminal-l1-l2}
data_root=${TT_DATA_ROOT:-/srv/terminal-data}
service_env=${TT_CONVERT_SERVICE_ENV:-/etc/terminal-l1-l2/convert/service.env}
service_unit=${TT_L1_SERVICE:-terminal-backfill@l1.service}
runtime_user=${TT_CONVERT_USER:-ttconvert}
python=$opt_root/converter-env/.venv/bin/python
release=$opt_root/current

test "$(id -u)" -eq 0
for command in date findmnt install systemd-run; do command -v "$command" >/dev/null; done
id "$runtime_user" >/dev/null
test -x "$python"
test -f "$release/apps/runtime/conversion/preflight_l1.py"
test -f "$opt_root/ops/scripts/check-service-env.sh"
test -f "$opt_root/ops/systemd/terminal-backfill@.service"
findmnt -rn -M "$data_root" >/dev/null
[[ $expected_commit =~ ^[0-9a-f]{7,64}$ ]] || { echo "invalid reviewed commit" >&2; exit 2; }
[[ $pool_size =~ ^[1-9][0-9]{0,2}$ ]] || { echo "invalid pool size" >&2; exit 2; }

"$opt_root/ops/scripts/check-service-env.sh" "$service_env" convert

scan_dir=$data_root/curated-staging/_preflight
report_dir=$scan_dir/reports
install -d -o "$runtime_user" -g "$runtime_user" -m 700 "$scan_dir"
install -d -o "$runtime_user" -g "$runtime_user" -m 700 "$report_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
unit=terminal-l1-preflight-${stamp}-$$
report=$report_dir/l1-${stamp}-${expected_commit:0:12}.json

set +e
systemd-run \
  --unit="$unit" --wait --collect --pipe \
  -p "Type=oneshot" \
  -p "User=$runtime_user" \
  -p "Group=$runtime_user" \
  -p "Slice=terminalconversion.slice" \
  -p "WorkingDirectory=$release/apps/runtime" \
  -p "EnvironmentFile=$service_env" \
  -p "TimeoutStartSec=infinity" \
  -p "CPUQuota=1600%" \
  -p "MemoryHigh=32G" \
  -p "MemoryMax=48G" \
  -p "TasksMax=256" \
  -p "Nice=15" \
  -p "IOSchedulingClass=3" \
  -p "UMask=0077" \
  -p "NoNewPrivileges=yes" \
  -p "ProtectSystem=strict" \
  -p "ProtectHome=yes" \
  -p "PrivateTmp=yes" \
  -p "PrivateDevices=yes" \
  -p "ProtectKernelTunables=yes" \
  -p "ProtectKernelModules=yes" \
  -p "ProtectControlGroups=yes" \
  -p "RestrictSUIDSGID=yes" \
  -p "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" \
  -p "CapabilityBoundingSet=" \
  -p "ReadWritePaths=$data_root/curated $data_root/curated-staging" \
  -p "ReadWritePaths=$data_root/curated-staging.sequence.guard" \
  -- "$python" "$release/apps/runtime/conversion/preflight_l1.py" \
  --expected-commit "$expected_commit" \
  --pool-size "$pool_size" \
  --report "$report" \
  --staging-root "$data_root/curated-staging" \
  --curated-root "$data_root/curated" \
  --health-file /run/terminal-l1-l2/collector-health.json \
  --unit /etc/systemd/system/terminal-backfill@.service \
  --ops-unit "$opt_root/ops/systemd/terminal-backfill@.service" \
  --service "$service_unit" \
  --service-env "$service_env"
result=$?
set -e

printf 'l1 preflight report: %s\n' "$report"
exit "$result"
