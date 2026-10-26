#!/usr/bin/env bash
# W6.04: ExecStartPre guard. Fail closed unless the role's service env file
# exists, is a regular file, is owned by root, is not readable by group or
# other, and carries the settings the profile declares mandatory.
#
# Usage:  check-service-env.sh /etc/terminal-l1-l2/<role>/service.env [profile]
set -euo pipefail

file=${1:?usage: check-service-env.sh <path>}
profile=${2:-generic}
if test "$profile" = alert-optional && ! test -e "$file"; then
  exit 0
fi
test -f "$file"
read -r mode owner <<<"$(stat -c '%a %U' "$file")"
test "$owner" = root
test "$((0$mode & 077))" -eq 0

case "$profile" in
  generic|alert-optional) ;;
  convert)
    for name in RCLONE_CONFIG_TTCONVERT_REGION RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY; do
      value=$(sed -n "s/^[[:space:]]*$name=//p" "$file" | tail -n1)
      value=${value%\"}; value=${value#\"}
      value=${value%\'}; value=${value#\'}
      test -n "$value" || { echo "check-service-env.sh: required conversion setting is absent: $name" >&2; exit 1; }
    done
    ;;
  gateway)
    for name in TT_ARCHIVE_SERVICE_URL TT_QUERY_SERVICE_SECRET TT_ARCHIVE_CLIENT_TOKENS; do
      value=$(sed -n "s/^[[:space:]]*$name=//p" "$file" | tail -n1)
      value=${value%\"}; value=${value#\"}
      value=${value%\'}; value=${value#\'}
      test -n "$value" || { echo "check-service-env.sh: required gateway setting is absent: $name" >&2; exit 1; }
    done
    ;;
  query)
    for name in TT_QUERY_S3_REGION TT_QUERY_S3_ACCESS_KEY_ID TT_QUERY_S3_SECRET_ACCESS_KEY TT_QUERY_SERVICE_SECRET; do
      value=$(sed -n "s/^[[:space:]]*$name=//p" "$file" | tail -n1)
      value=${value%\"}; value=${value#\"}
      value=${value%\'}; value=${value#\'}
      test -n "$value" || { echo "check-service-env.sh: required query setting is absent: $name" >&2; exit 1; }
    done
    ;;
  live-storage)
    for name in TT_LIVE_STORAGE_SERVICE_SECRET; do
      value=$(sed -n "s/^[[:space:]]*$name=//p" "$file" | tail -n1)
      value=${value%\"}; value=${value#\"}
      value=${value%\'}; value=${value#\'}
      test -n "$value" || { echo "check-service-env.sh: required live-storage setting is absent: $name" >&2; exit 1; }
    done
    ;;
  dxfeed)
    for name in TT_DXFEED_TOKEN_BROKER_URL; do
      value=$(sed -n "s/^[[:space:]]*$name=//p" "$file" | tail -n1)
      value=${value%\"}; value=${value#\"}
      value=${value%\'}; value=${value#\'}
      test -n "$value" || { echo "check-service-env.sh: required dxfeed setting is absent: $name" >&2; exit 1; }
    done
    ;;
  *)
    echo "check-service-env.sh: unknown profile: $profile" >&2
    exit 2
    ;;
esac
