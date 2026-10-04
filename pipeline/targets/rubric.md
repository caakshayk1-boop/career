# How the 100 are scored

Five components, 100 points. Every company carries its five sub-scores in
`targets.json`, so the total is arithmetic you can check and the ranking is
arguable rather than asserted.

| # | Component | Max | What it measures |
|---|---|---|---|
| `s` | Sector adjacency | 30 | How directly multi-entity retail / hospitality / real-estate FP&A experience reads on this employer's P&L. 30 = same sector, same model. 10 = adjacent. 0 = needs sector-specific technical depth (banking capital, upstream oil, actuarial). |
| `z` | Scale: does the seat exist | 20 | Whether the company is big enough for a Financial Controller or Head of FP&A to be a distinct seat rather than part of the CFO's job. Below roughly USD 50m revenue or a single legal entity, it is not. |
| `h` | Hiring pattern at this level | 20 | How often employers of this type actually appoint Indian Chartered Accountants to controller-grade finance seats. High in GCC family conglomerates and listed retail/real estate. Lower in Malaysian GLCs and listed locals, where MIA membership and local-hire preference bind. |
| `v` | Work-authorisation headroom | 15 | 15 = least friction. UAE private-sector roles outside Emiratisation-heavy sectors score high. Malaysian roles are capped by the EP thresholds that rose on 1 June 2026 — a seat that cannot pay RM20,000 cannot give Category I, and Category II now needs a documented succession plan. |
| `r` | Route in | 15 | Whether there is a usable door: a direct careers portal that answers, a retained agency on the §06 list, a Big 4 / CA alumni path, or a posting his own feed has already seen. |

## What is measured and what is judged

**Measured.** Country, sector and corporate scale are facts. So is
`seen: true` — those 31 employers posted a role at or near his level that his
own jobs feed captured between September and 21 September 2026, with the
`candidate_fit_score` the feed assigned.

**Judged.** All five sub-scores are this analysis's judgement, not a
measurement. They encode how GCC and Malaysian finance hiring works at
controller grade. They are published per company precisely so they can be
argued with: change a number, the ranking moves, and the reasoning is visible.

**Absent on purpose.** No salary figures and no headcounts. Both would be
invented at this resolution, and an invented number is worse than a blank —
it gets quoted back in a negotiation.

## The two facts that move the whole list

1. **Malaysia's EP thresholds doubled on 1 June 2026.** Category I went from
   RM10,000 to RM20,000+; Category II from RM5,000–9,999 to RM10,000–19,999
   and now requires a succession plan; Category III from RM3,000–4,999 to
   RM5,000–9,999. Source: Immigration Department of Malaysia, ESD announcement
   of 15 January 2026, following MOHA's press release of 14 January 2026 and
   Cabinet approval of 17 October 2025. New **and renewal** applications on or
   after 1 June 2026 must comply. This is why Malaysian rows carry a lower `v`
   than comparable UAE rows, and why the Malaysian rows that score well are
   MNC regional and shared-service seats — those are the ones that pay
   Category I money.
2. **Emiratisation applies to skilled headcount, not to a named role.**
   Mainland UAE companies with 50+ skilled employees must raise Emirati
   skilled-workforce share by 2% a year; 20–49 employee firms in specified
   sectors owe a smaller fixed number. It raises the cost of hiring any
   expatriate at the margin — it does not bar a controller hire, and it does
   not apply the same way in free zones. It is a 2–3 point `v` discount here,
   not a disqualifier.
