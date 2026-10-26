#!/usr/bin/env bash
# W6.04: add the scratch and backup-staging directories on the mounted data
# volume. Idempotent. Refuses to run if the volume is not mounted, so it can
# never create these on the OS disk. prepare-data-disk.sh created capture,
# curated-staging, curated and qualification; this only adds what W6.03/W6.15
# scoping added later.
set -euo pipefail
test "$(id -u)" = 0
target=/srv/terminal-data
findmnt -rn -M "$target" >/dev/null
for user in ttconvert; do id "$user" >/dev/null; done
install -d -o ttconvert -g ttconvert -m 700 "$target/scratch"
install -d -o ttconvert -g ttconvert -m 700 "$target/curated-staging"
install -d -o ttconvert -g ttconvert -m 700 "$target/curated"
install -d -o ttconvert -g ttconvert -m 700 "$target/binance-staging"
install -d -o ttconvert -g ttconvert -m 700 "$target/curated-binance"
install -d -o root -g root -m 755 "$target/backup-staging"
install -d -o ttcollect -g ttcollect -m 750 "$target/iceberg-history"
for guard in "$target/curated-staging.sequence.guard" "$target/binance-staging.sequence.guard"; do
  test -e "$guard" || install -o ttconvert -g ttconvert -m 600 /dev/null "$guard"
done
find "$target" -maxdepth 1 -mindepth 1 -printf '%M %u %g %f\n' | sort -k4
echo DATA_DIRS_PROVISIONED
