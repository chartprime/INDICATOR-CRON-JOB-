#!/usr/bin/env bash
# Idempotent. Gives ttquery its cache root and read-only reach into the curated
# tree, which prepare-data-disk.sh created as 0700 ttconvert.
set -euo pipefail
test "$(id -u)" = 0
id ttquery >/dev/null
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sources_file=$script_dir/../config/archive-sources.json
root=/srv/terminal-data
findmnt -rn -M "$root" >/dev/null
test -d "$root/curated"
test -f "$sources_file"

install -d -o ttquery -g ttquery -m 700 "$root/query-cache"
install -d -o ttquery -g ttquery -m 700 "$root/query-cache/databento"
install -d -o ttquery -g ttquery -m 700 "$root/query-cache/binance"
install -d -o ttquery -g ttquery -m 700 "$root/query-cache/l2"
install -d -o ttquery -g ttquery -m 700 "$root/query-catalogs"
install -d -o ttquery -g ttquery -m 700 "$root/query-catalogs/databento"
install -d -o ttquery -g ttquery -m 700 "$root/query-catalogs/binance"
sources_tmp=$(mktemp "$root/query-catalogs/.archive-sources.json.XXXXXXXX")
trap 'rm -f "$sources_tmp"' EXIT
install -o root -g ttquery -m 640 "$sources_file" "$sources_tmp"
mv -T "$sources_tmp" "$root/query-catalogs/archive-sources.json"

setfacl -m u:ttquery:rx "$root"
setfacl -R -m u:ttquery:rX "$root/curated"
setfacl -R -d -m u:ttquery:rX "$root/curated"

getfacl -p "$root/curated" | grep -q '^user:ttquery:r-x$'
runuser -u ttquery -- test -r "$root/curated/_catalog/CURRENT.json"
runuser -u ttquery -- test -d "$root/query-catalogs/databento"
runuser -u ttquery -- test -d "$root/query-catalogs/binance"
runuser -u ttquery -- test -r "$root/query-catalogs/archive-sources.json"
! runuser -u ttquery -- test -w "$root/curated"
echo "prepare-query-role.sh: ttquery can read curated and the source map, and owns $root/query-cache and $root/query-catalogs"
