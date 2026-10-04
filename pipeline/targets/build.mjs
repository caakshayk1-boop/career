#!/usr/bin/env node
/**
 * build.mjs — scores the target list and emits public/targets.json.
 *
 *   node pipeline/targets/build.mjs
 *
 * targets.json holds five sub-scores per employer; this adds them, joins the
 * hard evidence from his own jobs feed, ranks, and writes the artifact the
 * page reads. The arithmetic lives here rather than in the data so a total can
 * never drift from its parts — see rubric.md for what each component means.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const OUT  = join(HERE, "../../public/targets.json");

/* ── THE MODEL ─────────────────────────────────────────────────────────────
   FIRST VERSION OF THIS FILE RANKED NOTHING, AND IT IS WORTH SAYING WHY.
   Each employer carried five hand-typed sub-scores. Four of them landed in
   narrow bands — scale 16-20, hiring 13-20, visa 7-12, route 9-15 — because a
   number typed 103 times anchors on the last one typed. Only sector adjacency
   used its range. Total was therefore 60 + sector, 93 of 103 employers scored
   above 70, and a ranking where everything is 85-97 tells you nothing.

   So four of the five are now DERIVED from categorical facts about the
   employer: how big it is, who owns it, which work-authorisation regime it
   sits in, and whether there is a usable door. One mapping table, 103 rows of
   tags, and the bands below are the whole argument — change a band and every
   affected employer moves together, which is what a model is for. Sector
   adjacency stays a hand number, because it genuinely is a per-company
   judgement and it is the one component that already used its full range. */

export const WEIGHTS = [
  { k: "s", max: 30, label: "Sector adjacency",               short: "sector" },
  { k: "z", max: 20, label: "Scale: does the seat exist",     short: "scale" },
  { k: "h", max: 20, label: "Hires Indian CAs at this level", short: "hiring" },
  { k: "v", max: 15, label: "Work-authorisation headroom",    short: "visa" },
  { k: "r", max: 15, label: "Route in",                       short: "route" },
];

/* SCALE → does a controller seat exist separately from the CFO's chair.
   Below roughly USD 50m revenue or a single legal entity, it does not: the
   title exists, the job is the CFO's, and the hire is a step sideways. */
export const SCALE = {
  giant: { v: 20, why: "Group large enough that controller and Head of FP&A are distinct seats with teams under them." },
  large: { v: 15, why: "A controller seat exists and is resourced, usually one layer below a group CFO." },
  mid:   { v: 9,  why: "One controller for the whole group. Broad remit, little support, title bigger than the team." },
  small: { v: 4,  why: "No separate seat. The CFO does FP&A, and this would be a sideways move dressed as a step." },
};

/* OWNER → how often this type of employer appoints an Indian Chartered
   Accountant to a controller-grade seat. This is the component people are
   least comfortable stating and the one that most changes where to spend
   effort, so it is stated. GCC family groups and Indian-promoted groups are
   where the credential is read without translation. Malaysian GLCs and listed
   locals are where local-hire preference and MIA membership bind hardest. */
export const OWNER = {
  "indian-promoted": { v: 20, why: "Indian-promoted group: finance leadership is predominantly Indian CA. The credential needs no translation." },
  "gcc-family":      { v: 18, why: "GCC family conglomerate — the single most common employer of Indian CAs at controller grade in the region." },
  "listed-gcc":      { v: 15, why: "Listed GCC company: open hiring, defined finance ladder, and internal candidates for every rung." },
  "pe":              { v: 14, why: "Private-equity owned: hires on demonstrated numbers, indifferent to passport, impatient about ramp-up." },
  "mnc":             { v: 12, why: "Multinational: structured process, global mobility machinery, and a strong internal-promotion norm." },
  "govt-related":    { v: 9,  why: "Government-related entity: longer process, more weight on local market experience, nationalisation targets bite harder." },
  "startup":         { v: 11, why: "Scaling business building its finance function now. Receptive, under-resourced, and paying partly in optionality." },
  "listed-my":       { v: 7,  why: "Listed Malaysian company: MIA membership expected and local-hire preference is real at controller grade." },
  "glc-my":          { v: 4,  why: "Malaysian government-linked company: local-hire preference is at its strongest. Realistically closed to an expatriate controller hire." },
};

/* ZONE → work-authorisation headroom, 15 = least friction.
   The Malaysian numbers are not pessimism, they are the 1 June 2026 EP
   thresholds doing arithmetic: a seat that cannot pay RM20,000 cannot give
   Category I, and Category II now needs a documented succession plan — a
   written commitment to replace him with a Malaysian. */
export const ZONE = {
  "ae-freezone": { v: 15, why: "UAE free zone: own visa quota, Emiratisation targets do not apply the same way." },
  "ae-mainland": { v: 12, why: "UAE mainland: Emiratisation raises the marginal cost of an expatriate hire but does not block the role." },
  "kw":          { v: 9,  why: "Kuwait: tighter expatriate quotas than the UAE and a separate relocation decision." },
  "my-mnc":      { v: 10, why: "Malaysian MNC or shared-service hub: pay bands clear RM20,000, so EP Category I is achievable." },
  "my-local":    { v: 3,  why: "Malaysian local employer: most controller seats here cannot clear RM20,000, which means Category II and a documented succession plan to replace him with a Malaysian." },
};

/* ROUTE → is there a door that opens. A 90-fit employer with no visible door
   is worth less this quarter than a 70-fit employer already posting. */
export const ROUTE = {
  internal: { v: 15, why: "Already inside. The shortest path to a controller title he has." },
  feed:     { v: 14, why: "His own jobs feed has captured this employer posting at or near his grade — a door observed open, not assumed." },
  portal:   { v: 10, why: "Careers portal that actually answers. Slow, but it works without an introduction." },
  agency:   { v: 6,  why: "Realistically agency or referral only — low digital hiring footprint, so the §06 recruiter list is the route." },
  referral: { v: 3,  why: "No usable cold route. Hires from within its own ecosystem; needs an introduction before an application means anything." },
};

export function score(t) {
  const z = SCALE[t.scale], h = OWNER[t.owner], v = ZONE[t.zone], r = ROUTE[t.route];
  if (!z) throw new Error(`${t.name}: unknown scale "${t.scale}"`);
  if (!h) throw new Error(`${t.name}: unknown owner "${t.owner}"`);
  if (!v) throw new Error(`${t.name}: unknown zone "${t.zone}"`);
  if (!r) throw new Error(`${t.name}: unknown route "${t.route}"`);
  return {
    s: t.s, z: z.v, h: h.v, v: v.v, r: r.v,
    total: t.s + z.v + h.v + v.v + r.v,
    reasons: { scale: z.why, owner: h.why, zone: v.why, route: r.why },
  };
}

/* THE FACTS THAT MOVE THE WHOLE LIST, with their sources, printed on the page.
   Both are policy, both changed in 2026, and both are checkable. */
export const CONTEXT = [
  {
    id: "my-ep",
    title: "Malaysia's Employment Pass thresholds doubled on 1 June 2026",
    body: "Category I rose from RM10,000 to RM20,000 and above. Category II rose from RM5,000–9,999 to RM10,000–19,999 and now requires a documented succession plan. Category III rose from RM3,000–4,999 to RM5,000–9,999. New AND renewal applications submitted on or after 1 June 2026 must comply. A Malaysian employer who cannot pay RM20,000 cannot give Category I, which is why the Malaysian rows that score well here are MNC regional and shared-service seats.",
    source: "Immigration Department of Malaysia, Expatriate Services Division — announcement of 15 January 2026, following the Ministry of Home Affairs press release of 14 January 2026 and Cabinet approval of 17 October 2025.",
    url: "https://esd.imi.gov.my/portal/latest-news/announcement/announcement-266-ep-salary-policy-2026/",
  },
  {
    id: "ae-emiratisation",
    title: "Emiratisation is a headcount quota, not a bar on the role",
    body: "Mainland UAE companies with 50 or more skilled employees must raise their Emirati share of skilled headcount by 2% a year. Firms with 20–49 skilled employees in specified sectors owe a smaller fixed number. It raises the marginal cost of an expatriate hire; it does not block a controller appointment, and it does not apply the same way inside free zones. Scored here as a 2–3 point discount on work-authorisation headroom, not as a disqualifier.",
    source: "UAE Ministry of Human Resources and Emiratisation, Emiratisation targets guidance.",
    url: "https://mohre.gov.ae/en/guidance-and-awareness-portal-new/emiratisation-targets",
  },
];

/** Normalises an employer name enough to match the feed's spelling. */
export function key(s) {
  return String(s).toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
}

export function build() {
  const rows = JSON.parse(readFileSync(join(HERE, "targets.json"), "utf8"));
  const seen = JSON.parse(readFileSync(join(HERE, "seen.json"), "utf8"));

  const byKey = new Map(Object.entries(seen.companies).map(([n, v]) => [key(n), { name: n, ...v }]));

  const scored = rows.map((t) => {
    const sc = score(t);
    /* A row matches the feed when the feed's name contains this one or the
       reverse — "Majid Al Futtaim Retail" should match "Majid Al Futtaim",
       but "Al-Futtaim" must not match "Majid Al Futtaim". Longest match wins
       and the containment must be at a word boundary. */
    const k = key(t.name);
    let hit = byKey.get(k) || null;
    if (!hit) {
      let best = null;
      for (const [fk, v] of byKey) {
        if (k === fk || k.startsWith(fk + " ") || fk.startsWith(k + " ")) {
          if (!best || fk.length > key(best.name).length) best = v;
        }
      }
      hit = best;
    }
    return { ...t, ...sc, seen: hit ? { posts: hit.posts, bestFit: hit.bestFit, titles: hit.titles, as: hit.name } : null };
  });

  /* Ties break on hard evidence first, then alphabetically, so the order is
     stable across runs — a list that reshuffles on every build cannot be
     worked through from the top. */
  scored.sort((a, b) => b.total - a.total
    || (b.seen ? 1 : 0) - (a.seen ? 1 : 0)
    || a.name.localeCompare(b.name));
  scored.forEach((t, i) => { t.rank = i + 1; });

  const n = (p) => scored.filter(p).length;
  const doc = {
    version: 1,
    builtAt: new Date().toISOString(),
    weights: WEIGHTS,
    bands: { scale: SCALE, owner: OWNER, zone: ZONE, route: ROUTE },
    context: CONTEXT,
    evidence: { feedGeneratedAt: seen.feedGeneratedAt, employers: byKey.size },
    totals: {
      employers: scored.length,
      uae: n((t) => t.country === "AE"),
      malaysia: n((t) => t.country === "MY"),
      kuwait: n((t) => t.country === "KW"),
      withEvidence: n((t) => t.seen),
      above70: n((t) => t.total >= 70),
      above60: n((t) => t.total >= 60),
    },
    targets: scored,
  };
  writeFileSync(OUT, JSON.stringify(doc, null, 1) + "\n");
  return doc;
}

if (import.meta.filename === process.argv[1]) {
  const d = build();
  console.log(`targets: ${d.totals.employers} employers — ${d.totals.uae} UAE, ${d.totals.malaysia} Malaysia, ${d.totals.kuwait} Kuwait`);
  console.log(`  ${d.totals.withEvidence} with a posting his own feed captured (feed built ${d.evidence.feedGeneratedAt})`);
  console.log(`  ${d.totals.above70} score 70+, ${d.totals.above60} score 60+`);
  console.log("\n  rank  score  evidence  employer");
  for (const t of d.targets.slice(0, 15)) {
    console.log(`  ${String(t.rank).padStart(4)}  ${String(t.total).padStart(5)}  ${t.seen ? String(t.seen.bestFit).padStart(8) : "        "}  ${t.name} (${t.country})`);
  }
}
