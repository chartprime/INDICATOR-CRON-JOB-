#!/usr/bin/env bash
set -euo pipefail
node=${TT_NODE_EXECUTABLE:-/opt/terminal-l1-l2/node-v24.21.0-linux-x64/bin/node}
script_dir=$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
exec "$node" "$script_dir/developer-access.cjs" "$@"
