#!/usr/bin/env bash
# Shared setup for the Codex gate scripts. Source this file.
set -euo pipefail
export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
REPO=/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk
LOG_DIR=/home/user/Terminal-L1-L2/PM/log/codex
mkdir -p "$LOG_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
codex_preflight() {
  command -v codex >/dev/null || { echo "codex CLI not installed (npm install -g @openai/codex)"; return 1; }
  if [ -z "${OPENAI_API_KEY:-}" ] && ! codex login status 2>&1 | grep -qiE "logged in|API key configured"; then
    echo "no Codex credential: set OPENAI_API_KEY as an environment network secret and start a new session"; return 1
  fi
  if [ -n "${OPENAI_API_KEY:-}" ] && ! codex login status 2>&1 | grep -qiE "logged in|API key configured"; then
    printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null
  fi
  echo ok
}
# run_codex <label> <sandbox> <cwd> <prompt-file>  -> writes transcript and last message under LOG_DIR
run_codex() {
  local label=$1 sandbox=$2 cwd=$3 prompt_file=$4
  local out="$LOG_DIR/${STAMP}-${label}.last.md" transcript="$LOG_DIR/${STAMP}-${label}.transcript.txt"
  ( cd "$cwd" && codex exec -s "$sandbox" -c 'approval_policy="never"' -o "$out" "$(cat "$prompt_file")" < /dev/null ) 2>&1 | tee "$transcript"
  echo "--- last message saved to $out"
  grep -o "VERDICT: [A-Z]*" "$out" | tail -1 || echo "VERDICT: NONE"
}
