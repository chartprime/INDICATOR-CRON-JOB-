#!/usr/bin/env bash
# ONE-TIME, HOST-SPECIFIC operation. Never use for another disk/host.
# Authorized 2026-09-09. Refuses existing partitions/signatures; not a repair tool.
set -euo pipefail
test "$(id -u)" = 0
device=/dev/disk/by-id/nvme-eui.002538b241b5c878
target=/srv/terminal-data
disk=$(readlink -f "$device")
test "$disk" = /dev/nvme1n1
test "$(lsblk -dn -o SERIAL "$disk" | xargs)" = S677NX0X200915
test "$(blockdev --getsize64 "$disk")" = 2048408248320
test "$(lsblk -nr -o NAME "$disk" | wc -l)" = 1
signatures=$(wipefs -n --noheadings --output TYPE "$disk")
test -z "$signatures"
test -z "$(lsblk -nr -o MOUNTPOINTS "$disk" | tr -d '[:space:]')"
test -z "$(ls -A /sys/class/block/nvme1n1/holders)"
! findmnt -rn -M "$target"
! grep -q '/srv/terminal-data' /etc/fstab
if test -e "$target"; then
  test -d "$target" && test ! -L "$target"
  test -z "$(ls -A "$target")"
fi
for user in ttcollect ttconvert ttquery; do id "$user" >/dev/null; done
backup=/root/terminal-data-setup-20260909
test ! -e "$backup"
install -d -m 700 "$backup"
cp -a /etc/fstab "$backup/fstab.before"
lsblk -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,SERIAL > "$backup/disks.before"
smartctl -a -j "$disk" > "$backup/health.before.json"
python3 - "$backup/health.before.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); h=d['nvme_smart_health_information_log']
assert d['serial_number']=='S677NX0X200915'
assert d['smart_status']['passed'] and h['critical_warning']==0 and h['media_errors']==0
assert h['percentage_used']==64, 'Health changed: review before proceeding'
PY
parted --script "$disk" mklabel gpt mkpart terminal-data ext4 1MiB 100%
partprobe "$disk"
udevadm settle
part="${disk}p1"
test -b "$part"
mkfs.ext4 -L terminal-data -m 1 "$part"
uuid=$(blkid -s UUID -o value "$part")
test -n "$uuid"
# Root-only underlying mountpoint: absent data volume must not accept service writes.
install -d -o root -g root -m 000 "$target"
printf 'UUID=%s %s ext4 defaults,noatime,nodev,nosuid,noexec,nofail,x-systemd.device-timeout=10s 0 2\n' "$uuid" "$target" >> /etc/fstab
findmnt --verify --tab-file /etc/fstab
systemctl daemon-reload
mount "$target"
test "$(findmnt -rn -M "$target" -o UUID)" = "$uuid"
chmod 755 "$target"
install -d -o ttcollect -g ttcollect -m 700 "$target/capture"
install -d -o ttconvert -g ttconvert -m 700 "$target/curated-staging"
install -d -o ttconvert -g ttconvert -m 700 "$target/qualification"
# The conversion worker creates its locks, catalog and partition directories here.
install -d -o ttconvert -g ttconvert -m 700 "$target/curated"
printf '%s\n' "$uuid" > "$backup/uuid"
findmnt -rn -M "$target" -o TARGET,SOURCE,FSTYPE,OPTIONS
df -B1 "$target"
echo DATA_FILESYSTEM_PREPARED
