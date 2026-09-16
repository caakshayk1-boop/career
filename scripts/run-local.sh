#!/bin/bash
# run-local.sh — the podcast pipeline, from this Mac rather than from CI.
#
# WHY THIS EXISTS. Measured on 2026-09-16 in GitHub Actions:
#
#     discovered 904   eligible 12   processed 0   failed 12
#     youtube failed: YouTube requires sign-in for caption access from a server
#
# Every new episode died at the transcript stage. YouTube refuses caption
# access to datacenter addresses, so the job ran green, published the same
# eleven cached episodes, and looked alive while nothing new could ever enter
# the feed. Installing yt-dlp in CI moved that from 0 processed to 1 of 8 — an
# improvement and not a fix, because the block is the IP, not the tool.
#
# A home connection is not blocked. So the pipeline runs here, the same way the
# APEX bot does, and CI keeps doing the parts CI is good at: deploying, and
# checking what this produced.
#
# THE COST, STATED PLAINLY: this only runs while the Mac is awake. A laptop
# that was shut on Friday writes nothing on Saturday. That is a real downgrade
# from a cloud cron and it is the trade being made — a feed that updates most
# days beats one that provably cannot update at all.
#
# SECRETS COME FROM .env AND NEVER FROM THIS FILE or the plist beside it.
set -euo pipefail

REPO="/Users/akshaykumarkothari/Workspace/Apps/Websites/career"
cd "$REPO"

# launchd hands a process almost no PATH. node lives under Homebrew, git under
# /usr/bin, and without this the job fails on "node: command not found" in a
# log nobody is watching.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

if [ ! -f .env ]; then
  log "FATAL: no .env — GROQ_API_KEY is required and is never stored in this script"
  exit 1
fi
set -a; . ./.env; set +a

log "=== podcast pipeline, local run ==="

# ── DO NOT FIGHT CI ─────────────────────────────────────────────────────────
# The deploy workflow commits to this same branch, so a local run must expect
# to start from a stale tree.
#
# The two files this job writes are OUTPUTS. A local copy of either is worth
# nothing next to what is on origin — CI may have written a newer one — and
# trying to rebase them produces a conflict every single time. So they are
# discarded before the sync rather than merged through it.
#
# The first version rebased first and aborted on conflict, which left the
# branch BEHIND origin. The run then spent seven minutes of model calls and
# died at the push with "non-fast-forward", after the work was done.
log "syncing with origin"
git fetch --quiet origin
git checkout --quiet -- public/podcasts.json pipeline/state.json 2>/dev/null || true
# ── NEVER reset --hard. THIS ALREADY COST ME A FIX. ─────────────────────────
#
# The first version fell back to `git reset --hard origin/main` when a rebase
# would not apply. It ran at 23:38 and silently destroyed an uncommitted edit
# to pipeline/lib/transcript.mjs written five minutes earlier — the run then
# reported the exact bug that edit had fixed, and it took a second diagnosis to
# work out why.
#
# This is a SCHEDULED job on a repo its owner edits by hand. A background task
# that can delete work in progress at 07:15 while nobody is watching is not
# worth any amount of convenience. So the recovery is narrow: the two
# generated files, and nothing else, ever.
if ! git rebase --quiet origin/main 2>/dev/null; then
  git rebase --abort 2>/dev/null || true
  if [ -n "$(git status --porcelain --untracked-files=no | grep -v -E 'public/podcasts.json|pipeline/state.json' || true)" ]; then
    log "STOPPING: local changes to tracked files this job does not own —"
    git status --short --untracked-files=no | sed 's/^/    /'
    log "commit or stash them; this job will not touch them."
    exit 1
  fi
  log "only generated files differ — taking origin's copies"
  git checkout --quiet origin/main -- public/podcasts.json pipeline/state.json
  git rebase --quiet origin/main || { log "FATAL: cannot sync"; exit 1; }
fi
log "at $(git rev-parse --short HEAD), $(git rev-list --count HEAD ^origin/main 2>/dev/null || echo 0) ahead"

log "running the pipeline"
node pipeline/run.mjs

if git diff --quiet -- public/podcasts.json pipeline/state.json; then
  log "nothing changed — no new episode cleared the bar today"
  exit 0
fi

# What actually changed, in the log, so a quiet morning is distinguishable from
# a broken one without opening the JSON.
node -e '
  const d = require("./public/podcasts.json");
  const eps = d.episodes || [];
  const by = eps.reduce((a, e) => (a[e.extractor] = (a[e.extractor] || 0) + 1, a), {});
  console.log(`  ${eps.length} episodes published — ` +
    Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", "));
'

log "committing"
git add public/podcasts.json pipeline/state.json
git -c user.name="Akshay Kumar Kothari" -c user.email="ca.akshayk1@gmail.com" \
    commit -q -m "data: podcasts, local run $(date '+%Y-%m-%d %H:%M') [skip ci]"

# CI can land a commit between the sync above and here — the window is the
# whole pipeline run, which is seven minutes. A rejected push after paying for
# the work is the worst possible ending, so it retries onto whatever arrived.
log "pushing"
if ! git push --quiet origin main 2>/dev/null; then
  log "push rejected — rebasing onto what landed and retrying"
  git fetch --quiet origin
  if git rebase --quiet origin/main 2>/dev/null; then
    git push --quiet origin main
  else
    git rebase --abort 2>/dev/null || true
    log "FATAL: could not replay onto origin/main — the run's output is still in the worktree"
    exit 1
  fi
fi

# The push carries [skip ci], so nothing redeploys on its own. Deploy from
# here, which is also the only way the change reaches readers today.
log "deploying"
npx --yes wrangler deploy 2>&1 | tail -3

log "=== done ==="
