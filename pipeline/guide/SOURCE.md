# Where this guide comes from

`source/` is a verbatim copy of the English translation of **高性价比人生指南**
("A High Value-for-Money Guide to Life"), 654 evidence-graded entries across 34
sections. `build.mjs` parses it into the JSON that `/guide` renders. Nothing in
`source/` is edited — a diff against upstream should be empty.

| | |
|---|---|
| Original | 高性价比人生指南 — https://github.com/eternity4719/HowToLiveBetter |
| Licence | CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/ |
| Translation | dlgrv — https://github.com/dlgrv/HowToLiveBetter |
| Synced from | upstream `b4048d1` (2026-10-04) · translation `638506e` (2026-10-04) |

## What was changed, which CC BY 4.0 requires stating

1. **Only the English translation is carried.** The Chinese original is the
   authoritative text; where the two disagree, the original wins.
2. **Nothing is rewritten.** Entry text is reproduced as translated. The build
   parses it into fields; it does not edit prose.
3. **Each entry is labelled for where it applies.** The book is written for
   mainland China: its legal, medical-insurance and social-insurance content
   states Chinese rules. 151 of 654 entries give advice that depends on a
   Chinese law or benefit scheme, and a further 176 quote a cost in yuan while
   resting on evidence that is not country-specific. Both are flagged on the
   page. This labelling is this repo's addition and is **not** part of the
   original — see `build.mjs` for exactly how it is derived.
4. **The translation lags the original.** Upstream counts 657 entries; the
   English carries 654. Three entries are not here.

## Re-syncing

    git clone --depth 1 https://github.com/dlgrv/HowToLiveBetter /tmp/hlb
    cp /tmp/hlb/book/en/*.md pipeline/guide/source/
    node pipeline/guide/build.mjs

Then update the commit hashes and the date in the table above — the book's
cited laws, subsidy rates and deadlines change, and a guide that does not say
which day it was synced is a guide that cannot be checked.
