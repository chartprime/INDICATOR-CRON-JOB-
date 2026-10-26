#!/usr/bin/env bash
# G3: Codex challenges an indicator's claims. Usage: codex-challenge.sh <branch> <claims.md>
source "$(dirname "$0")/common.sh"
BRANCH=$1; CLAIMS=$2; codex_preflight >/dev/null
FILES=$(cd "$REPO" && git diff --name-only main..."$BRANCH" | tr '\n' ' ')
P=$(mktemp)
{
  echo "You are the adversarial validator for a trading-indicator team. An indicator on branch $BRANCH of this repository makes the claims below. Inspect the code (git diff main...$BRANCH -- $FILES) and its tests, then try to break each claim."
  echo; echo "Look for: future-data leakage; signals that look good only in hindsight; behavior across data gaps, reconnects and duplicate or late events; forming-bar revisions producing duplicate markers or drifting state; excessive alert or marker counts on busy instruments; unbounded memory over 10,080 bars; per-bar cost on a pair with 50 bar updates per second; equity bars with unsided volume; claims the tests do not actually pin."
  echo; echo "Output a numbered challenge list. For each: the claim attacked, the concrete scenario or input, the expected wrong behavior, and the test or measurement that would settle it. Mark each as CONFIRMED (you verified it in the code), LIKELY, or SPECULATIVE. End with exactly VERDICT: PASS or VERDICT: FAIL."
  echo; echo "----- CLAIMS -----"; cat "$CLAIMS"
} > "$P"
run_codex "challenge-${BRANCH//\//-}" read-only "$REPO" "$P"
