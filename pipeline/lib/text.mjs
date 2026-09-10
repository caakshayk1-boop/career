/**
 * text.mjs — the word-level primitives, in one place.
 *
 * These were living inside validate.mjs, which was fine while validation was
 * the only thing that needed them. The extractive engine needs the same notion
 * of "content word" and the same overlap measure, and two copies of a stopword
 * list drift within a month — one of them gets a fix and the other does not,
 * and then the deduper and the extractor disagree about what a duplicate is.
 */

const STOP = new Set(("a an the and or but if of to in on at for with is are was were be been being am it its this that these those " +
  "you your yours they their them we our us i me my he she his her as from by not no nor do does did done so than then " +
  "there here about into over under out up down off again further once when where why how what which who whom whose " +
  "can could should would will shall may might must just really very much more most some any all both each few other " +
  "such only own same too also like get got go going went say said says one two like yeah yes okay ok right well " +
  "actually basically literally obviously kind sort thing things stuff lot lots").split(" "));

export const words = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);

/** Words that carry meaning: long enough, not a stopword, not a bare number. */
export const content = (s) => words(s).filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Fraction of a's content words that appear in b.
 *
 * ASYMMETRIC ON PURPOSE. A short quotation sitting inside a long passage should
 * score 1.0 — it is entirely contained. Jaccard would score it low because the
 * passage has words the quotation does not, which is exactly the wrong answer
 * when the question is "did they say this?".
 */
export function coverage(a, b) {
  const A = content(a);
  if (!A.length) return 0;
  const B = new Set(content(b));
  return A.filter((w) => B.has(w)).length / A.length;
}

/**
 * Does a run of consecutive content words from `quote` appear, in order, in
 * `text`? Word ORDER is what separates a real quotation from a sentence
 * assembled out of the same vocabulary.
 */
export function hasOrderedRun(quote, text, n = 4) {
  const q = content(quote);
  if (q.length < n) return coverage(quote, text) >= 0.9;
  const hay = " " + content(text).join(" ") + " ";
  for (let i = 0; i + n <= q.length; i++)
    if (hay.includes(" " + q.slice(i, i + n).join(" ") + " ")) return true;
  return false;
}

/** Seconds → 4:37 or 1:04:37. */
export function hhmmss(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
