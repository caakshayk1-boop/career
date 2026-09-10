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

Two- and three-hour conversations, read in full every morning and reduced to the
ideas worth knowing. Each learning carries the sentence it came from, the moment
it was said, and a label saying **how it is known**: `said` by the guest,
`interpretation` of what they said, or `recommendation` that nobody on the
podcast made. Seven days, then it is gone.

That label is the point of the whole thing. A summariser that presents its own
inference in the guest's voice is worse than no summariser, because you act on
it. The pipeline drops any quotation it cannot find in the transcript, and
demotes any claim it cannot quote.

The full pipeline — how it works, what it costs, how to configure it and what it
cannot do — is documented in [`pipeline/README.md`](pipeline/README.md).

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
nothing to compile. The one dependency (`@anthropic-ai/sdk`) is used by the
podcast pipeline only; it is never loaded by a page and never reaches the edge.

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
That push triggers the deploy workflow, which ships it. Two files change on a
normal morning: the artifact and `pipeline/state.json`, the ledger that stops
the job paying to process the same conversation twice.

**It is idempotent.** Run it twice and the second run does nothing. Episode
identity comes from the feed's own GUID, never the title — shows retitle
episodes after publishing, and a title-derived id would bring every one of them
back as new.

**Nothing is published to hit a number.** If a conversation yields six ideas
worth knowing, six are published. If fewer than five survive validation the
episode is held as `NEEDS_REVIEW` and does not appear at all.

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

- 93 pipeline checks pass offline (feed parsing, episode identity, eligibility,
  chunk coverage over a 3-hour transcript, grounding, timestamp repair,
  deduplication, retry, retention, idempotence, end-to-end)
- `/podcasts` exercised in Chromium against a fixture artifact: feed, day
  grouping, detail view, attribution labels, quotation toggles, timestamp deep
  links, empty state, 320px with no sideways scroll
- `/` still renders; §12 Life now leads with podcast intelligence and falls back
  to the old desk-feed list when the job has not run

**Not verified from here, and you must do it before the first real run:** the
feed URLs in `pipeline/sources.json` were written in an offline environment and
are marked `"verified": false`. Run `npm run podcasts:verify` — it fetches each
one and prints the show title and newest episode so you can see it is the right
show. No AI provider or TTS provider has been called; the suite runs entirely
against the mock provider.

## Verified 2026-09-03

- 40 bank entries, 8 reference entries, all render
- expand, rate-and-persist, category filter, search, counters, checkbox
  persistence, theme toggle — all exercised in-browser
- no console errors; no horizontal overflow at 1280px; tables scroll in their
  own containers
- contrast AA in both themes

Market data in §08 was read from source on 2 Sep 2026. **Re-check the EP
thresholds before quoting them to anyone.**
