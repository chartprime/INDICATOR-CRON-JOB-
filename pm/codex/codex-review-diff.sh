#!/usr/bin/env bash
# G2: Codex reviews a specialist branch against a base (default main). Usage: codex-review-diff.sh <branch> [brief.md] [base]
# Run it BEFORE merging the branch: after a merge the diff against main is empty.
source "$(dirname "$0")/common.sh"
BRANCH=$1; BRIEF=${2:-}; BASE=${3:-main}; codex_preflight >/dev/null
FILES=$(cd "$REPO" && git diff --name-only "$BASE"..."$BRANCH" | tr '\n' ' ')
[ -z "$FILES" ] && { echo "empty diff between $BASE and $BRANCH; nothing to review"; exit 2; }
P=$(mktemp)
{
  echo "You are the independent code reviewer for a trading-indicator team. Review branch $BRANCH against $BASE in this repository. Run: git diff $BASE...$BRANCH -- $FILES"
  echo; echo "Focus, in order: 1) correctness of the math versus the brief; 2) future-data leakage (a bar may use only data timestamped at or before its close) and replay-versus-live consistency; 3) honest handling of missing data: null, never zero or NaN, gates on tradeAvailability, ticks.coverageOf, l2.trusted(); 4) buy/sell read through barSides, never volume minus buy_volume; 5) incremental state, bounded memory, no per-bar copying of large arrays, no stream or draw factories created inside onBar; 6) settings schema covers every default key with step > 0; 7) tests actually pin the behavior (hand-computed values, replace semantics, empty input, gates); 8) readability and house style."
  echo; echo "For each finding give file, line range, severity CRITICAL / WARNING / SUGGESTION, the problem, and the fix. End with exactly VERDICT: APPROVED or VERDICT: REVISE."
  if [ -n "$BRIEF" ]; then echo; echo "----- BUILD BRIEF -----"; cat "$BRIEF"; fi
} > "$P"
run_codex "code-${BRANCH//\//-}" read-only "$REPO" "$P"
