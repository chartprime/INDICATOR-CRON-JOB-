#!/usr/bin/env bash
set -euo pipefail

target=${1:?usage: select-release.sh <release-dir|previous>}
opt_root=${TT_OPT_ROOT:-/opt/terminal-l1-l2}

test "$(id -u)" = 0
command -v flock >/dev/null || { echo "select-release.sh: missing required command: flock" >&2; exit 1; }

exec 9>"$opt_root/.deploy.lock"
flock -n 9 || { echo "select-release.sh: another deployment holds $opt_root/.deploy.lock" >&2; exit 1; }

if test "$target" = previous; then
  test -L "$opt_root/previous" || { echo "select-release.sh: no previous release is recorded" >&2; exit 1; }
  target=$(readlink -e "$opt_root/previous") || { echo "select-release.sh: previous points at a missing release" >&2; exit 1; }
fi

release=$(readlink -e "$target") || { echo "select-release.sh: $target does not exist" >&2; exit 1; }
case "$release" in
  "$opt_root"/releases/*) : ;;
  *) echo "select-release.sh: $release is not under $opt_root/releases" >&2; exit 1 ;;
esac
test -d "$release" || { echo "select-release.sh: $release is not a directory" >&2; exit 1; }
test -f "$release/RELEASE_METADATA" || { echo "select-release.sh: $release has no RELEASE_METADATA; it was not activated by deploy.sh" >&2; exit 1; }
bad=$(find "$release" -maxdepth 0 -not -user root -print -quit)
test -z "$bad" || { echo "select-release.sh: $release is not root-owned" >&2; exit 1; }

old_current=
if test -L "$opt_root/current"; then
  old_current=$(readlink -e "$opt_root/current")
elif test -e "$opt_root/current"; then
  echo 'select-release.sh: current exists but is not a release symlink' >&2
  exit 1
fi
if test "$old_current" = "$release"; then
  echo "select-release.sh: $release is already current; nothing changed"
  exit 0
fi

tmp_link="$opt_root/.current.next.$$"
ln -sfn "$release" "$tmp_link"
mv -T "$tmp_link" "$opt_root/current"

if test -n "$old_current"; then
  prev_tmp="$opt_root/.previous.next.$$"
  if ln -sfn "$old_current" "$prev_tmp" && mv -T "$prev_tmp" "$opt_root/previous"; then
    :
  else
    rm -f "$prev_tmp" 2>/dev/null || true
    echo "select-release.sh: release selected; previous not updated to $old_current" >&2
  fi
fi

echo "selected  $release"
echo "current   -> $(readlink -e "$opt_root/current")"
test -L "$opt_root/previous" && echo "previous  -> $(readlink -e "$opt_root/previous")"
sed -n 's/^commit=/commit    /p' "$release/RELEASE_METADATA"
echo "Running services keep their code until they are restarted."
echo RUNTIME_RELEASE_SELECTED
