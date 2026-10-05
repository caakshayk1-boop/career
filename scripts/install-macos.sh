#!/usr/bin/env bash
#
# install-macos.sh — schedule the morning job on this Mac, in one command.
#
#   ./scripts/install-macos.sh                 preflight, install, start
#   ./scripts/install-macos.sh --print-plist   write nothing, just show the plist
#   ./scripts/install-macos.sh --uninstall     stop and remove the agent
#
# WHY THIS EXISTS RATHER THAN A CODE BLOCK IN A README. The plist used to live
# only in SCHEDULING.md, with /Users/YOU/path/to/career to edit by hand — and it
# pointed at the wrong script for weeks without anybody noticing, because a
# snippet nobody executes cannot fail. This derives every path from its own
# location, validates the result, and refuses to install a job that would not
# have worked. Same reason morning.sh and run-local.sh got merged: one source of
# truth, and it is the one that runs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.askakshay.podcasts"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

emit_plist() {
cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <!-- morning.sh exports its own PATH and sources .env, so it needs no login
       shell. Calling it directly means the job does not depend on whatever
       ~/.zprofile happens to contain that week. -->
  <key>ProgramArguments</key>
  <array><string>$REPO/scripts/morning.sh</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>

  <!-- 06:45, not 06:30. The GitHub Action fires at 22:30 UTC, which IS 06:30
       MYT — both jobs at the same minute race for the same push. -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>45</integer></dict>

  <!-- Catch-up for a Mac that was OFF at 06:45. StartCalendarInterval fires on
       the next wake after SLEEP, but not at all after a shutdown. The pipeline
       is idempotent, so a duplicate run does nothing. -->
  <key>RunAtLoad</key><true/>

  <!-- NOT /tmp: macOS purges it, and the morning you want the log is the
       morning after it was deleted. -->
  <key>StandardOutPath</key><string>$LOGDIR/podcasts.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/podcasts.err</string>
</dict>
</plist>
XML
}

if [ "${1:-}" = "--print-plist" ]; then emit_plist; exit 0; fi

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  say "Removed $LABEL. The repo and its scripts are untouched."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || die "This installer is macOS-only. Linux: see the systemd timer in scripts/SCHEDULING.md"

# ── PREFLIGHT ───────────────────────────────────────────────────────────────
# Installing a job that was never run once is how you find out a week later.
say "Preflight"

[ -f "$REPO/.env" ] || die "No $REPO/.env — copy .env.example and put your GROQ_API_KEY in it.
Without it the job runs, succeeds, and silently publishes thinner points."

command -v node >/dev/null || die "node is not installed — https://nodejs.org"
info "node $(node -v)"

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout"
BRANCH=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "The checkout is on '$BRANCH'. morning.sh only publishes from main — switch first."

# ── ONE SCHEDULER, OR NONE OF THIS MEANS ANYTHING ───────────────────────────
# A second agent pointing at this repo ran for two days beside the documented
# one: com.askakshay.career.podcasts at 07:15, invoking the run-local.sh alias,
# installed before the two scripts were merged. Two jobs on one checkout is not
# a tidiness problem. They read the same sources from the same IP at the same
# time, which is what YouTube answers with HTTP 429, and they race to commit the
# same two generated files, which is what left an unpushed commit behind.
#
# Same failure as two scripts for one job, one level up. Name any other agent
# that runs this repo and stop, rather than quietly becoming the second one.
OTHERS=$(grep -lF "$REPO/scripts/" "$HOME/Library/LaunchAgents"/*.plist 2>/dev/null \
  | grep -v "^$PLIST$" || true)
if [ -n "$OTHERS" ]; then
  printf '%s\n' "$OTHERS" | while read -r f; do
    warn_label=$(basename "$f" .plist)
    echo "    $warn_label  ->  $f" >&2
  done
  die "Another LaunchAgent already runs this repo (listed above).
Two schedulers on one checkout race for the same files and share one IP's rate
limit. Remove the one you do not want, then re-run:
  launchctl bootout gui/\$(id -u)/<label>
  rm ~/Library/LaunchAgents/<label>.plist"
fi
info "on main"

# The one that actually matters: does the scheduled environment resolve to the
# same extractor the last published run used? This is the check whose absence
# meant the documented plist would have downgraded the feed in silence.
say "Checking the extractor the scheduled job will get"
PRE=$("$REPO/scripts/morning.sh" --dry-run 2>&1 | grep -m1 'extractor=' || true)
[ -n "$PRE" ] || die "morning.sh --dry-run produced no extractor line. Run it by hand and read the error."
info "$PRE"
case "$PRE" in
  *"extractor=ai"*) : ;;
  *) die "The job would run on the free extractive path.
Your .env is not being read, or holds no GROQ_API_KEY. Fix that before scheduling —
set EXTRACTOR=local in .env if you genuinely want the free path." ;;
esac

# ── INSTALL ─────────────────────────────────────────────────────────────────
say "Installing the LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

if [ -f "$PLIST" ]; then
  BAK="$PLIST.bak.$(date +%Y%m%d%H%M%S)"
  cp "$PLIST" "$BAK"
  info "existing plist backed up to $(basename "$BAK")"
fi

emit_plist > "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "Generated an invalid plist — this is a bug, nothing was loaded."
info "wrote $PLIST"

# bootout first: launchd caches the loaded copy, so editing a plist without
# unloading keeps the OLD one running. `load` is deprecated on Big Sur+.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
info "bootstrapped into $DOMAIN"

# ── THE SCHEDULED WAKE ─────────────────────────────────────────────────────
#
# 06:45 WAS NEVER ONCE HIT. Measured across the commits this job pushed:
# 07:06, 07:07, 07:10, 08:45, 09:01, and once 16:18. StartCalendarInterval
# does not fire at its minute on a sleeping Mac — it fires on the next WAKE,
# so every one of those timestamps is the lid being opened, and the 16:18 is a
# day the Mac was shut down and only RunAtLoad saved the run.
#
# That matters more than it looks, because this Mac is the ONLY machine that
# can read YouTube: the scheduled CI run republishes without fetching, since
# YouTube refuses caption access to datacentre addresses. A morning the lid
# stays shut is a morning with no new episodes anywhere.
#
# pmset makes the Mac wake itself at 06:40, five minutes before the job. It
# needs sudo, so it is OFFERED rather than done — an installer that silently
# demands a password is an installer people stop running.
#
# `wakeorpoweron` wakes from sleep AND powers on from a full shutdown, which is
# the case RunAtLoad could not cover.
WAKE_CMD='sudo pmset repeat wakeorpoweron MTWRFSU 06:40:00'
if pmset -g sched 2>/dev/null | grep -q "wakeorpoweron.*06:40"; then
  info "scheduled wake at 06:40 already set"
elif [ -t 0 ]; then
  say "Set a 06:40 wake so 06:45 actually fires?"
  printf '  %s\n  [y/N] ' "$WAKE_CMD"
  read -r ans
  case "$ans" in
    [yY]*) $WAKE_CMD && info "wake scheduled — check it with: pmset -g sched" ;;
    *)     info "skipped. Without it the job runs when you next open the lid, not at 06:45." ;;
  esac
else
  info "non-interactive: skipping the wake. To set it later, run:"
  printf '  %s\n' "$WAKE_CMD"
fi

say "Running it once now"
launchctl kickstart -p "$DOMAIN/$LABEL"

cat <<DONE

Installed. It runs at 06:45 daily, and once at login if the Mac was off.

THIS MAC IS THE ONLY MACHINE THAT CAN READ. The scheduled GitHub run rebuilds
the page without fetching, because YouTube refuses caption access to datacentre
addresses. If this job does not run, no new episodes appear anywhere.

  pmset -g sched                   is the 06:40 wake set?
  sudo pmset repeat wakeorpoweron MTWRFSU 06:40:00    set it

  tail -f $LOGDIR/podcasts.log     what it read
  tail -20 $LOGDIR/podcasts.err    DEGRADED warnings and exit 2
  launchctl print $DOMAIN/$LABEL   is it loaded, and what did it last exit with
  ./scripts/install-macos.sh --uninstall

The line to look for is:
  run: eligible=8 processed=6 failed=2 — serving 14 episode(s), 231 points

processed=0 with a non-zero eligible means it read nothing. The job exits 2 on
that, and the page says so above the feed.
DONE
