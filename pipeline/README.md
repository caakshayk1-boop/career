# Podcast Intelligence — the pipeline

Turns a 2–3 hour conversation into 10–20 scannable points, each one a sentence
somebody actually said, expandable to the passage it came from.

**It costs nothing to run.** No API key, no model, no transcription bill, no
object storage, no npm dependency. A run is about thirty seconds of GitHub
Actions time.

```
sources.json ──▶ ingest ──▶ transcript ──▶ score ──▶ validate ──▶ publish
   feeds          RSS /      published      sentences   dedupe,     podcasts
                  YouTube    transcript     ranked by   grounding    .json
                  Atom       or captions    density,    check
                             ($0)           spread
```

## What "free" costs you, and what it buys

The free path selects sentences. It does not write any. That is the entire
trade and it cuts both ways:

**What you lose.** No "why this matters". No rephrasing into a crisp headline.
No characterisation of the conversation. Writing any of that means generating
text, which is the thing that costs money — so the pipeline does not do it, and
does not pretend to. Fields it cannot honestly fill are left empty and the page
skips them.

**What you get.** Fabrication is structurally impossible. A point *is* its
evidence; its timestamp is the timestamp of the words. There is no gap between
what the page prints and what was said for an error to live in. The tests
assert this directly: every point must be a substring of the transcript.

Set `EXTRACTOR=ai` with an `ANTHROPIC_API_KEY` and the interpretation layer
turns on — ranking, rationale, a written summary, an optional spoken briefing —
at roughly $0.50 an episode. Nothing else changes; the page renders whichever
fields are present.

## How points are chosen

**Standalone-ness is a hard gate, not a score.** A takeaway is read out of
context by definition — it sits in a list with no sentence before it — so a
sentence that depends on the previous one is not a takeaway however much
information it carries. Rejected outright: anything opening on a subordinating
conjunction (`Because…`, `So that…`, `Which…`), a demonstrative or pronoun with
no antecedent (`That is because…`, `This is why…`), talk about the conversation
rather than in it (`Let me ask you…`, `earlier in this episode`), a restarted
thought (`we're processing, we're processing`), and any question.

That gate exists because the first production run did not have it: 13 of 20
points contained "because" and most were fragments. `because` is one of the most
common words in speech and a plain regex signal scored a dependent clause
exactly as highly as a mechanism. Causality is now only credited when there is a
claim on one side of the connective and a reason on the other.

Removal first, then: sponsor reads, housekeeping, agreement noise, and anything
under six content words.

What survives is scored on nine signals — quantification, money, causal
structure (`because`, `which means`), correction (`most people think`,
`turns out`), rules and frameworks, definitions, enumeration, concrete personal
specifics — plus centrality (how much of the sentence's vocabulary recurs across
the whole conversation) and information density. Filler, over-length, opening on
a pronoun, and the first/last 3% of the episode are penalised; naming something
specific is rewarded.

Where the transcript is diarised, the **host is identified by question rate** and
demoted: the most quotable-sounding line in an interview is often the
interviewer's, and it is not the guest's claim.

Selection then **spreads across the timeline**. Taking the global top 20 reliably
returns 20 sentences from whichever fifteen minutes happened to be dense and
silently drops the other ninety, so the episode is bucketed by time and the best
of each bucket taken in rotation.

Display is **chronological**, not ranked. A score-ordered list of twenty
context-free sentences reads as noise even when every one is good.

## Nothing disappears

The first version of this replaced §12's existing podcast list the moment it
processed one episode of its own — so the rest of the feed vanished from the
page. That was wrong, and the fix is structural rather than cosmetic.

The desk feed (`news.askakshay.com/today.json` → `desk.podcasts`) is now a
SOURCE, at the front of the pipeline, not a fallback behind it. Every episode it
lists is either:

- **read** — points, timestamps, expansions, like any other source; or
- **pending** — shown as the title and whatever one-liner the feed already
  carried, exactly as it looked before, with a note saying it publishes no
  transcript and is not on YouTube.

Pending is not a terminal state: it is not written to the ledger, so configuring
a transcription key later picks those episodes up rather than skipping them
forever. It is subject to the same 7-day window as everything else, so it is a
list of what is current and not a graveyard.

**Three things that used to delete an episode now list it instead:**

| | |
|---|---|
| No free transcript | listed as pending |
| A processing failure (`no caption track published for this video`) | listed, with the reason |
| Over the daily cap | listed, and picked up on the next run |

**Curated sources skip the age and duration gates.** The desk feed is today's
list — somebody already decided these episodes matter — so filtering them by air
date asks the wrong question, and an episode that aired three weeks ago but
appears in today's digest belongs on today's page. They are dated by the digest,
not by the air date. Without this, 18 of 20 desk episodes vanished on the first
run that used the source.

A feature meant to add depth must never remove content.

## The supply problem, measured

Fourteen real feeds were fetched in CI on 13 Sep 2026. **Exactly one publishes
`<podcast:transcript>`:** Diary of a CEO, via flightcast — which yields 20
points an episode at $0.

Audio-only, all of them: Tim Ferriss, Huberman Lab, Acquired, Founders, My First
Million, Modern Wisdom, The Knowledge Project, Invest Like the Best.

Podcasting 2.0 transcript adoption among large shows is close to zero. That is
the binding constraint on this pipeline, not the code: **the set of podcasts it
can read for free is small**, and every candidate has to be checked rather than
assumed. `sources.json` records what each check found so the same feeds are not
re-added on a hunch.

`npm run podcasts:verify`, or the workflow's `verify_only` input, answers the
question for any new feed in about a second.

## Transcripts, and the one thing that will bite you

With no paid transcription key, an episode is readable only if the transcript is
already free:

- the feed publishes `<podcast:transcript>` (Podcasting 2.0), or
- it is a YouTube video with a caption track.

**A show that publishes audio and nothing else cannot be read here.** It is
skipped at eligibility with that reason — before any work is done — rather than
failing per-episode at 6am with no obvious cause. `npm run podcasts:verify`
tells you, per source, which case each one is in. Run it before enabling
anything.

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

All of it is environment variables. **Every one has a working default and the
pipeline runs to completion with all of them unset.**

| Variable | Default | What it does |
|---|---|---|
| `EXTRACTOR` | `local` | `local` = free, verbatim, no model. `ai` = the five-pass model pipeline. |
| `MAX_DAILY_EPISODES` | `12` | hard cap per run — the desk feed is a curated list and the reader expects all of it |
| `MIN_LEARNINGS` | `10` | floor — below this the episode is held, not published |
| `TARGET_LEARNINGS` | `20` | ceiling |
| `MAX_EPISODE_MINUTES` | `240` | skip anything longer |
| `MIN_EPISODE_MINUTES` | `20` | skip anything shorter |
| `MAX_LOOKBACK_HOURS` | `192` | ignore anything older — 8 days, one more than the public window |
| `PUBLIC_RETENTION_DAYS` | `7` | how long an episode is on the page |
| `DATA_RETENTION_DAYS` | `400` | how long we remember it existed |
| `TRANSCRIPT_PROVIDER` | `auto` | `published` / `youtube` / `deepgram` / `fixture` |
| `FIXTURE_TRANSCRIPT` | — | a JSON segments file, to rehearse a run offline |

Everything below is **off** and costs money when switched on:

| Variable | Cost | What it adds |
|---|---|---|
| `EXTRACTOR=ai` + `ANTHROPIC_API_KEY` | ~$0.50/episode | interpretation, ranking, written summary |
| `DEEPGRAM_API_KEY` | ~$0.26/episode | reads shows that publish no transcript |
| `TTS_PROVIDER=elevenlabs` + key + R2 | ~$1.05/episode | spoken briefings |

`PUBLIC_RETENTION_DAYS` and `DATA_RETENTION_DAYS` are separate on purpose. If
the ledger were pruned on the public clock, the job would rediscover the whole
back catalogue on day eight and reprocess it — a site that deletes its content
weekly would re-buy it weekly.

### Audio is not in git
### Audio is not in git

Three briefings a day at ~3MB is 60MB a week, and git keeps every byte forever:
deleting the file on day eight frees nothing, and the history would pass 3GB
within a year. Briefings go to R2 (`lib/r2.mjs`, SigV4 by hand rather than 15MB
of AWS SDK to sign one PUT). Set a 14-day lifecycle rule on the bucket — a
lifecycle rule cleans up more reliably than a nightly job that has to succeed in
order to tidy up after itself.

## What it costs

**$0.00.** Transcripts are already published, selection is a scoring function in
this repo, there is no model call, no storage, and no npm dependency on the free
path. `npm run podcasts` prints the total at the end of every run and it reads
`≈ $0.000`.

The paid opt-ins are in the second table above. Turning all three on takes a
2-hour episode to roughly $1.81.

## What it will not do

- **It will not write anything.** On the free path every point is a substring of
  the transcript. This is asserted in the test suite, not assumed.
- **It will not pad to hit a number.** `TARGET_LEARNINGS` is a ceiling. Below
  `MIN_LEARNINGS` the episode is held as `NEEDS_REVIEW` and never appears.
- **It will not print a quotation it cannot find.** Validation is deterministic
  code, not a model call — a model asked to check its own citation confirms it.
  Two signals must agree: content-word coverage, and a shared four-word run *in
  order*.
- **It will not print a timestamp it cannot support.** A citation whose words are
  more than 90 seconds away is corrected; one that cannot be placed is printed
  without a timestamp. A wrong timestamp is worse than none.
- **It will not present the host's framing as the guest's claim.** Where the
  transcript is diarised, the host is identified and demoted.

## Known limitations

1. **YouTube captions cannot be read from CI. This is settled, not open.**
   Four routes were tried from GitHub Actions and all four are closed:

   | Route | Result |
   |---|---|
   | `api/timedtext` (public) | empty body |
   | Watch page scrape | HTML with no player config |
   | InnerTube `WEB` / `MWEB` | `LOGIN_REQUIRED` — "Sign in to confirm you're not a bot" |
   | InnerTube `ANDROID` / `IOS` | `400 Precondition check failed` — device attestation |

   The last two are the informative ones: **InnerTube is reachable from a
   datacentre IP** — it answers, and what it answers is that the caller must
   authenticate or attest. That is deliberate policy, not a gap to engineer
   around. What remains is a logged-in cookie in CI (a credential, and fragile),
   a residential IP, or a paid third party.

   **The same code reads every one of those episodes from a laptop.** `npm run
   podcasts` on a home connection works; only the runner is refused. All four
   routes are kept for that reason, and because any of them may start answering
   again.

1. **The other YouTube caveats.** `api/timedtext` needs no key, but Google serves it empty
   to datacentre IPs — every CI runner. Twelve readable episodes came back "no
   caption track" from GitHub Actions while having perfectly good auto-captions.
   The pipeline therefore reads the watch page's `captionTracks`, whose signed
   `baseUrl`s answer from the same IP, and falls back to the bare endpoint.
   Both are undocumented and either can stop working; when both fail the episode
   is LISTED with the reason, never deleted and never given invented timings.
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
8. **Point quality is bounded by what was said.** A guest who never says
   anything specific produces twenty unspecific points. The scorer can rank
   sentences; it cannot improve them. If a source reliably yields weak points,
   the source is the problem — disable it.
9. **`<podcast:transcript>` is not universal.** Adoption is growing but plenty of
   major shows still publish audio only. `podcasts:verify` tells you which.

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
    extractive.mjs     the free extractor — scoring, spread, pills, passages
    text.mjs           content words, coverage, ordered-run matching
    ai.mjs             AIProvider: anthropic | mock (only used when EXTRACTOR=ai)
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
