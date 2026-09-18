#!/usr/bin/env bash
#
# morning.sh — run the podcast pipeline HERE and publish the result.
#
# WHY THIS EXISTS. YouTube refuses caption access to datacentre IPs: InnerTube
# answers a GitHub Actions runner with "Sign in to confirm you're not a bot",
# and the mobile clients with a device-attestation failure. Installing yt-dlp in
# CI moved that from 0 processed to 1 of 8 — an improvement and not a fix,
# because the block is the IP, not the tool. From a home connection none of it
# applies: the same pipeline, unchanged, reads every one of those episodes.
#
# So the morning job runs on this machine and pushes the result. The GitHub
# Action stays on as well — it reads the RSS shows, which are not blocked, and
# keeps the page fresh when this machine is off.
#
# THIS IS THE ONLY ENTRY POINT. There used to be two scripts: this one, which
# the docs pointed at, and run-local.sh, which was the one actually hardened for
# launchd. They drifted, and the documented plist invoked the weaker of the two
# — which does not source .env, so a scheduled run silently fell back to the
# free extractor and published thinner points with no error anywhere. Two
# scripts for one job is how that happens. run-local.sh now delegates here.
#
#   ./scripts/morning.sh              read new episodes, commit and push
#   ./scripts/morning.sh --dry-run    read them, write nothing
#
# THE COST, STATED PLAINLY: this only runs while the Mac is awake. A laptop shut
# on Friday writes nothing on Saturday. That is a real downgrade from a cloud
# cron and it is the trade being made — a feed that updates most days beats one
# that provably cannot update at all.
#
# SECRETS COME FROM .env AND NEVER FROM THIS FILE or the plist beside it.
set -euo pipefail
cd "$(dirname "$0")/.."

# launchd hands a process almost no PATH. node lives under Homebrew, git under
# /usr/bin, and without this the job dies on "node: command not found" in a log
# nobody is watching. Harmless when run from a real shell.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log()  { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '%s !! %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

command -v node >/dev/null || { warn "node is not installed — https://nodejs.org"; exit 1; }
command -v git  >/dev/null || { warn "git is not installed"; exit 1; }

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

# ── THE KEY ─────────────────────────────────────────────────────────────────
# launchd does not inherit your shell environment, so a key exported in
# .zshrc is not here. .env is the only place this reads from.
if [ -f .env ]; then
  set -a; . ./.env; set +a
  log "loaded .env"
fi

# config.mjs resolves extractor=ai ONLY if a key is present, and falls back to
# the free extractive path otherwise — with no error. That fallback is a
# legitimate mode (the pipeline is designed to run free) but it is NOT something
# that should happen by accident at 06:45 and be discovered a week later on the
# page. Name the mode every run, and say plainly when it is not the one the last
# run used.
EXTRACTOR_NOW="${EXTRACTOR:-}"
if [ -z "$EXTRACTOR_NOW" ]; then
  if [ -n "${GROQ_API_KEY:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then EXTRACTOR_NOW=ai; else EXTRACTOR_NOW=local; fi
fi
EXTRACTOR_LAST=$(node -p "(require('./public/podcasts.json').generator||{}).extractor||''" 2>/dev/null || echo "")
log "extractor=$EXTRACTOR_NOW (last published run used '${EXTRACTOR_LAST:-unknown}')"
if [ "$EXTRACTOR_NOW" = "local" ] && [ "$EXTRACTOR_LAST" = "ai" ]; then
  warn "DEGRADED: the last run interpreted points with a model, this one will not."
  warn "No GROQ_API_KEY in .env. Add it, or set EXTRACTOR=local to make this deliberate."
fi

# ── SYNC ────────────────────────────────────────────────────────────────────
# The two files this job writes are OUTPUTS. A local copy of either is worth
# nothing next to origin's — CI may have written a newer one — and rebasing them
# produces a conflict every single time, so they are discarded before the sync
# rather than merged through it.
# This job rebases onto origin/main and pushes HEAD:main. Doing that from some
# other branch would replay that branch's commits onto main and push them — so
# it stops instead. It does NOT `git checkout main`: this runs unattended on a
# repo its owner edits by hand, and silently moving someone off their working
# branch at 06:45 is the same class of mistake as `reset --hard`.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  warn "STOPPING: on branch '$BRANCH', not main. This job only publishes from main."
  warn "Switch to main and re-run, or leave it — nothing has been changed."
  exit 1
fi

log "syncing with origin"
git fetch --quiet origin
git checkout --quiet -- public/podcasts.json pipeline/state.json 2>/dev/null || true

# ── NEVER reset --hard. THIS ALREADY COST A FIX. ────────────────────────────
# An earlier version fell back to `git reset --hard origin/main` when a rebase
# would not apply. It ran at 23:38 and destroyed an uncommitted edit to
# pipeline/lib/transcript.mjs written five minutes earlier — the run then
# reported the exact bug that edit had fixed. This is a SCHEDULED job on a repo
# its owner edits by hand; a background task that can delete work in progress
# while nobody is watching is not worth any amount of convenience. The recovery
# is narrow: the two generated files, and nothing else, ever.
if ! git rebase --quiet origin/main 2>/dev/null; then
  git rebase --abort 2>/dev/null || true
  if [ -n "$(git status --porcelain --untracked-files=no | grep -v -E 'public/podcasts.json|pipeline/state.json' || true)" ]; then
    warn "STOPPING: local changes to tracked files this job does not own —"
    git status --short --untracked-files=no | sed 's/^/    /' >&2
    warn "commit or stash them; this job will not touch them."
    exit 1
  fi
  log "only generated files differ — taking origin's copies"
  git checkout --quiet origin/main -- public/podcasts.json pipeline/state.json
  git rebase --quiet origin/main || { warn "FATAL: cannot sync"; exit 1; }
fi
log "at $(git rev-parse --short HEAD)"

# ── READ ────────────────────────────────────────────────────────────────────
log "reading podcasts"
node pipeline/run.mjs "$@"

if [ "$DRY" = "1" ]; then log "dry run — nothing written."; exit 0; fi

read -r PROC FAIL ELIG COUNT POINTS <<<"$(node -p '
  const d = require("./public/podcasts.json"), r = d.run || {}, e = d.episodes || [];
  [r.processed|0, r.failed|0, r.eligible|0, e.length,
   e.reduce((n,x)=>n+((x.learnings||[]).length),0)].join(" ")
')"
log "run: eligible=$ELIG processed=$PROC failed=$FAIL — serving $COUNT episode(s), $POINTS points"

if git diff --quiet -- public/podcasts.json pipeline/state.json; then
  log "nothing changed — no commit."
else
  # A run that reads NOTHING still rewrites the artifact (generatedAt and the
  # pending list move), so it still commits. Saying "morning refresh — 11
  # episodes" on such a run is how seven consecutive dead mornings looked like
  # seven good ones in the log. The subject states what the run actually did.
  if [ "$PROC" -eq 0 ]; then
    MSG="podcasts: read nothing — ${FAIL} failed, still serving ${COUNT} episode(s)"
  else
    MSG="podcasts: morning refresh — +${PROC} read, ${COUNT} episode(s), ${POINTS} points"
  fi
  # WHO RAN THIS MATTERS. run-local.sh used to commit under a personal identity and
  # CI under "podcast-intelligence", so `git log` told you which machine produced a
  # run. Folding the two scripts together lost that, and the first question asked of
  # a bad morning — did the Mac job fire, or was that CI failing again? — became
  # unanswerable from the history. The author now names the machine.
  log "committing: $MSG"
  git add public/podcasts.json pipeline/state.json
  git -c user.name="podcast-intelligence (${PODCAST_RUNNER:-$(hostname -s 2>/dev/null || echo local)})" \
      -c user.email="noreply@askakshay.com" commit -q -m "$MSG"

  # Retry: a laptop waking on wifi often has no route for the first few seconds,
  # and CI can land a commit during the run, which is minutes long.
  PUSHED=0
  for i in 1 2 3 4; do
    if git push -q origin HEAD:main 2>/dev/null; then PUSHED=1; break; fi
    warn "push failed, retrying in $((2 ** i))s"; sleep $((2 ** i))
    git fetch --quiet origin && git rebase --quiet origin/main || git rebase --abort 2>/dev/null || true
  done
  if [ "$PUSHED" = "1" ]; then
    log "pushed — the deploy workflow ships it to career.askakshay.com in ~90s."
  else
    warn "could not push after 4 attempts. The commit is local — run 'git push' when back online."
    exit 1
  fi
fi

# ── THE POINT OF THE WHOLE JOB ──────────────────────────────────────────────
# Eligible episodes and none read is the failure this script exists to prevent.
# Exit non-zero so launchd records it and `tail podcasts.err` shows it, instead
# of a green run that published a week-old cache.
if [ "$ELIG" -gt 0 ] && [ "$PROC" -eq 0 ]; then
  warn "READ NOTHING: $ELIG eligible, all $FAIL failed at the transcript stage."
  warn "If this machine is on a home connection, check 'npm run podcasts:verify'."
  exit 2
fi
log "done."
