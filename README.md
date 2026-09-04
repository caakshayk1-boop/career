# career.askakshay.com — The Campaign

A private working surface for the 2026 job search. One page, no build step, no
API, no database, no secrets.

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
npx wrangler dev
```

Or any static server — `python3 -m http.server --directory public`. There is
nothing to compile.

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

## Verified 2026-09-03

- 40 bank entries, 8 reference entries, all render
- expand, rate-and-persist, category filter, search, counters, checkbox
  persistence, theme toggle — all exercised in-browser
- no console errors; no horizontal overflow at 1280px; tables scroll in their
  own containers
- contrast AA in both themes

Market data in §08 was read from source on 2 Sep 2026. **Re-check the EP
thresholds before quoting them to anyone.**
