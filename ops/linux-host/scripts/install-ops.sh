#!/usr/bin/env bash
set -euo pipefail
umask 022

adopt=0
if test "${1:-}" = --adopt; then
  adopt=1
  shift
fi
test "$#" -eq 0 || { echo 'usage: install-ops.sh [--adopt]' >&2; exit 2; }
test "$(id -u)" = 0
for command in awk cp cut date find flock install ln mv readlink rm sha256sum sort systemctl systemd-analyze xargs; do
  command -v "$command" >/dev/null || { echo "install-ops.sh: missing required command: $command" >&2; exit 1; }
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_root=$(readlink -f "$script_dir/..")
opt_root=${TT_OPT_ROOT:-/opt/terminal-l1-l2}
ops_link="$opt_root/ops"
releases="$opt_root/ops-releases"
unit_dir=/etc/systemd/system
journald_dir=/etc/systemd/journald.conf.d
stamp=$(date -u +%Y%m%dT%H%M%SZ)
source_checkout=$(readlink -f "$source_root/../..")
revision=
if command -v git >/dev/null; then
  revision=$(git -c safe.directory='*' -C "$source_checkout" rev-parse --verify --short=12 HEAD 2>/dev/null || true)
fi
if test -n "$revision"; then
  dirty=$(git -c safe.directory='*' -C "$source_checkout" status --porcelain -- ops/linux-host)
  test -z "$dirty" || { echo 'install-ops.sh: source ops tree has uncommitted or untracked files' >&2; exit 1; }
else
  revision=$(find "$source_root" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
fi

active_root=$(readlink -f "$ops_link" 2>/dev/null || true)
test "$source_root" != "$active_root" || { echo 'install-ops.sh: run the reviewed source copy, not the active ops tree' >&2; exit 1; }

unit_names=(
  terminal-alert@.service
  terminal-archive-gateway.service
  terminal-archive-query.service
  terminal-archive-l2-query.service
  terminal-backfill@.service
  terminal-backfill-binance@.service
  terminal-collector.service
  terminal-daily-notional-rollup.service
  terminal-daily-notional-rollup.timer
  terminal-disk-space.service
  terminal-disk-space.timer
  terminal-capture-freshness.service
  terminal-capture-freshness.timer
  terminal-capture-export.service
  terminal-capture-export.timer
  terminal-capture-retention.service
  terminal-capture-retention.timer
  terminal-dxfeed-collector-start.timer
  terminal-dxfeed-collector-stop.service
  terminal-dxfeed-collector-stop.timer
  terminal-dxfeed-collector.service
  terminal-heatmap-pyramid.service
  terminal-iceberg-history.service
  terminal-live-storage.service
  terminal-log-retention.service
  terminal-log-retention.timer
  terminal.slice
)
for name in "${unit_names[@]}"; do
  test -f "$source_root/systemd/$name" || { echo "install-ops.sh: missing unit: $name" >&2; exit 1; }
done
test -f "$source_root/systemd/journald.conf.d/terminal.conf"

if test -e "$ops_link" && ! test -L "$ops_link" && test "$adopt" -ne 1; then
  echo 'install-ops.sh: existing ops directory requires explicit --adopt migration' >&2
  exit 1
fi

install -d -o root -g root -m 755 "$opt_root" "$releases" "$unit_dir" "$journald_dir"
exec 8>"$opt_root/.deploy.lock"
flock -n 8 || { echo "install-ops.sh: another deployment or ops installation holds $opt_root/.deploy.lock" >&2; exit 1; }
exec 9>"$opt_root/.ops-install.lock"
flock -n 9 || { echo "install-ops.sh: another ops installation holds $opt_root/.ops-install.lock" >&2; exit 1; }
stage=$(mktemp -d "$releases/.ops-stage.XXXXXXXX")
adopted_destinations=()
created_destinations=()
old_ops_kind=none
old_ops=
old_ops_link_target=
ops_selected=0
installation_committed=0
cleanup() {
  test -z "${stage:-}" || rm -rf -- "$stage"
}
restore_managed_paths() {
  local destination legacy
  for destination in "${adopted_destinations[@]}"; do
    legacy="$destination.terminal-legacy-$stamp"
    rm -f -- "$destination" || true
    test ! -e "$legacy" && ! test -L "$legacy" || mv -T "$legacy" "$destination" || true
  done
  for destination in "${created_destinations[@]}"; do
    rm -f -- "$destination" || true
  done
}
restore_active_ops() {
  case "$old_ops_kind" in
    link)
      ln -sfn "$old_ops_link_target" "$ops_next"
      mv -T "$ops_next" "$ops_link"
      ;;
    directory)
      rm -f -- "$ops_link"
      mv -T "$old_ops" "$ops_link"
      ;;
    none) rm -f -- "$ops_link" ;;
  esac
}
rollback() {
  test "$installation_committed" -eq 0 || return 0
  if test "$ops_selected" -eq 1; then
    restore_active_ops || true
  fi
  restore_managed_paths
  systemctl daemon-reload || true
}
finish() {
  status=$?
  test "$status" -eq 0 || rollback
  cleanup
  exit "$status"
}
trap finish EXIT
cp -a "$source_root/." "$stage/"
find "$stage" -type d -exec chmod 755 {} +
find "$stage/scripts" -type f -exec chmod 755 {} +
find "$stage" -type f ! -path "$stage/scripts/*" -exec chmod 644 {} +
chown -R --no-dereference root:root "$stage"
special=$(find "$stage" \( -type b -o -type c -o -type p -o -type s \) -print -quit)
test -z "$special" || { echo "install-ops.sh: ops source contains a device/socket/fifo ($special)" >&2; exit 1; }
while IFS= read -r -d '' link; do
  target=$(readlink -m "$link")
  case "$target/" in
    "$stage"/*) : ;;
    *) echo "install-ops.sh: source symlink escapes the ops release: $link -> $target" >&2; exit 1 ;;
  esac
done < <(find "$stage" -type l -print0)
if ! verify_log=$(systemd-analyze verify "${unit_names[@]/#/$stage/systemd/}" 2>&1); then
  residual=$(printf '%s\n' "$verify_log" | grep -vE "^[^:]+: Command $opt_root/[^ ]+ is not executable: No such file or directory$" | grep -v '^$' || true)
  test -z "$residual" || { printf '%s\n' "$verify_log" >&2; echo 'install-ops.sh: unit verification failed' >&2; exit 1; }
  printf 'install-ops.sh: ops-tree executables absent, expected while bootstrapping:\n%s\n' "$verify_log" >&2
fi
(
  cd "$stage"
  find . -type f ! -name OPS_MANIFEST.sha256 -printf '%P\0' | sort -z | xargs -0 -r sha256sum
) > "$stage/OPS_MANIFEST.sha256"
manifest_sha256=$(sha256sum "$stage/OPS_MANIFEST.sha256" | awk '{print $1}')
printf 'revision=%s\ninstalled_from=%s\ncreated_at=%s\nmanifest_sha256=%s\n' "$revision" "$source_root" "$stamp" "$manifest_sha256" > "$stage/OPS_METADATA"
release="$releases/$stamp-$revision"
test ! -e "$release" || { echo "install-ops.sh: release already exists: $release" >&2; exit 1; }
mv -T "$stage" "$release"
stage=

backup_existing() {
  local destination=$1
  test -e "$destination" || test -L "$destination" || return 0
  if test -L "$destination" && test "$(readlink "$destination")" = "$2"; then
    return 0
  fi
  test "$adopt" -eq 1 || { echo "install-ops.sh: unmanaged path requires --adopt: $destination" >&2; exit 1; }
  mv -T "$destination" "$destination.terminal-legacy-$stamp"
  adopted_destinations+=("$destination")
}

# Refuse all unmanaged destinations before moving any legacy unit. This turns a
# missing --adopt flag into a no-op rather than a partially migrated host.
for name in "${unit_names[@]}"; do
  destination="$unit_dir/$name"
  target="$ops_link/systemd/$name"
  if (test -e "$destination" || test -L "$destination") && \
     (! test -L "$destination" || test "$(readlink "$destination")" != "$target"); then
    test "$adopt" -eq 1 || { echo "install-ops.sh: unmanaged path requires --adopt: $destination" >&2; exit 1; }
  fi
done
journald_destination="$journald_dir/terminal.conf"
journald_target="$ops_link/systemd/journald.conf.d/terminal.conf"
if (test -e "$journald_destination" || test -L "$journald_destination") && \
   (! test -L "$journald_destination" || test "$(readlink "$journald_destination")" != "$journald_target"); then
  test "$adopt" -eq 1 || { echo "install-ops.sh: unmanaged path requires --adopt: $journald_destination" >&2; exit 1; }
fi

for name in "${unit_names[@]}"; do
  destination="$unit_dir/$name"
  target="$ops_link/systemd/$name"
  if ! test -e "$destination" && ! test -L "$destination"; then
    created_destinations+=("$destination")
  fi
  backup_existing "$destination" "$target"
  next="$unit_dir/.${name}.next.$$"
  ln -sfn "$target" "$next"
  mv -T "$next" "$destination"
done
journald_destination="$journald_dir/terminal.conf"
journald_target="$ops_link/systemd/journald.conf.d/terminal.conf"
if ! test -e "$journald_destination" && ! test -L "$journald_destination"; then
  created_destinations+=("$journald_destination")
fi
backup_existing "$journald_destination" "$journald_target"
journald_next="$journald_dir/.terminal.conf.next.$$"
ln -sfn "$journald_target" "$journald_next"
mv -T "$journald_next" "$journald_destination"

if test -L "$ops_link"; then
  old_ops_kind=link
  old_ops_link_target=$(readlink "$ops_link")
  old_ops=$(readlink -f "$ops_link" 2>/dev/null || true)
elif test -e "$ops_link"; then
  old_ops_kind=directory
  legacy="$releases/legacy-$stamp"
  mv -T "$ops_link" "$legacy"
  old_ops=$legacy
fi
ops_next="$opt_root/.ops.next.$$"
ln -sfn "$release" "$ops_next"
mv -T "$ops_next" "$ops_link"
ops_selected=1

if ! systemctl daemon-reload; then
  echo 'install-ops.sh: daemon-reload failed; active ops link will be restored' >&2
  exit 1
fi
for name in "${unit_names[@]}"; do
  destination="$unit_dir/$name"
  target="$ops_link/systemd/$name"
  query=$name
  case "$name" in *@.*) query=${name/@./@probe.} ;; esac
  fragment=$(systemctl show --value --property FragmentPath "$query" 2>/dev/null || true)
  if test -z "$fragment" || ! test -L "$destination" || test "$(readlink "$destination")" != "$target"; then
    echo "install-ops.sh: unit is not loadable from its managed path: $name; active ops link will be restored" >&2
    exit 1
  fi
done
installation_committed=1
echo "OPS_RELEASE_INSTALLED=$release"
echo "OPS_MANIFEST=$release/OPS_MANIFEST.sha256"
echo 'JOURNALD_RESTART_REQUIRED=1'
