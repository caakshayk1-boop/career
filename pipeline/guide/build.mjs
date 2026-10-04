#!/usr/bin/env node
/**
 * build.mjs — turns pipeline/guide/source/*.md into the JSON /guide renders.
 *
 *   node pipeline/guide/build.mjs
 *
 * The source is the English translation of 高性价比人生指南: 654 entries in 34
 * sections, every one with the same six fields and a machine-readable cost tag.
 * See SOURCE.md for provenance and the CC BY 4.0 terms.
 *
 * WHY A BUILD STEP AND NOT A MARKDOWN RENDERER. 2.1 MB of markdown parsed in
 * the browser means the page cannot filter, cannot search, and cannot be read
 * on a phone before the whole book arrives. The build emits a ~110 KB index
 * the page loads once and a per-section file it fetches on demand, so opening
 * /guide costs one small request and opening a section costs one more.
 *
 * THE SCOPE LABEL IS THE POINT OF THIS FILE, AND IT IS THIS REPO'S ADDITION.
 * The book is written for mainland China. Most of its health and money content
 * is evidence that does not care which country you are in — a seat belt halves
 * your odds in Kuala Lumpur as in Chengdu. But a meaningful minority of entries
 * ARE a Chinese regulation or a Chinese benefit scheme, and read as universal
 * advice those are not merely useless, they are wrong: the reader is in
 * Malaysia and headed for the UAE.
 *
 * So every entry gets one of three labels, derived mechanically below:
 *
 *   global  — no legal or benefit dependency, no currency figure. Travels.
 *   priced  — the evidence travels, the cost figure is in yuan. Travels with
 *             arithmetic.
 *   cn      — the ADVICE ITSELF is a Chinese rule, filing, entitlement or
 *             deadline. Does not travel, and is marked so on the page.
 *
 * THE LABEL IS A HEURISTIC AND SAYS SO ON THE PAGE. It keys off legal and
 * benefit vocabulary in the entry body, not off a human reading 654 entries. It
 * will mislabel some. A heuristic that is announced as one is honest; a silent
 * localisation that invented Malaysian equivalents for 151 Chinese regulations
 * would not be, and this build does not attempt one.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC  = join(import.meta.dirname, "source");
const OUT  = join(import.meta.dirname, "../../public/guide");

/* Provenance, printed on the page. Update alongside SOURCE.md on a re-sync. */
const SOURCE = {
  title: "高性价比人生指南",
  titleEn: "A High Value-for-Money Guide to Life",
  origin: "https://github.com/eternity4719/HowToLiveBetter",
  translation: "https://github.com/dlgrv/HowToLiveBetter",
  licence: "CC BY 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  syncedOriginCommit: "b4048d1",
  syncedTranslationCommit: "638506e",
  syncedOn: "2026-10-04",
};

/* ── THE SCOPE HEURISTIC ───────────────────────────────────────────────────
   LAW matches the vocabulary of a Chinese statute, filing or entitlement. It
   is deliberately narrow on generic words: "insurance" alone is global, while
   "medical insurance in China" is not, so the China-proximity alternatives at
   the end carry the generic nouns rather than the pattern list above them. */
const LAW = new RegExp([
  "条例", "国务院", "医保", "社保", "公积金",                 // untranslated terms that survive in Sources
  "hukou", "household registration", "gaokao",
  "Criminal Law", "Labou?r Contract Law", "Civil Code", "Public Security",
  "provident fund", "Regulations? on ", "Article \\d",
  "Ministry of ", "National Health Commission", "residence permit",
  "China.{0,40}(law|regulation|insurance|scheme|policy|subsidy|filing)",
  "(law|regulation|insurance|scheme|policy|subsidy|filing).{0,25}in China",
].join("|"), "i");
const CURRENCY = /\byuan\b|\bRMB\b|¥/i;

/* ── PARSER ────────────────────────────────────────────────────────────────
   Every entry is `### N. Title`, an HTML cost tag, then six `- Field:` bullets.
   Some entries separate the bullets with blank lines, so a field runs until the
   next field rather than the next newline. All 654 conform; the build asserts
   it rather than silently dropping a malformed one. */
const FIELDS = ["Cost", "In plain terms", "Benefit", "Evidence grade", "Sources", "Notes"];
const KEY = { "Cost": "cost", "In plain terms": "plain", "Benefit": "benefit",
              "Evidence grade": "grade", "Sources": "sources", "Notes": "notes" };

/** The cost tag: 钱 money, 时间 time, 毅力 willpower, 收益 payoff, 口径 measure. */
const FACET = {
  money:     { "0": "free", "少": "cheap", "中": "mid", "多": "dear" },
  time:      { "少": "minutes", "中": "hours", "多": "ongoing" },
  willpower: { "否": "none", "些": "some", "是": "hard" },
  payoff:    { "大": "big", "中": "mid", "小": "small" },
  measure:   { "死亡率": "mortality", "金钱": "money", "时间": "time", "自由": "freedom" },
};
const TAGKEY = { "钱": "money", "时间": "time", "毅力": "willpower", "收益": "payoff", "口径": "measure" };

export function parseTag(raw) {
  const out = {};
  for (const kv of String(raw).trim().split(/\s+/)) {
    const [k, v] = kv.split("=");
    const key = TAGKEY[k];
    if (key) out[key] = FACET[key][v] ?? v;
  }
  return out;
}

export function parseEntry(block, n) {
  const head = block.match(/^\s*(.+?)\s*\n/);
  const title = head ? head[1].trim() : "";
  const tagm = block.match(/<!--\s*成本标签:\s*(.*?)-->/);
  const facets = tagm ? parseTag(tagm[1]) : {};

  const body = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const f = FIELDS[i];
    const rest = FIELDS.slice(i + 1).map((x) => x.replace(/ /g, "\\s")).join("|");
    const re = new RegExp(`^\\s*-\\s*${f.replace(/ /g, "\\s")}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*-\\s*(?:${rest})\\s*[:：]|$)`, "m");
    const m = block.match(re);
    body[KEY[f]] = m ? m[1].replace(/\s*\n\s*/g, " ").trim() : "";
  }
  body.grade = (body.grade.match(/[ABC]/) || ["?"])[0];

  /* Scope is read from the advice, not the citations: a Cochrane review that
     happens to be indexed in a Chinese journal does not make wearing a helmet
     a Chinese regulation. Sources and Notes are therefore excluded. */
  const advice = [title, body.cost, body.plain, body.benefit].join("\n");
  const scope = LAW.test(advice) ? "cn" : CURRENCY.test(advice) ? "priced" : "global";

  return { n, title, scope, ...facets, ...body };
}

export function parseSection(file, text) {
  const num = Number(file.slice(0, 2));
  const slug = file.slice(3, -3);
  const h1 = text.match(/^#\s+(.+)$/m);
  /* The paragraph between the H1 and the first entry is the section's own
     framing — what it covers and how to read its numbers. Worth keeping. */
  const intro = (text.split(/\n###\s/)[0].split(/^#\s+.+$/m)[1] || "")
    .replace(/\[←[^\]]*\]\([^)]*\)/g, "").replace(/\s*\n\s*/g, " ").trim();

  const blocks = text.split(/\n###\s+\d+\.\s*/).slice(1);
  const entries = blocks.map((b, i) => parseEntry(b, i + 1));
  return { num, slug, title: (h1 ? h1[1] : slug).replace(/^\d+\.\s*/, ""), intro, entries };
}

export function build() {
  const files = readdirSync(SRC).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no source files in ${SRC}`);

  const sections = files.map((f) => parseSection(f, readFileSync(join(SRC, f), "utf8")));

  /* A section that parses to zero entries, or an entry missing a field the page
     prints, is a parser regression and must not ship as a short section. */
  for (const s of sections) {
    if (!s.entries.length) throw new Error(`section ${s.num} parsed to zero entries`);
    for (const e of s.entries) {
      for (const k of ["title", "cost", "plain", "benefit"]) {
        if (!e[k]) throw new Error(`section ${s.num} entry ${e.n} has no ${k}`);
      }
    }
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  /* Per-section files carry the full text. Fetched when a section is opened. */
  for (const s of sections) {
    writeFileSync(join(OUT, `${String(s.num).padStart(2, "0")}.json`), JSON.stringify(s));
  }

  /* The index carries everything the page needs to list, count, filter and
     search WITHOUT the bodies — titles and facets only. One request, ~110 KB. */
  const count = (p) => sections.reduce((n, s) => n + s.entries.filter(p).length, 0);
  const index = {
    version: 1,
    builtAt: new Date().toISOString(),
    source: SOURCE,
    totals: {
      sections: sections.length,
      entries: count(() => true),
      grade: { A: count((e) => e.grade === "A"), B: count((e) => e.grade === "B"), C: count((e) => e.grade === "C") },
      scope: { global: count((e) => e.scope === "global"), priced: count((e) => e.scope === "priced"), cn: count((e) => e.scope === "cn") },
      /* Free, no willpower, big payoff. The shortlist worth reading first. */
      highLeverage: count((e) => e.money === "free" && e.willpower === "none" && e.payoff === "big"),
    },
    sections: sections.map((s) => ({
      num: s.num, slug: s.slug, title: s.title, intro: s.intro,
      entries: s.entries.map((e) => ({
        n: e.n, title: e.title, scope: e.scope, grade: e.grade,
        money: e.money, time: e.time, willpower: e.willpower, payoff: e.payoff, measure: e.measure,
      })),
    })),
  };
  writeFileSync(join(OUT, "index.json"), JSON.stringify(index));
  return index;
}

if (import.meta.filename === process.argv[1]) {
  const i = build();
  const kb = (p) => Math.round(readFileSync(join(OUT, p)).length / 1024);
  console.log(`guide: ${i.totals.entries} entries in ${i.totals.sections} sections`);
  console.log(`  grade    A ${i.totals.grade.A}  B ${i.totals.grade.B}  C ${i.totals.grade.C}`);
  console.log(`  scope    global ${i.totals.scope.global}  priced-in-yuan ${i.totals.scope.priced}  china-specific ${i.totals.scope.cn}`);
  console.log(`  shortlist  ${i.totals.highLeverage} free / no-willpower / big-payoff`);
  console.log(`  index.json ${kb("index.json")} KB, ${i.totals.sections} section files`);
}
