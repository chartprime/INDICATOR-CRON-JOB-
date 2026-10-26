#!/usr/bin/env bash
# G4: Codex implements a self-contained task in a throwaway worktree. Usage: codex-implement.sh <task.md> <branch-name>
source "$(dirname "$0")/common.sh"
TASK=$1; BRANCH=$2; codex_preflight >/dev/null
WT=/home/user/Terminal-L1-L2/worktrees/$BRANCH
mkdir -p "$(dirname "$WT")"
( cd "$REPO" && git worktree add -q -b "$BRANCH" "$WT" main )
ln -sfn "$REPO/node_modules" "$WT/node_modules"; ln -sfn "$REPO/apps/web/node_modules" "$WT/apps/web/node_modules"
P=$(mktemp)
{
  echo "Work only inside the current directory, a git worktree on branch $BRANCH of a React/TypeScript trading terminal. Node 24.21.0 is on PATH. Run tests with: cd apps/web && npx vitest run <path>. Commit your work on this branch with git -c user.name=Codex -c user.email=codex@chartprime.local commit. Do not push. Do not touch files outside the task."
  echo; echo "----- TASK -----"; cat "$TASK"
} > "$P"
run_codex "implement-$BRANCH" workspace-write "$WT" "$P"
