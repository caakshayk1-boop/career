# Running the morning job on your own machine

**Why:** YouTube refuses caption access to datacentre IPs. InnerTube answers a
GitHub Actions runner with *"Sign in to confirm you're not a bot"*, and the
mobile clients with a device-attestation failure. Four routes were tried and all
four are closed — see `pipeline/README.md`.

From a home connection none of that applies. **The same pipeline, unchanged,
reads every one of those episodes.** Only the runner is refused.

The GitHub Action stays on as well. It handles the RSS shows that publish
transcripts and keeps the page fresh when this machine is off, so the two are
complements rather than alternatives.

## One-off

```bash
./scripts/morning.sh --dry-run   # read everything, write nothing
./scripts/morning.sh             # read, commit, push — the site updates in ~90s
```

## Every morning, macOS

`launchd` rather than `cron`: cron does not run a job that was scheduled while
the machine was asleep, and a laptop is asleep at 06:30. `StartCalendarInterval`
fires on the next wake instead of skipping the day.

Save as `~/Library/LaunchAgents/com.askakshay.podcasts.plist`, replacing the
path with wherever this repository lives:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.askakshay.podcasts</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /Users/YOU/path/to/career && ./scripts/morning.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/tmp/podcasts.log</string>
  <key>StandardErrorPath</key><string>/tmp/podcasts.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.askakshay.podcasts.plist
launchctl start com.askakshay.podcasts      # test it now
tail -f /tmp/podcasts.log
```

To stop: `launchctl unload ~/Library/LaunchAgents/com.askakshay.podcasts.plist`

## Every morning, Linux

```bash
crontab -e
30 6 * * *  cd /home/you/career && ./scripts/morning.sh >> /tmp/podcasts.log 2>&1
```

## Every morning, Windows

Task Scheduler → Create Task → Trigger: daily 06:30 → Action:
`C:\Program Files\Git\bin\bash.exe` with arguments
`-lc "cd /c/path/to/career && ./scripts/morning.sh"`.

## What you need

- **Node 22+** and **git** on PATH
- **git push access** to the repo (an SSH key or a cached credential — the
  script does not prompt, so a push that needs a password will fail and leave
  the commit local)
- Nothing else. No API key, no transcription key, no cost.

## Checking it worked

```bash
tail -30 /tmp/podcasts.log
```

The run prints what it read, what it skipped and why, and `≈ $0.000`. An episode
it could not read is listed on the page rather than dropped, so the log and the
page agree.
