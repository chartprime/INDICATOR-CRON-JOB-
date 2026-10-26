#!/usr/bin/env bash
# Build one release from a git commit inside a bounded, data-isolated systemd
# unit as the build user; freeze it root-owned and permission-normalized; verify
# it as the runtime user; then swap `current` atomically. Pruning old releases
# is best-effort and never fails an already-activated deploy.
#
# Usage:  sudo scripts/deploy.sh <git-ref>
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

ref=${1:?usage: deploy.sh <git-ref>}
opt_root=${TT_OPT_ROOT:-/opt/terminal-l1-l2}
node_bin=${TT_NODE_BIN:-$opt_root/node-v24.21.0-linux-x64/bin}
build_user=${TT_BUILD_USER:-ttconvert}
runtime_user=${TT_RUNTIME_USER:-ttcollect}
build_cache=${TT_BUILD_CACHE:-/var/lib/terminal-l1-l2/convert/deploy-cache}
build_timeout=${TT_BUILD_TIMEOUT:-900}
build_mem_max=${TT_BUILD_MEMORY_MAX:-2G}
build_tasks_max=${TT_BUILD_TASKS_MAX:-512}
build_cpu_quota=${TT_BUILD_CPU_QUOTA:-400%}
keep_releases=${TT_KEEP_RELEASES:-5}

_deployed=0
release=

cleanup() {
  rm -f "$opt_root/.current.next.$$" "$opt_root/.previous.next.$$" 2>/dev/null || true
  test -n "$release" || return 0
  test "$_deployed" -eq 0 || return 0
  test "$(readlink -f "$opt_root/current" 2>/dev/null || true)" != "$release" || return 0
  rm -rf -- "$release" 2>/dev/null || true
}
trap cleanup EXIT

test "$(id -u)" = 0
for cmd in git tar find runuser systemd-run flock findmnt readlink; do
  command -v "$cmd" >/dev/null || { echo "deploy.sh: missing required command: $cmd" >&2; exit 1; }
done
test -x "$node_bin/node"
test -x "$node_bin/npm"
id "$build_user" >/dev/null
id "$runtime_user" >/dev/null
test "$(id -u "$build_user")" -ne 0
test "$(id -u "$runtime_user")" -ne 0
[[ "$keep_releases" =~ ^[1-9][0-9]{0,3}$ ]] || { echo 'Invalid TT_KEEP_RELEASES' >&2; exit 1; }
findmnt -rn -M /srv/terminal-data >/dev/null

exec 9>"$opt_root/.deploy.lock"
flock -n 9 || { echo "deploy.sh: another deployment holds $opt_root/.deploy.lock" >&2; exit 1; }

# 0 if any live process has cwd/exe/root, an open fd (deleted included), or a
# mapping under $1. A live userspace process whose maps cannot be read counts
# as in use; kernel threads and exited processes do not brick the check.
path_in_use() {
  local target=$1 p sub real fd
  for p in /proc/[0-9]*; do
    test -d "$p" || continue
    for sub in cwd exe root; do
      real=$(readlink "$p/$sub" 2>/dev/null) || continue
      real=${real% (deleted)}
      case "$real" in "$target"|"$target"/*) return 0 ;; esac
    done
    for fd in "$p"/fd/*; do
      real=$(readlink "$fd" 2>/dev/null) || continue
      real=${real% (deleted)}
      case "$real" in "$target"|"$target"/*) return 0 ;; esac
    done
    grep -qF "$target/" "$p/maps" 2>/dev/null && return 0
    if test -n "$(readlink "$p/exe" 2>/dev/null)" && ! grep -q . "$p/maps" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

toplevel=$(git -c safe.directory='*' rev-parse --show-toplevel)
commit=$(git -c safe.directory='*' -C "$toplevel" rev-parse --verify --quiet "${ref}^{commit}") || {
  echo "deploy.sh: '$ref' does not resolve to a commit" >&2
  exit 1
}
short=${commit:0:12}
stamp=$(date -u +%Y%m%dT%H%M%SZ)

install -d -m 755 "$opt_root/releases"
install -d -o "$build_user" -g "$build_user" -m 700 "$build_cache"
release=$(mktemp -d "$opt_root/releases/${stamp}-${short}.XXXXXX")
release=$(readlink -f "$release")
chmod 755 "$release"
git -c safe.directory='*' -C "$toplevel" archive --format=tar "$commit" | tar -x -C "$release"
chown -R --no-dereference "$build_user:$build_user" "$release"

# Build + verify inside a transient oneshot unit: build user, network up for the
# registry, no reach into capture data or host secrets, bounded runtime / memory
# / tasks / CPU, whole cgroup killed when it exits.
systemd-run \
  --quiet --pipe --wait --collect \
  -p "Type=oneshot" \
  -p "User=$build_user" \
  -p "Group=$build_user" \
  -p "WorkingDirectory=$release" \
  -p "KillMode=control-group" \
  -p "TimeoutStartSec=$build_timeout" \
  -p "MemoryMax=$build_mem_max" \
  -p "TasksMax=$build_tasks_max" \
  -p "CPUQuota=$build_cpu_quota" \
  -p "PrivateTmp=true" \
  -p "PrivateDevices=true" \
  -p "ProtectHome=true" \
  -p "ProtectSystem=strict" \
  -p "NoNewPrivileges=true" \
  -p "RestrictSUIDSGID=true" \
  -p "ReadWritePaths=$release $build_cache" \
  -p "InaccessiblePaths=-/srv/terminal-data -/etc/terminal-l1-l2" \
  -E "HOME=$build_cache" \
  -E "PATH=$node_bin:/usr/bin:/bin" \
  -E "npm_config_cache=$build_cache/npm" \
  -E "npm_config_audit=false" \
  -E "npm_config_fund=false" \
  -E "RELEASE=$release" \
  -E "VERIFY_CJS=$script_dir/verify-release.cjs" \
  -- bash -euo pipefail -c '
      cd "$RELEASE"
      npm ci --omit=dev --ignore-scripts --workspace @terminal-l1-l2/runtime
      node "$VERIFY_CJS" "$RELEASE"
    '

if path_in_use "$release"; then
  echo "deploy.sh: a process still references $release after the build unit exited" >&2
  exit 1
fi

# Reject special files and symlinks whose target leaves the release.
special=$(find "$release" \( -type b -o -type c -o -type p -o -type s \) -print -quit)
test -z "$special" || { echo "deploy.sh: release contains a device/socket/fifo ($special)" >&2; exit 1; }
while IFS= read -r -d '' link; do
  dest=$(readlink -m "$link")
  case "$dest/" in
    "$release"/*) : ;;
    *) echo "deploy.sh: symlink escapes the release: $link -> $dest" >&2; exit 1 ;;
  esac
done < <(find "$release" -type l -print0)

# Metadata: unlink any existing name first so a build-planted symlink cannot
# redirect this write; the build cgroup is gone, so nothing races us.
rm -f "$release/RELEASE_METADATA"
printf 'ref=%s\ncommit=%s\ndeployed_at=%s\ndeployed_by=%s\n' \
  "$ref" "$commit" "$stamp" "${SUDO_USER:-root}" > "$release/RELEASE_METADATA"

# Freeze: normalize to 0755 dirs / 0644 files (0755 keeps the git exec bit),
# hand the tree to root without following links, then prove the runtime user can
# load it and the build user can no longer change it.
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -perm /0111 -exec chmod 0755 {} +
find "$release" -type f -not -perm /0111 -exec chmod 0644 {} +
chown -R --no-dereference root:root "$release"

bad=$(find "$release" -not -type l \( -not -user root -o -not -group root \) -print -quit)
test -z "$bad" || { echo "deploy.sh: release not fully root-owned ($bad)" >&2; exit 1; }
bad=$(find "$release" -type d -not -perm 0755 -print -quit)
test -z "$bad" || { echo "deploy.sh: release dir permissions off ($bad)" >&2; exit 1; }
bad=$(find "$release" -type f -not \( -perm 0644 -o -perm 0755 \) -print -quit)
test -z "$bad" || { echo "deploy.sh: release file permissions off ($bad)" >&2; exit 1; }

runuser -u "$runtime_user" -- "$node_bin/node" "$script_dir/verify-runtime.cjs" "$release"

# Atomic activation. Mark deployed and disarm cleanup the instant `current`
# points at the new release; everything after is non-fatal.
old_current=
if test -L "$opt_root/current"; then
  old_current=$(readlink -e "$opt_root/current")
elif test -e "$opt_root/current"; then
  echo 'deploy.sh: current exists but is not a release symlink' >&2
  exit 1
fi
tmp_link="$opt_root/.current.next.$$"
ln -sfn "$release" "$tmp_link"
mv -T "$tmp_link" "$opt_root/current"
_deployed=1
trap - EXIT
current_target=$(readlink -f "$opt_root/current" 2>/dev/null || echo "$release")

if test -n "$old_current" && test "$old_current" != "$current_target"; then
  prev_tmp="$opt_root/.previous.next.$$"
  if ln -sfn "$old_current" "$prev_tmp" && mv -T "$prev_tmp" "$opt_root/previous"; then
    :
  else
    rm -f "$prev_tmp" 2>/dev/null || true
    echo "deploy.sh: release activated; rollback pointer not updated to $old_current" >&2
  fi
fi
previous_target=
if test -L "$opt_root/previous"; then
  previous_target=$(readlink -e "$opt_root/previous" 2>/dev/null || true)
fi

echo "deployed  $release"
echo "current   -> $current_target"
test -n "$previous_target" && echo "rollback  -> $previous_target"
echo RUNTIME_RELEASE_DEPLOYED

# Past this point the release is live. Pruning is best-effort: it never removes
# current, the rollback target, or a release a process still references, and its
# own failures are warnings, not a failed deploy.
prune_releases() {
  local protected dir rp
  # Preserve the outgoing release even if updating previous failed.
  protected=$(printf '%s\n' "$current_target" "$previous_target" "$old_current" | grep -v '^$' | sort -u)
  while IFS= read -r dir; do
    test -n "$dir" || continue
    rp=$(readlink -f "$dir" 2>/dev/null) || continue
    printf '%s\n' "$protected" | grep -qxF "$rp" && continue
    if path_in_use "$rp"; then
      echo "deploy.sh: keeping $rp (in use by a running process)" >&2
      continue
    fi
    rm -rf -- "$dir" || echo "deploy.sh: could not remove old release $dir" >&2
  done < <(ls -1dt "$opt_root/releases"/*/ 2>/dev/null | tail -n +"$((keep_releases + 1))")
  return 0
}
prune_releases
exit 0
