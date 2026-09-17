#!/usr/bin/env bash
#
# run-local.sh — kept as an alias. The job lives in morning.sh now.
#
# There were two scripts for one job: morning.sh, which README.md and
# SCHEDULING.md pointed at, and this one, which was the only one actually
# hardened for launchd — it exported a PATH, sourced .env for GROQ_API_KEY, and
# refused to reset --hard over uncommitted work. The documented plist invoked
# the other one, so a scheduled run got no API key, fell back to the free
# extractor and published thinner points with nothing reporting it.
#
# Two scripts for one job is how a fix lands in the copy nobody runs. The
# hardening moved into morning.sh; this name still works so an existing plist,
# cron entry or muscle memory does not break.
exec "$(dirname "$0")/morning.sh" "$@"
