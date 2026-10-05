/**
 * The weekly read.
 *
 * Picks one book from pipeline/books/shelf.json, writes a summary of it, and
 * appends it to public/reads.json. One book a week, archived forever.
 *
 * WHAT THIS DELIBERATELY DOES NOT PRODUCE, AND WHY.
 * The format this was modelled on asks for a chapter-by-chapter retelling
 * "so detailed that after reading it I feel like I have read the entire book",
 * and "do not summarize, give me the full depth". Published on a public URL
 * for books still in copyright, that is not a summary — it is a substitute for
 * the book, which is the one thing a summary may not be. Every title on this
 * shelf is in copyright and most are under five years old.
 *
 * So the schema below asks for the argument, the ideas, what to DO about them,
 * and where the book is weak. That is commentary and criticism: lawful, and
 * more useful than a retelling, because the part worth keeping from a 300-page
 * business book was never the chapter order.
 *
 * THE PICK IS DETERMINISTIC, NOT RANDOM. A real random pick repeats and
 * stalls. This hashes the ISO week, so the choice is stable all week — run it
 * five times and it is the same book, which is what makes it idempotent — and
 * it draws only from titles never read before, so the shelf cycles cleanly and
 * nothing is read twice until everything has been read once.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../config.mjs";
import { log } from "../lib/log.mjs";
import { makeAI } from "../lib/ai.mjs";

const ROOT   = join(import.meta.dirname, "../..");
const SHELF  = join(import.meta.dirname, "shelf.json");
const OUT    = join(ROOT, "public/reads.json");

/** ISO week key, e.g. "2026-W40". The unit of publication. */
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));          // Thursday decides the year
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

/** Stable hash so a week always picks the same book from the same shelf. */
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The candidates: enabled, in-period, over the bar, and not read before. */
export function eligible(shelf, readIds = []) {
  const seen = new Set(readIds);
  return shelf.books.filter((b) =>
    b.enabled !== false &&
    b.published >= shelf.minPublished &&
    (b.rating ?? 0) >= shelf.minRating &&
    !seen.has(b.id));
}

export function pick(shelf, readIds, week) {
  let pool = eligible(shelf, readIds);
  /* THE SHELF CYCLES RATHER THAN ENDING. Twenty-two books is five months; the
     alternative to starting again is a page that stops one Monday with no
     explanation. */
  if (!pool.length) pool = eligible(shelf, []);
  if (!pool.length) return null;
  return pool[hash(week) % pool.length];
}

/* Ratings cannot be checked from a datacentre address — Google Books answers a
   shared CI IP with 429 and Open Library is unreachable, the same wall the
   podcast pipeline hit with YouTube. From a home connection it answers fine,
   so the number is confirmed at run time rather than trusted from the file. */
export async function verifyRating(book) {
  const q = `intitle:${encodeURIComponent(book.title.split(":")[0])}+inauthor:${encodeURIComponent(book.author.split(",")[0])}`;
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5`,
      { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const d = await res.json();
    for (const it of d.items || []) {
      const v = it.volumeInfo || {};
      if (v.averageRating) return { ok: true, rating: v.averageRating, count: v.ratingsCount || 0, scale: 5 };
    }
    return { ok: false, reason: "no rating published for this title" };
  } catch (e) { return { ok: false, reason: String(e.message || e).slice(0, 80) }; }
}

/* ── WHO THIS IS WRITTEN FOR ───────────────────────────────────────────────
   A briefing addressed to nobody reads like a blurb. Naming the reader is what
   turns "build better habits" into "the fourth consecutive month you rebuilt
   the same variance commentary by hand". The model cannot write the second
   without being told who is reading, and the second is the only version worth
   publishing. */
const READER = `
The reader is a Chartered Accountant working as an FP&A manager in a
multi-entity retail and hospitality group, based in Malaysia, interviewing for
Financial Controller and Head of FP&A roles in the UAE and Malaysia. His week
contains month-end close, board packs, variance commentary, forecast cycles,
budget negotiations with commercial teams, interviews, and managing a small
finance team. He reads non-fiction to decide something, not to feel motivated.
`.trim();

const SCHEMA = {
  type: "object",
  properties: {
    hook: {
      type: "string",
      description: "2-3 sentences opening on a concrete situation the book is about. Start in the middle of something happening — a decision, a failure, a specific moment. Never open with 'In today's world', 'Imagine', 'We all know' or a definition.",
    },
    coreArgument: { type: "string", description: "The book's central claim in one sentence, as a claim that could be wrong" },
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string", description: "3-8 words naming the idea. A claim, not a topic: 'Failure has three causes, only one worth analysing', not 'Types of failure'." },
          explain: { type: "string", description: "3-5 sentences, plain language. Every term defined the first time it appears. Say what the idea asserts and why the book thinks it is true." },
          bookExample: {
            type: "string",
            description: "The case, study, company or person the BOOK ITSELF uses to make this point, named in 1-2 sentences, with what it showed. If you are not confident the book uses a specific example here, return an empty string. Never invent one and never attribute a story to the book that you are unsure of.",
          },
          yourWeek: {
            type: "string",
            description: "2-3 sentences showing this idea inside THIS READER's actual work — month-end close, a board pack, a forecast miss, a budget argument with a commercial team, an interview, a team member underperforming. Concrete and specific. This is your own illustration, NOT from the book, so do not describe it as the author's example.",
          },
          apply: { type: "string", description: "One concrete action, doable inside one week, that a reader would know they had done or not done. Name the artefact or the conversation, not the intention." },
          tradeoff: { type: "string", description: "What this costs, or the situation where following it is the wrong call. Every real technique has one. If the book does not acknowledge it, say that." },
        },
        required: ["heading", "explain", "bookExample", "yourWeek", "apply", "tradeoff"],
        additionalProperties: false,
      },
    },
    misreading: { type: "string", description: "The most common wrong takeaway from this book — the version people quote that the book does not actually support" },
    oneThing:   { type: "string", description: "If the reader does exactly one thing from this book, this is it, and in one sentence why this one" },
    whoFor:     { type: "string", description: "Who gets the most from this, and who should skip it. Be willing to say skip." },
    limits:     { type: "string", description: "Where the book overreaches, what its evidence does not support, which population its cases come from" },
    verdict:    { type: "string", description: "Read it, skim it, or skip it — and why. Pick one of those three words." },
    readNext:   { type: "array", items: { type: "string" }, description: "Three books that complement it, each with a few words on what it adds" },
  },
  required: ["hook", "coreArgument", "ideas", "misreading", "oneThing", "whoFor", "limits", "verdict", "readNext"],
};

const SYSTEM = `
You are writing a critical reader's briefing on a non-fiction book for one
named reader, described below. He has not read it and is deciding whether to.

WHAT THIS IS NOT. It is not a chapter-by-chapter retelling and it is not a
replacement for the book. Do not walk the contents page. Do not reproduce long
passages or retell the book's stories at length. The book is in copyright and
the reader is expected to buy it if the briefing persuades them.

WHAT IT IS. The argument, the handful of ideas that carry it, what each one
looks like in this reader's actual week, what to DO about it, what it costs,
and — the part most summaries omit — where the book is weak. A briefing that
only praises is an advertisement.

FIVE TO SEVEN IDEAS, EACH ONE DEEP, rather than ten shallow ones. Each must be
a claim the book actually makes, not a generic observation about the topic.

THE TWO EXAMPLE FIELDS ARE DIFFERENT THINGS AND MUST NOT BE CONFUSED.
"bookExample" is the author's own case, study or person, and must be real: if
you are not confident the book uses a specific example for that idea, return an
empty string. An invented anecdote attributed to the author is the single worst
failure available to you here. "yourWeek" is YOUR illustration, set in the
reader's work, and is openly your own — write it as a scenario, never as
something the author wrote.

WRITE LIKE A COLLEAGUE EXPLAINING OVER COFFEE. Short sentences. Concrete nouns.
Specific numbers where the book gives them. Define any term the first time it
appears. No motivational register, no "in today's fast-paced world", no
exclamation marks, no rhetorical questions, no "game-changer", no "unlock".

<reader>
${READER}
</reader>
`.trim();

export async function brief(ai, book) {
  return ai.json({
    system: SYSTEM,
    user: `<book>${book.title}</book>\n<author>${book.author}</author>\n<published>${book.published}</published>\n<category>${book.category}</category>\n<why_on_the_shelf>${book.why}</why_on_the_shelf>`,
    schema: SCHEMA, name: "record_brief",
    /* Six fields per idea across seven ideas is roughly double the old output,
       and a reasoning model bills its hidden tokens to this budget — the
       podcast pipeline learned that the expensive way. */
    effort: "high", maxTokens: 16000,
  });
}

/* The paths are arguments with the real files as defaults, so the suite can run
   the whole job against a temp artifact. A job that can only be exercised by
   dispatching it in CI gets exercised in CI — which is where the missing
   `await` below was found, by a human, on the first live run. */
export async function main({ shelfPath = SHELF, out = OUT, now = new Date(), force = false } = {}) {
  const shelf = JSON.parse(readFileSync(shelfPath, "utf8"));
  const prev  = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { reads: [] };
  const reads = prev.reads || [];
  const week  = isoWeek(now);

  /* `force` replaces this week's edition in place rather than appending a
     second one. Used when the briefing FORMAT changes and the week's edition
     was written to the old shape — the archive keeps every week, not every
     draft of a week. */
  if (force) {
    const i = reads.findIndex((r) => r.week === week);
    if (i >= 0) { log.info("books", `rewriting ${week} — "${reads[i].title}"`); reads.splice(i, 1); }
  }
  if (reads.some((r) => r.week === week)) {
    log.info("books", `${week} already published "${reads.find((r) => r.week === week).title}" — nothing to do`);
    return { skipped: true };
  }

  const book = pick(shelf, reads.map((r) => r.id), week);
  if (!book) { log.fail("books", "shelf", "no eligible book on the shelf"); return { failed: true }; }
  log.stage("books", `${week}: ${book.title} — ${book.author}`);

  const v = await verifyRating(book);
  if (v.ok) log.info("books", `rating confirmed ${v.rating}/5 from ${v.count} ratings`);
  else      log.warn("books", `rating not confirmed (${v.reason}) — the page will say so`);

  /* makeAI() is async — the provider loads its SDK on demand. Calling it
     without await hands back a Promise, and `ai.json is not a function` is
     what that looks like at the far end. pipeline/run.mjs awaits it too. */
  const ai = await makeAI();
  const b  = await brief(ai, book);

  /* A provider that answers with the wrong shape must not be able to publish a
     blank edition. Groq's strict tool schema should make this unreachable, but
     salvageToolArguments() exists precisely because the wrong shape does come
     back sometimes, and an edition with no ideas is worse than no edition. */
  if (!Array.isArray(b?.ideas) || b.ideas.length < 3 || !b.coreArgument) {
    log.fail("books", "brief", `the model returned ${Array.isArray(b?.ideas) ? b.ideas.length : "no"} ideas — not publishing`);
    return { failed: true };
  }

  /* THE INSTRUCTION TO RETURN "" DID NOT HOLD, SO IT IS NOT RELIED ON.
     Asked for the author's own case and told to answer with an empty string
     when unsure, the first real edition filled 5 of 5 — three of them with a
     specific percentage. A 20B-class model asked for a named example produces
     one whether or not the author wrote it, and "Galloway describes a firm
     that reduced processing time by 40%" is exactly the sentence that gets
     repeated in an interview as fact.

     Self-reported confidence cannot fix that, so none is asked for. Every book
     case is treated as unverified recollection, always, and the ones carrying
     a hard figure are marked separately, because an invented number is the
     quotable kind. The page renders both; this only records them. */
  const FIGURE = /\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?per ?cent|[$£€]\s?\d|\b(?:USD|AED|RM|MYR)\s?\d/i;
  const ideas = (b.ideas || []).map((i) => ({ ...i, bookExampleHasFigure: FIGURE.test(i.bookExample || "") }));
  const withCase = ideas.filter((i) => i.bookExample).length;
  const withFigure = ideas.filter((i) => i.bookExampleHasFigure).length;
  log.info("books", `${withCase}/${ideas.length} ideas cite a case from the book, ${withFigure} with a figure — all marked unverified`);
  if (withFigure) log.warn("books", `${withFigure} book case(s) quote a statistic this pipeline cannot check against the book`);

  reads.unshift({
    week, id: book.id, title: book.title, author: book.author,
    published: book.published, category: book.category,
    rating: v.ok ? v.rating : book.rating,
    ratingSource: v.ok ? "googlebooks" : "unverified",
    ratingCount: v.ok ? v.count : null,
    publishedAt: new Date().toISOString(),
    ...b,
    ideas,
  });

  writeFileSync(out, JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    week,
    shelfSize: shelf.books.filter((x) => x.enabled !== false).length,
    readCount: reads.length,
    reads,
  }, null, 1) + "\n");
  log.stage("books", `published ${b.ideas.length} ideas — ${reads.length} in the archive`);
  return { book: book.id, ideas: b.ideas.length };
}

if (import.meta.filename === process.argv[1]) {
  main({ force: process.argv.includes("--force") }).catch((e) => { log.fail("books", "run", e.message); process.exit(1); });
}
