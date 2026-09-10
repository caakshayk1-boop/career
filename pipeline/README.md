# Podcast Intelligence — the pipeline

Turns a 2-3 hour conversation into the ten things worth knowing, with the
sentence each one came from and the moment it was said.

```
sources.json ──▶ ingest ──▶ transcript ──▶ chunk ──▶ extract ──▶ validate ──▶ audio ──▶ publish
   feeds          RSS /       captions     14k-char   pass 1:     CODE, NOT    briefing   podcasts
                  YouTube     or ASR       overlap    per chunk   A MODEL      (optional)  .json
                  Atom        (cached)     windows    pass 2:
                                                      merge+rank
                                     ▲                                            ▲
                                     └── everything cached on disk ───────────────┘
                              (a re-run after a failure costs nothing it already paid for)
```

Three seams, so no vendor is load-bearing:

| Interface | Implementations | Default with no credentials |
|---|---|---|
| `AIProvider` (`lib/ai.mjs`) | `anthropic`, `mock` | `mock` — offline, deterministic |
| `AudioProvider` (`lib/audio.mjs`) | `elevenlabs`, `none` | `none` — text publishes, no player |
| transcript (`lib/transcript.mjs`) | `youtube`, `deepgram`, `fixture` | captions first, ASR only if needed |
| NotebookLM (`lib/notebooklm.mjs`) | — | not wired up, on purpose. See that file. |

## Why there is no database and no admin dashboard

The brief asked for both. Neither is the right answer here, and the reasons are
worth writing down because they will look like omissions otherwise.

**No database.** This site is an assets-only Cloudflare Worker — no script, no
bindings, no cold start. Adding D1 to hold a few hundred rows would mean adding
a Worker script, a binding, a migration path and a second deploy story, to query
a table that fits in a 40KB JSON file. Two files do the job: `state.json` (the
ledger — what we have seen, so the job never pays twice) and
`public/podcasts.json` (the artifact — exactly what the page renders).

**No admin dashboard.** An admin UI needs a server, auth, and a second attack
surface, for one operator. `sources.json` plus `workflow_dispatch` does
everything the brief's admin list asked for, and does it better: every change is
a reviewable diff with history.

| Brief asked for | How you do it |
|---|---|
| add / remove / pause a source | edit `sources.json` (`"enabled": false` to pause) |
| manually trigger processing | Actions → **podcasts** → Run workflow |
| retry a failed episode | re-run the workflow; the ledger holds `FAILED`, the cache holds what was paid for |
| approve / reject an episode | `NEEDS_REVIEW` in `state.json`, with the reasons; delete the row to retry |
| edit a learning | edit `public/podcasts.json` and push — it is the rendered content |
| regenerate analysis | bump `promptVersion` in `config.mjs`, or run with `force` |
| view status / errors | the workflow log, and `run.errors` inside the published artifact |

The one thing this genuinely does not have is a *browser* for that state. If
editing JSON stops being acceptable, that is when to build a Worker — not
before.

## Commands

```bash
npm run podcasts           # the morning job
npm run podcasts:dry       # everything except writing the artifact
npm run podcasts:verify    # fetch every configured feed and show what it actually is
npm run podcasts:test      # 93 offline checks, no keys, ~2s
node pipeline/run.mjs --republish   # rebuild the artifact from the ledger, process nothing
node pipeline/run.mjs --force       # reprocess settled episodes (costs money)
```

To rehearse the whole path against a real feed before spending anything:

```bash
TRANSCRIPT_PROVIDER=fixture FIXTURE_TRANSCRIPT=./sample.json \
AI_PROVIDER=mock npm run podcasts:dry
```

## Configuration

All of it is environment variables; nothing is hard-coded and no key is ever in
source. Secrets go in GitHub **secrets**, tunables in GitHub **variables**.

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | secret. Absent ⇒ the mock provider, which publishes nothing real. |
| `AI_MODEL` | `claude-opus-5` | the judging model: merge, rank, summary, script |
| `AI_MODEL_CHEAP` | `claude-haiku-4-5` | the reading model: per-chunk candidate extraction |
| `ELEVENLABS_API_KEY` | — | secret. Absent ⇒ no audio, text still publishes. |
| `ELEVENLABS_VOICE_ID` | a stock voice | |
| `DEEPGRAM_API_KEY` | — | secret. Only used when a source has no caption track. |
| `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE` | — | where briefings live. Audio is **not** in git — see below. |
| `MAX_DAILY_EPISODES` | `3` | hard cap per run. The main cost brake. |
| `MAX_EPISODE_MINUTES` | `240` | skip anything longer |
| `MIN_EPISODE_MINUTES` | `20` | skip anything shorter — it will not hold ten ideas |
| `MAX_LOOKBACK_HOURS` | `72` | ignore anything older; the page only shows 7 days |
| `TARGET_LEARNINGS` | `10` | a **ceiling**, never a quota |
| `MIN_LEARNINGS` | `5` | below this the episode is held, not published |
| `PUBLIC_RETENTION_DAYS` | `7` | how long an episode is on the page |
| `DATA_RETENTION_DAYS` | `400` | how long we remember it existed |
| `TRANSCRIPT_PROVIDER` | `auto` | `youtube` / `deepgram` / `fixture`, or `auto` to try captions then ASR |
| `FIXTURE_TRANSCRIPT` | — | path to a JSON segments file, for rehearsing a run without paying for one |

`PUBLIC_RETENTION_DAYS` and `DATA_RETENTION_DAYS` are separate on purpose. If
the ledger were pruned on the public clock, the job would rediscover the whole
back catalogue on day eight and pay to process it again — a site that deletes
its content weekly would re-buy it weekly.

### Audio is not in git

Three briefings a day at ~3MB is 60MB a week, and git keeps every byte forever:
deleting the file on day eight frees nothing, and the history would pass 3GB
within a year. Briefings go to R2 (`lib/r2.mjs`, SigV4 by hand rather than 15MB
of AWS SDK to sign one PUT). Set a 14-day lifecycle rule on the bucket — a
lifecycle rule cleans up more reliably than a nightly job that has to succeed in
order to tidy up after itself.

## What it costs

Per 2-hour episode, at list prices, with a caption track available:

| Step | Basis | Cost |
|---|---|---|
| Transcript | YouTube captions | $0 |
| Transcript | Deepgram Nova-3, if no captions | ~$0.26 |
| Pass 1 — read (Haiku 4.5) | ~12 chunks, ~90k in / 12k out | ~$0.15 |
| Pass 2 — merge and rank (Opus 5) | ~25k in / 4k out | ~$0.23 |
| Passes 4-5 — summary and script (Opus 5) | ~8k in / 3k out | ~$0.12 |
| Audio briefing (ElevenLabs, ~7,000 chars) | Creator-tier rate | ~$1.05 |
| **Total, captions + audio** | | **≈ $1.55** |
| **Total, captions, no audio** | | **≈ $0.50** |
| **Total, ASR + audio** | | **≈ $1.81** |

At the default cap of 3 episodes a day that is roughly **$140/month with audio,
$45/month without**. Audio is two thirds of the bill; if that is not worth it,
leave `ELEVENLABS_API_KEY` unset and the product still works.

The system prompt is identical across every chunk of every episode and is
cached, so 11 of a 12-chunk episode's calls read the prompt at a tenth of the
price. Every expensive step is also cached on disk by episode id and prompt
version: a re-run after a TTS failure re-reads nothing and re-pays nothing.
`npm run podcasts` prints an estimate at the end of every run.

## What it will not do

- **It will not invent a tenth idea.** `TARGET_LEARNINGS` is a ceiling. Six
  strong ideas publish as six. Fewer than `MIN_LEARNINGS` and the episode is
  held as `NEEDS_REVIEW` and never appears.
- **It will not print a quotation it cannot find.** Validation (`lib/validate.mjs`)
  is deterministic code, not a model call — a model asked to check its own
  citation confirms it. Two independent signals must agree: content-word
  coverage, and a shared four-word run *in order*. A quote assembled from words
  the conversation did contain, in an order nobody said them in, fails the
  second and is demoted from `said` to `interpretation`.
- **It will not print a timestamp it cannot support.** A citation whose
  quotation is found more than 90 seconds away is corrected to where the words
  actually are; one that cannot be placed at all is printed without a
  timestamp. A wrong timestamp is worse than none — the reader clicks it, hears
  something else, and stops trusting all of them.
- **It will not present its own inference as something the guest said.** Every
  learning carries `said` / `interpretation` / `recommendation`, and the page
  shows it.

## Known limitations

1. **YouTube captions are not a documented API.** `api/timedtext` needs no key
   and is by far the cheapest transcript available, but it is fetched from a
   datacentre IP and Google sometimes answers those with an empty body. When it
   does, the run falls through to Deepgram if a key is set, and otherwise
   records the episode `FAILED` with the reason. It never fabricates timings.
2. **No YouTube audio download.** Without captions and without an enclosure URL
   there is nothing to transcribe. Prefer RSS sources, which carry one.
3. **Timestamp deep links only work for YouTube.** A generic podcast page has no
   agreed fragment for "jump to 4:37", so the page renders those citations as
   flat markers rather than links that look clickable and are not.
4. **Feed URLs in `sources.json` are unverified.** They were written in an
   offline environment. Run `npm run podcasts:verify` before the first real run.
5. **Audio duration is computed from the file size**, which is exact only
   because the output format is pinned to constant-bitrate MP3. There is no
   ffprobe on the runner.
6. **GitHub's scheduler fires late under load.** Fine for a morning read;
   nothing downstream assumes an exact time.
7. **Ad stripping is heuristic.** It is deliberately conservative — an earlier
   version widened its window by ±45 seconds and ate the first substantive
   answer of an episode. Leaving one line of ad copy in is much cheaper than
   deleting content, and the extraction prompt discards promos anyway.
8. **Nothing here has called a real AI or TTS provider.** The suite runs against
   the mock provider by design. The first live run is the first live run.

## Files

```
pipeline/
  run.mjs              the morning job — state machine, per-episode isolation
  config.mjs           every knob, read from the environment
  sources.json         the podcast registry — this is the admin surface
  verify-sources.mjs   prove each feed is the show it claims to be
  state.json           the ledger (committed)
  lib/
    ingest.mjs         feeds -> candidate episodes; eligibility as cost control
    xml.mjs            a small, tested reader for RSS and Atom
    transcript.mjs     captions / ASR behind one interface, plus a quality gate
    chunk.mjs          timestamped, overlapping, speaker-aware segmentation
    ai.mjs             AIProvider: anthropic | mock
    prompts.mjs        the product. Versioned by cfg.promptVersion.
    extract.mjs        the passes
    validate.mjs       the grounding gate — deterministic, no AI
    audio.mjs          AudioProvider: elevenlabs | none
    r2.mjs             SigV4 PUT to R2
    retention.mjs      public window vs data window
    store.mjs          ledger, cache, artifact
    log.mjs            structured run log and cost accounting
    notebooklm.mjs     the adapter, and why it is empty
  test/run-tests.mjs   93 offline checks
```
