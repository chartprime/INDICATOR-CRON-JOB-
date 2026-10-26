#!/usr/bin/env bash
# W6.04: root-owned, pinned runtime only. No system PATH or services changed.
set -euo pipefail
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
version=v24.21.0
root=/opt/terminal-l1-l2
name="node-${version}-linux-x64"
expected_sha256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
install -d -m 755 "$root"
if test -e "$root/$name"; then
  test "$("$root/$name/bin/node" --version)" = "$version"
  echo "Existing runtime preserved: $root/$name"
  exit 0
fi
stage=$(mktemp -d "$root/.node-install.XXXXXXXX")
# Retain failed staging for inspection; never overwrite an existing runtime.
python3 - "$version" "$name" "$stage" "$expected_sha256" <<'PY'
import hashlib, pathlib, sys, urllib.request
version, name, stage, expected_sha256 = sys.argv[1:]
stage = pathlib.Path(stage)
base = f'https://nodejs.org/dist/{version}/'
archive = name+'.tar.xz'
h = hashlib.sha256()
with urllib.request.urlopen(base+archive, timeout=60) as r, (stage/archive).open('wb') as f:
    while chunk := r.read(1024*1024):
        h.update(chunk)
        f.write(chunk)
assert h.hexdigest() == expected_sha256, 'Pinned archive checksum mismatch'
(stage/'SHA256.txt').write_text(f'{h.hexdigest()}  {archive}\n')
print('Pinned archive checksum matched:', h.hexdigest())
PY
tar -xJf "$stage/$name.tar.xz" --no-same-owner -C "$stage"
test "$("$stage/$name/bin/node" --version)" = "$version"
cp "$stage/SHA256.txt" "$stage/$name/INSTALL-SHA256.txt"
mv -T "$stage/$name" "$root/$name"
"$root/$name/bin/node" --version
echo "Installed $root/$name; download evidence retained at $stage"
