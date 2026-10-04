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

const SCHEMA = {
  type: "object",
  properties: {
    coreArgument: { type: "string", description: "The book's central claim in one sentence" },
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string", description: "3-8 words naming the idea" },
          explain: { type: "string", description: "2-4 sentences, plain language, no jargon left undefined" },
          apply:   { type: "string", description: "one concrete thing a reader can do this week" },
        },
        required: ["heading", "explain", "apply"],
        additionalProperties: false,
      },
    },
    whoFor:   { type: "string", description: "who gets the most from this, and who should skip it" },
    limits:   { type: "string", description: "where the book overreaches, what the evidence does not support" },
    verdict:  { type: "string", description: "read it, skim it, or skip it — and why" },
    readNext: { type: "array", items: { type: "string" }, description: "three books that complement it" },
  },
  required: ["coreArgument", "ideas", "whoFor", "limits", "verdict", "readNext"],
};

const SYSTEM = `
You are writing a critical reader's briefing on a non-fiction book for someone
who has not read it and is deciding whether to.

WHAT THIS IS NOT. It is not a chapter-by-chapter retelling and it is not a
replacement for the book. Do not walk the contents page. Do not reproduce long
passages. The book is in copyright and the reader is expected to buy it if the
briefing persuades them.

WHAT IT IS. The argument, the handful of ideas that carry it, what a reader
should DO differently, and — this is the part most summaries omit — where the
book is weak. A briefing that only praises is an advertisement.

Six to ten ideas. Each one must be a claim the book actually makes, not a
generic observation about the topic. If you are unsure the book makes a claim,
leave it out rather than inventing it.

Plain English. Define any term the first time it appears. No motivational
register, no "in today's fast-paced world", no exclamation marks.
`.trim();

export async function brief(ai, book) {
  return ai.json({
    system: SYSTEM,
    user: `<book>${book.title}</book>\n<author>${book.author}</author>\n<published>${book.published}</published>\n<category>${book.category}</category>\n<why_on_the_shelf>${book.why}</why_on_the_shelf>`,
    schema: SCHEMA, name: "record_brief",
    description: "Record the briefing on this book.",
    effort: "high", maxTokens: 8000,
  });
}

export async function main() {
  const shelf = JSON.parse(readFileSync(SHELF, "utf8"));
  const prev  = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { reads: [] };
  const reads = prev.reads || [];
  const week  = isoWeek();

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

  const ai = makeAI();
  const b  = await brief(ai, book);

  reads.unshift({
    week, id: book.id, title: book.title, author: book.author,
    published: book.published, category: book.category,
    rating: v.ok ? v.rating : book.rating,
    ratingSource: v.ok ? "googlebooks" : "unverified",
    ratingCount: v.ok ? v.count : null,
    publishedAt: new Date().toISOString(),
    ...b,
  });

  writeFileSync(OUT, JSON.stringify({
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
  main().catch((e) => { log.fail("books", "run", e.message); process.exit(1); });
}
