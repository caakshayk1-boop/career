# Running the morning job on your own machine

**Why:** YouTube refuses caption access to datacentre IPs. InnerTube answers a
GitHub Actions runner with *"Sign in to confirm you're not a bot"*, and the
mobile clients with a device-attestation failure. Installing yt-dlp in CI moved
that from 0 processed to 1 of 8 — an improvement and not a fix, because the
block is the IP, not the tool.

From a home connection none of that applies. **The same pipeline, unchanged,
reads every one of those episodes.** Only the runner is refused.

The GitHub Action stays on as well. It reads the RSS shows, which are not
blocked, and keeps the page fresh when this machine is off, so the two are
complements rather than alternatives.

**Measured, 11–17 Sep 2026.** Seven scheduled CI runs processed **one** episode
between them; every other eligible episode failed at the transcript stage.
Everything on the page in that week came from manual runs on this Mac. If this
job is not scheduled, the feed does not update — that is the whole point of
this file.

## One entry point

`scripts/morning.sh` is the job. `run-local.sh` is an alias that execs it and
exists only so an older plist keeps working. There used to be two real scripts
and the documented plist invoked the weaker one — it never sourced `.env`, so
scheduled runs silently dropped to the free extractor.

```bash
./scripts/morning.sh --dry-run   # read everything, write nothing
./scripts/morning.sh             # read, commit, push — the site updates in ~90s
```

Exit codes matter here, because launchd is the only thing watching:

| Code | Meaning |
|------|---------|
| `0`  | Read something, or there was genuinely nothing new |
| `1`  | Could not run: wrong branch, uncommitted work in the way, push failed |
| `2`  | **Episodes were eligible and none could be read** — the failure this job exists to prevent |

## Before you schedule it: prove it works by hand

Scheduling a job that was never run once is how you find out a week later. In
order:

```bash
cd /path/to/career
printf 'GROQ_API_KEY=gsk_...\n' > .env   # .gitignore covers .env — never commit it
./scripts/morning.sh --dry-run
```

The dry run must print `extractor=ai`. If it prints `extractor=local` the key
is not being read, and a scheduled run would publish thinner points with no
error anywhere. Fix that before going further, then:

```bash
./scripts/morning.sh ; echo "exit=$?"
```

`exit=0` and a new commit means the whole path works. `exit=2` means this
machine cannot read the transcripts either — check `npm run podcasts:verify`
before blaming the schedule.

## Every morning, macOS

`launchd` rather than `cron`: cron skips a job scheduled while the machine was
asleep. `StartCalendarInterval` runs it on the next wake instead, coalescing
missed intervals into one.

**What launchd does not do:** it will not wake the machine, and a Mac that was
powered off — not asleep — at the scheduled time does not run the job on next
boot. `RunAtLoad` below is the catch-up for that case: the agent loads at login,
the job runs then, and the pipeline is idempotent, so a duplicate run does
nothing.

### One command

```bash
./scripts/install-macos.sh
```

It refuses to install a job that would not have worked: no `.env`, not on
`main`, or a dry run that resolves to the free extractor all stop it before
anything is loaded. Then it writes the plist with this checkout's real paths,
lints it with `plutil`, bootstraps it, and runs it once.

```bash
./scripts/install-macos.sh --print-plist   # show it, write nothing
./scripts/install-macos.sh --uninstall     # stop and remove
```

### Or by hand

The installer generates exactly this — it is here to read, not to copy, because
a snippet nobody executes is a snippet that can point at the wrong script for
weeks without failing. That is what happened to the previous version of this
file. Save as `~/Library/LaunchAgents/com.askakshay.podcasts.plist`, replacing
the path with wherever this repository lives:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.askakshay.podcasts</string>

  <!-- morning.sh exports its own PATH and sources .env, so it does not need a
       login shell. Calling it directly means the job does not depend on
       whatever ~/.zprofile happens to contain. -->
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/path/to/career/scripts/morning.sh</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/path/to/career</string>

  <!-- 06:45, not 06:30. The GitHub Action fires at 22:30 UTC, which IS 06:30
       MYT — scheduling both at the same minute has them racing for the same
       push. Fifteen minutes lets CI finish the RSS shows first. -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>45</integer></dict>

  <!-- Catch-up for a Mac that was OFF at 06:45. Runs once when the agent loads
       at login. Idempotent, so on a day it already ran this does nothing. -->
  <key>RunAtLoad</key><true/>

  <!-- NOT /tmp: macOS purges it, and the one morning you want the log is the
       morning after it was deleted. -->
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/podcasts.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/podcasts.err</string>
</dict>
</plist>
```

`launchctl load` is deprecated on Big Sur and later. Use:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.askakshay.podcasts.plist
launchctl kickstart -p gui/$(id -u)/com.askakshay.podcasts   # run it now
tail -f ~/Library/Logs/podcasts.log
```

To stop: `launchctl bootout gui/$(id -u)/com.askakshay.podcasts`

After editing the plist you must `bootout` and `bootstrap` again — launchd
caches the loaded copy and will otherwise keep running the old one.

**Full Disk Access.** A LaunchAgent that touches a repo under `~/Documents` or
`~/Desktop` needs `/bin/bash` (or your terminal) granted Full Disk Access in
System Settings → Privacy & Security, or the job dies on a permissions error
that looks nothing like one. A repo outside those folders avoids it entirely.

## Every morning, Linux

`cron` skips jobs scheduled while the machine is off, so on a laptop prefer a
systemd timer with `Persistent=true`, which runs the missed job on next boot:

```ini
# ~/.config/systemd/user/podcasts.service
[Service]
Type=oneshot
ExecStart=/home/you/career/scripts/morning.sh
```

```ini
# ~/.config/systemd/user/podcasts.timer
[Timer]
OnCalendar=*-*-* 06:45:00
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now podcasts.timer
journalctl --user -u podcasts.service -n 50
```

On an always-on machine, cron is fine:

```bash
30 6 * * *  /home/you/career/scripts/morning.sh >> ~/podcasts.log 2>&1
```

## Every morning, Windows

Task Scheduler → Create Task → Trigger: daily 06:45, and tick **"Run task as
soon as possible after a scheduled start is missed"** — that is the equivalent
of `RunAtLoad`. Action: `C:\Program Files\Git\bin\bash.exe` with arguments
`-lc "/c/path/to/career/scripts/morning.sh"`.

## What you need

- **Node 22+** and **git** on PATH
- **git push access** — an SSH key or a cached credential. The script does not
  prompt, so a push needing a password fails and leaves the commit local.
- **A `.env` holding `GROQ_API_KEY`** (`cp .env.example .env`), if you want
  the interpretation layer.
  Groq's free tier covers this workload. Without a key the pipeline still runs,
  free, on the extractive path — but it will be quieter points than the page
  currently shows, and `morning.sh` warns when it detects that downgrade.
  `.env` is gitignored; never commit it and never put the key in the plist.

## Rotating the key

`GROQ_API_KEY` lives in exactly two places. **Update both, or neither.**

| Where | How |
|---|---|
| The Mac | `.env` in the repo root — `cp .env.example .env` if it is missing |
| CI | `gh secret set GROQ_API_KEY --repo caakshayk1-boop/career` |

Update one and not the other and that half falls back to the free extractive
path with no error — `config.mjs` resolves a missing key to `extractor: local`
and carries on. Thinner points, published, nothing reporting it.

Both halves now say so when it happens: `morning.sh` prints a `DEGRADED` warning
to stderr, and the `podcasts` workflow raises a `::warning::` with the fix in the
run summary. Neither fails the run, because running free is a legitimate mode —
but it should be a mode you chose, which is what `EXTRACTOR=local` in `.env`
means.

After rotating, prove both:

```bash
./scripts/morning.sh --dry-run            # must print extractor=ai
gh workflow run podcasts --repo caakshayk1-boop/career
gh run watch --repo caakshayk1-boop/career    # no "Extractor downgraded" warning
```

Revoking the old key at <https://console.groq.com/keys> is the last step, not
the first — do it once both halves are confirmed on the new one.

## Checking it worked

```bash
tail -40 ~/Library/Logs/podcasts.log
tail -20 ~/Library/Logs/podcasts.err     # exit 2 and DEGRADED warnings land here
```

Every run prints one line of truth:

```
run: eligible=8 processed=6 failed=2 — serving 14 episode(s), 231 points
```

`processed=0` with a non-zero `eligible` is the state to care about. The page
says the same thing at the top of the feed — *"The last run read nothing new"* —
so the log and the page cannot disagree.
