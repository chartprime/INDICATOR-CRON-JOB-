#!/usr/bin/env bash
# Read-only free-space check for /srv/terminal-data and /. Exits non-zero on a
# breach or a bad floor value; terminal-alert@ does the notification.
set -euo pipefail

config=${TT_MONITORING_ENV:-/etc/terminal-l1-l2/monitoring.env}
data_mount=/srv/terminal-data
root_mount=/

min_free_data_gib=50
min_free_root_gib=10
max_floor_gib=1048576

env_data=${TT_DISK_MIN_FREE_DATA_GIB:-}
env_root=${TT_DISK_MIN_FREE_ROOT_GIB:-}
if test -r "$config"; then
  # shellcheck disable=SC1090
  . "$config"
fi
min_free_data_gib=${env_data:-${TT_DISK_MIN_FREE_DATA_GIB:-$min_free_data_gib}}
min_free_root_gib=${env_root:-${TT_DISK_MIN_FREE_ROOT_GIB:-$min_free_root_gib}}

fail() {
  logger -t terminal-disk-space -p user.err -- "$1" || true
  echo "$1" >&2
  exit 1
}

validate_floor() {
  local name=$1 value=$2
  case $value in
    ''|0*|*[!0-9]*) fail "terminal-l1-l2 disk space check misconfigured: ${name}=${value} must be a positive integer, no leading zero" ;;
  esac
  test "$value" -le "$max_floor_gib" || fail "terminal-l1-l2 disk space check misconfigured: ${name}=${value} exceeds ${max_floor_gib} GiB"
}

validate_floor TT_DISK_MIN_FREE_DATA_GIB "$min_free_data_gib"
validate_floor TT_DISK_MIN_FREE_ROOT_GIB "$min_free_root_gib"

gib=$((1024 * 1024 * 1024))
breaches=()

free_bytes() {
  df -B1 --output=avail "$1" 2>/dev/null | tail -1 | tr -dc '0-9'
}

check() {
  local path=$1 floor_gib=$2 avail
  avail=$(free_bytes "$path")
  if test -z "$avail"; then
    breaches+=("$path: free space unreadable")
    return
  fi
  if test "$avail" -lt "$((floor_gib * gib))"; then
    breaches+=("$path: $((avail / gib)) GiB free, floor ${floor_gib} GiB")
  fi
}

if ! findmnt -rn -M "$data_mount" >/dev/null 2>&1; then
  breaches+=("$data_mount: not mounted")
else
  check "$data_mount" "$min_free_data_gib"
fi
check "$root_mount" "$min_free_root_gib"

if test "${#breaches[@]}" -eq 0; then
  echo "disk space ok: $data_mount, $root_mount above floors"
  exit 0
fi

fail "terminal-l1-l2 disk space low: $(printf '%s; ' "${breaches[@]}")"
