#!/usr/bin/env bash
#
# morning.sh — run the podcast pipeline HERE and publish the result.
#
# WHY THIS EXISTS. YouTube refuses caption access to datacentre IPs: InnerTube
# answers a GitHub Actions runner with "Sign in to confirm you're not a bot",
# and the mobile clients with a device-attestation failure. Four routes were
# tried and all four are closed. From a home connection none of that applies —
# the same pipeline, unchanged, reads every one of those episodes.
#
# So the morning job runs on this machine and pushes the result. The GitHub
# Action stays on as well: it handles the RSS shows that publish transcripts and
# keeps working when this machine is off.
#
#   ./scripts/morning.sh              read new episodes and push
#   ./scripts/morning.sh --dry-run    read them, write nothing
#
set -euo pipefail
cd "$(dirname "$0")/.."

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v node >/dev/null || { echo "node is not installed — https://nodejs.org"; exit 1; }
command -v git  >/dev/null || { echo "git is not installed"; exit 1; }

# A stale checkout would push points computed against an old scorer, and the
# push would then conflict with whatever the Action committed overnight.
log "Syncing with main"
git checkout -q main
git pull -q --rebase origin main

log "Reading podcasts"
node pipeline/run.mjs "$@"

if [[ " $* " == *" --dry-run "* ]]; then
  log "Dry run — nothing written."
  exit 0
fi

if git diff --quiet -- public/podcasts.json pipeline/state.json; then
  log "Nothing new. No commit."
  exit 0
fi

COUNT=$(node -p "require('./public/podcasts.json').episodes.length")
POINTS=$(node -p "require('./public/podcasts.json').episodes.reduce((n,e)=>n+e.learnings.length,0)")

log "Publishing ${COUNT} episode(s), ${POINTS} points"
git add public/podcasts.json pipeline/state.json
git -c user.name="podcast-intelligence" -c user.email="noreply@askakshay.com" \
    commit -q -m "podcasts: morning refresh — ${COUNT} episode(s), ${POINTS} points"

# Retry: a laptop waking on wifi often has no route for the first few seconds.
for i in 1 2 3 4; do
  if git push -q; then
    log "Pushed. The deploy workflow ships it to career.askakshay.com in ~90s."
    exit 0
  fi
  echo "push failed, retrying in $((2 ** i))s"; sleep $((2 ** i))
  git pull -q --rebase origin main || true
done
echo "Could not push after 4 attempts. The commit is local — run 'git push' when back online."
exit 1
