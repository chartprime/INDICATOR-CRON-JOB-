#!/usr/bin/env bash
set -euo pipefail

config=${TT_MONITORING_ENV:-/etc/terminal-l1-l2/monitoring.env}
health_file=${TT_COLLECTOR_HEALTH_FILE:-/run/terminal-l1-l2/collector-health.json}
max_age_s=180
max_write_lag_ms=120000
max_recovery_age_ms=300000

env_age=${TT_CAPTURE_MAX_HEALTH_AGE_S:-}
if test -r "$config"; then
  . "$config"
fi
max_age_s=${env_age:-${TT_CAPTURE_MAX_HEALTH_AGE_S:-$max_age_s}}

fail() {
  logger -t terminal-capture-freshness -p user.err -- "$1" || true
  echo "$1" >&2
  exit 1
}

case $max_age_s in
  ''|0*|*[!0-9]*) fail "terminal-l1-l2 capture freshness check misconfigured: TT_CAPTURE_MAX_HEALTH_AGE_S=${max_age_s}" ;;
esac

if ! systemctl is-active --quiet terminal-collector.service; then
  fail "terminal-l1-l2 capture stopped: terminal-collector.service is not active"
fi
test -r "$health_file" || fail "terminal-l1-l2 capture health unknown: ${health_file} is missing"

now=$(date +%s)
modified=$(stat -c %Y "$health_file")
age=$((now - modified))
test "$age" -le "$max_age_s" || fail "terminal-l1-l2 capture stalled: collector health last written ${age}s ago"

write_lag=$(sed -n 's/.*"writeLagMs"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$health_file" | head -n1)
test -n "$write_lag" || fail "terminal-l1-l2 capture health unreadable: writeLagMs absent"
test "$write_lag" -le "$max_write_lag_ms" || fail "terminal-l1-l2 capture writes stalled: oldest pending write ${write_lag} ms"

collector_status=$(sed -n 's/.*"collectorStatus"[[:space:]]*:[[:space:]]*"\([A-Z]*\)".*/\1/p' "$health_file" | head -n1)
recovery_age=$(sed -n 's/.*"recoveryAgeMs"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$health_file" | head -n1)
test -n "$collector_status" && test -n "$recovery_age" || fail "terminal-l1-l2 capture health unreadable: recovery status absent"
test "$collector_status" != INVALID || fail "terminal-l1-l2 capture invalid: collector integrity monitor reported a fatal failure"
test "$recovery_age" -le "$max_recovery_age_ms" || fail "terminal-l1-l2 capture recovery stalled: oldest active recovery ${recovery_age} ms"

echo "capture fresh: health ${age}s old, write lag ${write_lag} ms, recovery ${recovery_age} ms"
