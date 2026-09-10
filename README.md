# career.askakshay.com — The Campaign

A private working surface for the 2026 job search. Static pages served from an
assets-only Cloudflare Worker: no build step, no server, no database. The one
thing that is not static is the podcast pipeline, which runs in GitHub Actions
and commits its output as an asset — see below.

## What it is

| § | Section | What it does |
|---|---------|--------------|
| 01 | Today | Three drill questions and a focus, rotating deterministically on the date |
| 02 | Interview bank | 40 questions with model answers written in Akshay's own facts, filterable and rated |
| 03 | Technical | The 8 mechanisms a Controller interview actually tests |
| 04 | Why it stalled | Ranked diagnosis of the 100+ failed applications |
| 05 | The plan | 90-day campaign; the channel reallocation is the point |
| 06 | Positioning | The sentence, three STAR stories, six numbers to know cold |
| 07 | Targets | Employer shortlist where the experience transfers structurally |
| 08 | Market intel | Malaysia EP thresholds (verified at source) and UAE bands |
| 09 | Money | Negotiation order, anchors, scripts |
| 10 | The long game | Process discipline over outcome |

### `/podcasts` — Podcast Intelligence

Two- and three-hour conversations cut down to **10–20 scannable points**, each
one a sentence somebody actually said, at the moment they said it. Tap a point
to read it back in the passage it came from. Seven days, then it is gone.

**Every point is verbatim.** Nothing on the page is written by a machine, which
is why nothing on it can be made up — and also why there is no commentary on
what any of it means. It selects sentences; it does not write them.

**It costs nothing to run.** No API key, no model, no transcription bill, no npm
dependency. Transcripts come from what shows already publish
(`<podcast:transcript>` or a YouTube caption track) and the points are chosen by
a scoring function in this repo. A morning run is about thirty seconds of GitHub
Actions time and prints `≈ $0.000`.

The paid interpretation layer still exists behind a flag — `EXTRACTOR=ai` plus an
`ANTHROPIC_API_KEY` adds ranking, a rationale per point and a written summary at
roughly $0.50 an episode. Nothing else changes.

The pipeline — how points are chosen, what it will not do, and the one thing
that will bite you — is documented in [`pipeline/README.md`](pipeline/README.md).

### `/home` — The Home Book

A second, self-contained page on the same assets Worker: the fatherhood and
marriage manual (routines, feeding, sleep, reading, growth calendar, red flags).
Linked from §12 Life and from the rail as `13`.

It is a **separate document on purpose**. §12 Life renders from
`news.askakshay.com/today.json`, which is built in another repo — a 60KB static
book bolted into that section would double the weight of the job-search page and
would sit behind a "Loading…" state it has nothing to do with. As a sibling file
it costs one more asset and cannot break `index.html`.

Every date on it (her age, days to the first birthday, days to MMR-1/MMR-2) is
**derived from a single `BORN` constant at run time**, never hardcoded, so the
page does not rot. Dates are built with `new Date(y, m, d)` rather than parsed
from an ISO string — a bare `"2025-12-25"` parses as UTC and reads a day early
in MYT.

Health claims are sourced inline at the foot of each section (WHO, US CDC, NHS,
Malaysia MOH). **No supplement doses appear anywhere, deliberately.** If you
edit the feeding or red-flag sections, keep that rule.

## Running it

```bash
npm install
npx wrangler dev
```

Or any static server — `python3 -m http.server --directory public`. There is
nothing to compile. The one dependency (`@anthropic-ai/sdk`) is loaded on demand
by the optional paid extractor only — the default pipeline runs from a bare
checkout with no `npm install` at all.

```bash
npm run check              # load all three pages in a real browser and assert behaviour
npm run podcasts:test      # the pipeline's own suite — offline, no keys, ~2s
npm run podcasts:verify    # confirm every configured podcast feed is the show it claims to be
npm run podcasts:dry       # a full run that writes nothing
```

## Deploying

```bash
npx wrangler deploy
```

`wrangler.jsonc` declares `career.askakshay.com` as a custom domain. Cloudflare
provisions the certificate and the route itself — **do not add an A or CNAME
record by hand**, that is what causes the conflict. `workers_dev` is off
deliberately: the page carries salary targets and an employer shortlist and has
no reason to hold a second public hostname.

`robots.txt` disallows everything and the page is `noindex,nofollow`. It is not
secret, but it is not for search engines.

## The morning job

`.github/workflows/podcasts.yml` runs at 22:30 UTC — 06:30 MYT — reads the
configured feeds, processes what is new, and commits `public/podcasts.json`.
**It requires no secrets.**

That commit does **not** trigger the deploy workflow's `push` event: GitHub
suppresses workflow triggers for pushes made with the default `GITHUB_TOKEN`,
to stop a workflow that commits from re-triggering itself. `deploy.yml`
therefore also listens on `workflow_run` for `podcasts` completing, which is
exempt from that rule. Remove that trigger and the morning job will keep
committing points that never reach the site. Two files change on a normal morning: the artifact and
`pipeline/state.json`, the ledger that stops the job reprocessing the same
conversation twice.

**It is idempotent.** Run it twice and the second run does nothing. Episode
identity comes from the feed's own GUID, never the title — shows retitle
episodes after publishing, and a title-derived id would bring every one of them
back as new.

**Nothing is published to hit a number.** Below the floor of 10 points the
episode is held as `NEEDS_REVIEW` and does not appear at all.

**A source that publishes no transcript cannot be read.** Without a paid
transcription key, an episode needs either a `<podcast:transcript>` URL or a
YouTube caption track. Anything else is skipped, with that reason, before any
work is done. `npm run podcasts:verify` reports which case every source is in —
run it before enabling a source.

## State

Ratings, counters and checkboxes live in `localStorage` under the `ak:` prefix,
in one browser, and are never sent anywhere. Every access is wrapped in
try/catch — `localStorage` *throws* in private windows and when site data is
blocked, rather than returning null.

## Things that will bite you

- **No IntersectionObserver, no requestAnimationFrame.** Neither fires in a tab
  the browser considers hidden, and the scroll-spy nav then reads as broken.
  Scroll handling is a throttled `scroll` listener on `setTimeout`.
- **Colour transitions freeze in a hidden tab.** A theme toggle leaves
  `getComputedStyle().color` stuck at the *start* value. If you are measuring
  contrast programmatically, disable transitions first or you will chase a
  failure that does not exist. (Measured with transitions off: every text/background
  pair clears WCAG AA in both themes, lowest 5.33:1.)
- **Counts are asserted in three places** — the `<h2>`, the hero stat and a code
  comment. If you add questions to `BANK`, update all three.

## Verified 2026-09-10 — podcast intelligence

- 143 pipeline checks pass offline (feed parsing, VTT/SRT/JSON transcripts,
  episode identity, eligibility, host detection, verbatim guarantee, timeline
  spread, chunk coverage, grounding, timestamp repair, deduplication, retry,
  retention, idempotence, end-to-end)
- a full run rehearsed against a local feed with **no credentials of any kind**
  and **no `node_modules`**: 4 discovered, 2 processed, 20 points each,
  `≈ $0.000`, 0.8s — and a second run correctly did nothing
- `/podcasts` exercised in Chromium: 20 collapsed points, expand one, expand
  all, timestamps, passage expansion, the empty state, and 320px with no
  sideways scroll
- `/` still renders; §12 Life leads with points and read-time

**Verified against the real feeds on 10 Sep 2026.** The Diary Of A CEO parses
(882 items), publishes `<podcast:transcript>`, and produced 20 points from a
146-minute episode at `$0.000`. Invest Like the Best parses (596 items) but
nothing fell inside the 72-hour window that day, so whether it publishes a
transcript is **still unknown** — run `npm run podcasts:verify`, which says per
source whether it can be read for free.

## Verified 2026-09-03

- 40 bank entries, 8 reference entries, all render
- expand, rate-and-persist, category filter, search, counters, checkbox
  persistence, theme toggle — all exercised in-browser
- no console errors; no horizontal overflow at 1280px; tables scroll in their
  own containers
- contrast AA in both themes

Market data in §08 was read from source on 2 Sep 2026. **Re-check the EP
thresholds before quoting them to anyone.**
