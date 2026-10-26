#!/usr/bin/env bash
# G1: Codex reviews a build brief. Usage: codex-review-plan.sh <brief.md>
source "$(dirname "$0")/common.sh"
BRIEF=$1; codex_preflight >/dev/null
P=$(mktemp)
{
  echo "You are the independent plan reviewer for a trading-indicator team. Review this build brief for an indicator in the repository you are running in (a React/TypeScript chart terminal with an indicator SDK; read apps/web/src/lib/chart/indicatorTypes.ts and docs/architecture/indicators/data-for-indicator-authors.md for the contract and rules)."
  echo; echo "Judge: 1) Does it answer one specific trading question a retail trader has? 2) Is the calculation fully specified, incremental (one bar at a time, forming bar revised in place), and free of future data? 3) Is every data input actually available per the brief's data section, with honest behavior when it is missing? 4) Will a trader understand the default view in seconds with at most three primary controls? 5) Is the success criterion testable and the baseline fair? 6) What is the simplest alternative that would do most of the job?"
  echo; echo "Be specific and actionable. End with exactly VERDICT: APPROVED or VERDICT: REVISE."
  echo; echo "----- BUILD BRIEF -----"; cat "$BRIEF"
} > "$P"
run_codex "plan-$(basename "$BRIEF" .md)" read-only "$REPO" "$P"
