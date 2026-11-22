#!/usr/bin/env bash
# Session start: remind Claude of the standing rules (branch + PR) and flag a stale checkout.
HOOKDIR="$(cd "$(dirname "$0")" && pwd)"
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" 2>/dev/null || exit 0
git fetch -q origin main 2>/dev/null
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
cat "$HOOKDIR/rules-session.txt" 2>/dev/null  # generated from process/rules.json (npm run rules:build)
if [ "$branch" = "main" ]; then
  echo "NOTE: you are on main. Do not commit here: create a topic branch first: git fetch origin main && git checkout -B <topic> origin/main"
elif [ "$behind" != "0" ]; then
  echo "NOTE: this branch is $behind commit(s) behind origin/main. If it holds no work yet, restart it: git fetch origin main && git checkout -B <topic> origin/main; otherwise rebase onto origin/main before opening the PR."
fi
# CI status: tell the session if main is red and who is probably responsible (issue #2, kept by scripts/ci-status.mjs). Best effort.
ci=$(timeout 15 gh api repos/esheliko/overcut/issues/2 --jq .body 2>/dev/null)
if printf '%s' "$ci" | grep -q '\*\*fail\*\*'; then
  echo "CI IS RED ON MAIN (issue #2). If your session id or your change is listed below, fix it FIRST (CLAUDE.md rule 7). Never skip or delete a failing test."
  printf '%s\n' "$ci" | sed -n '/CI `verify`/,/Everyone who pushed/p' | head -30
fi
# Stack-specific checks (environment variables, toolchain), if the template ships .claude/hooks/stack-start.sh.
[ -f "$HOOKDIR/stack-start.sh" ] && . "$HOOKDIR/stack-start.sh"
exit 0
