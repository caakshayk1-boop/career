/**
 * validate.mjs — the gate between "the model said it" and "the page prints it".
 *
 * This is the most important file in the pipeline and the one with no AI in it.
 * Every check here is deterministic, free, and cannot be argued with, which is
 * exactly why validation is not a model call: a model asked "is this quotation
 * really in the transcript?" agrees with itself.
 *
 * THE CHECKS, and the specific failure each one catches:
 *
 *   grounding    the quotation is actually in the transcript. Catches the
 *                fabricated quote — the failure that would make the whole page
 *                worthless if it shipped even once.
 *   timestamp    the citation points at the passage it claims. Catches the
 *                plausible-but-wrong offset, which is worse than no timestamp
 *                because the reader clicks it and hears something else.
 *   non-echo     "why it matters" is not the idea in different words. Catches
 *                the most common way this product degrades into a summariser.
 *   duplication  two learnings are not the same idea. Catches the padded list.
 *   attribution  a "said" claim is quoted; an unquotable claim is demoted to
 *                interpretation rather than dropped.
 *
 * A learning that fails grounding is DROPPED. A learning that fails timestamp
 * is REPAIRED where the true position is unambiguous, and stripped of its
 * timestamp where it is not — a missing citation is honest, a wrong one is not.
 */
import { cfg } from "../config.mjs";
import { segmentAt } from "./chunk.mjs";

const STOP = new Set(("a an the and or but if of to in on at for with is are was were be been it its this that these those " +
  "you your they their we our i he she as from by not do does did so than then there here about into over " +
  "can could should would will just really very much more most some any what which who how why when").split(" "));

const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
const content = (s) => words(s).filter((w) => w.length > 2 && !STOP.has(w));

/** Fraction of a's content words that appear in b. Asymmetric on purpose: a
 *  short quotation inside a long segment should score 1.0, and it would not
 *  under Jaccard. */
function coverage(a, b) {
  const A = content(a);
  if (!A.length) return 0;
  const B = new Set(content(b));
  return A.filter((w) => B.has(w)).length / A.length;
}

/**
 * Does a run of consecutive content words from the quotation appear, in order,
 * in the candidate text?
 *
 * WHY COVERAGE ALONE IS NOT ENOUGH. Coverage is a bag of words, and a bag of
 * words cannot tell "he said the forecast is a commitment device" from a
 * sentence assembled out of the same vocabulary that nobody ever uttered — the
 * exact shape of a fabricated quote built from the surrounding context. Word
 * ORDER is what distinguishes them. A quotation that shares a four-word run
 * with the transcript was almost certainly copied from it; one that shares none
 * was almost certainly written.
 */
function hasOrderedRun(quote, text, n = 4) {
  const q = content(quote);
  if (q.length < n) return coverage(quote, text) >= 0.9; // too short to n-gram
  const hay = " " + content(text).join(" ") + " ";
  for (let i = 0; i + n <= q.length; i++)
    if (hay.includes(" " + q.slice(i, i + n).join(" ") + " ")) return true;
  return false;
}

/** Parse h:mm:ss / m:ss into seconds. Returns null, never NaN — NaN compares
 *  false against everything and would silently pass every range check. */
export function parseTs(s) {
  const m = String(s || "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
}

/**
 * Locate a quotation in the transcript.
 *
 * The model compresses when it quotes — it drops filler, joins two sentences,
 * fixes the grammar of speech. Requiring a byte-exact substring would reject
 * almost every genuine citation, so this scores content-word coverage over a
 * sliding window of segments. The window exists because a quoted sentence often
 * spans a caption boundary.
 *
 * TWO THINGS THIS GETS RIGHT that the obvious implementation does not:
 *
 *  · It returns the offset of the segment the quote STARTS in, not the start of
 *    the window that contains it. A three-segment window beginning 46 seconds
 *    before the quote scores just as well, and returning its start produces a
 *    citation that is confidently wrong — the reader clicks it and hears
 *    something else. That is worse than no timestamp.
 *  · It prefers the tightest match. A single segment scoring 1.0 always beats a
 *    three-segment window scoring 1.0.
 */
function locate(segments, quote) {
  let best = { score: 0, t: null, text: "", width: 99 };
  const consider = (score, width, startIdx, text) => {
    if (score < best.score || (score === best.score && width >= best.width)) return;
    best = { score, width, text, t: segments[anchor(segments, startIdx, width, quote)].t };
  };

  for (let i = 0; i < segments.length; i++) {
    let text = "";
    for (let w = 0; w < 3 && i + w < segments.length; w++) {
      text += (w ? " " : "") + segments[i + w].text;
      consider(coverage(quote, text), w, i, text);
    }
  }
  return best;
}

/** Within a matched window, which segment does the quote actually begin in?
 *  Scored on the quote's OPENING content words, because that is what fixes the
 *  start of the citation. */
function anchor(segments, startIdx, width, quote) {
  const head = content(quote).slice(0, 6).join(" ");
  let bestIdx = startIdx, bestScore = -1;
  for (let j = startIdx; j <= startIdx + width && j < segments.length; j++) {
    const sc = coverage(head, segments[j].text);
    if (sc > bestScore) { bestScore = sc; bestIdx = j; }
  }
  return bestScore > 0 ? bestIdx : startIdx;
}

export function validateLearnings(learnings, transcript, ep) {
  const segments = transcript.segments || [];
  const duration = transcript.durationSec || ep.durationSec || 0;
  const kept = [], rejected = [];
  const drop = (l, reason) => rejected.push({ headline: l.headline || "(no headline)", reason });

  for (const raw of learnings) {
    const l = { ...raw };

    /* ── shape ───────────────────────────────────────────────────────────── */
    for (const f of ["headline", "idea", "why"]) l[f] = String(l[f] || "").trim();
    l.action = String(l.action || "").trim();
    l.evidence = String(l.evidence || "").trim();
    l.kind = ["said", "interpretation", "recommendation"].includes(l.kind) ? l.kind : "interpretation";
    l.confidence = Number.isFinite(l.confidence) ? Math.min(1, Math.max(0, l.confidence)) : 0.5;

    if (!l.headline || !l.idea || !l.why) { drop(l, "missing headline, idea or why"); continue; }
    if (l.headline.length > 90) l.headline = l.headline.slice(0, 88).replace(/\s+\S*$/, "") + "…";

    /* ── non-echo ────────────────────────────────────────────────────────────
       If 80% of the content words in "why it matters" already appear in the
       idea, it is a restatement. That is the whole difference between this
       product and a summariser, so it is a rejection and not a warning. */
    if (coverage(l.why, l.idea) > 0.8 && content(l.why).length > 4) {
      drop(l, "“why it matters” restates the idea"); continue;
    }
    /* Filler actions are removed rather than rejected — the idea can be sound
       with nothing to do about it. */
    if (l.action && content(l.action).length < 3) l.action = "";
    if (/^(reflect|think about|consider|keep this in mind|remember)\b/i.test(l.action) && content(l.action).length < 6) l.action = "";

    /* ── grounding ───────────────────────────────────────────────────────── */
    const claimed = parseTs(l.timestamp);
    const found = l.evidence ? locate(segments, l.evidence) : { score: 0, t: null };

    /* Two independent signals, because they fail differently. Coverage catches
       a quotation about something the conversation never discussed; the ordered
       run catches one assembled from words it did discuss, in an order nobody
       said them in. A fabricated quote usually passes the first and fails the
       second. */
    const verbatim = Boolean(l.evidence) && found.score >= 0.55 && hasOrderedRun(l.evidence, found.text);

    if (l.kind === "said" && !verbatim) {
      /* A claim attributed to a person must be quotable. Below the bar it is
         DEMOTED, not deleted: the idea may still be worth printing, it just
         may not be presented as something the guest said. */
      if (found.score < 0.5) { drop(l, `quotation not found in the transcript (best match ${(found.score * 100) | 0}%)`); continue; }
      l.kind = "interpretation";
      l.confidence = Math.min(l.confidence, 0.6);
      l.demoted = true;
    }
    l.groundingScore = Math.round(found.score * 100) / 100;
    l.verbatim = verbatim;

    /* ── timestamp ────────────────────────────────────────────────────────── */
    if (claimed == null || (duration && claimed > duration + 120)) {
      /* Unusable as given. Use the located quotation's real offset if we have
         one; otherwise print no timestamp at all. */
      l.t = found.t != null && found.score >= 0.5 ? found.t : null;
      if (l.t != null) l.tRepaired = true;
    } else if (found.t != null && found.score >= 0.5) {
      const drift = Math.abs(found.t - claimed);
      /* 90 seconds is roughly one caption window plus the model's rounding. A
         larger drift means the timestamp belongs to a different passage, and
         the located quotation is the better citation. */
      l.t = drift <= 90 ? claimed : found.t;
      if (drift > 90) l.tRepaired = true;
    } else {
      l.t = claimed;
    }
    if (!transcript.timestamped) { l.t = null; l.tRepaired = false; }

    kept.push(l);
  }

  /* ── duplication ───────────────────────────────────────────────────────────
     Runs last, over survivors, so a duplicate is never kept in preference to
     the original because the original was dropped for another reason. Compares
     idea against idea: two entries can have different headlines and be the
     same claim, which is exactly what a padded list looks like. */
  const deduped = [];
  for (const l of kept) {
    const twin = deduped.find((k) => coverage(l.idea, k.idea) > 0.72 || coverage(l.headline, k.headline) > 0.85);
    if (twin) { rejected.push({ headline: l.headline, reason: `duplicate of “${twin.headline}”` }); continue; }
    deduped.push(l);
  }

  deduped.sort((a, b) => a.rank - b.rank);
  deduped.forEach((l, i) => { l.rank = i + 1; });

  return { learnings: deduped, rejected };
}

/**
 * Episode-level verdict. Returns the state the episode should be recorded in.
 *
 * NEEDS_REVIEW rather than REJECTED where a human might disagree: an episode
 * that produced four strong learnings is not a pipeline failure, it is a short
 * episode, and silently deleting it hides a signal worth seeing. Nothing in
 * NEEDS_REVIEW is published.
 */
export function verdict({ learnings, rejected }, quality) {
  const problems = [];
  if (!quality.ok) problems.push(...quality.problems);
  if (learnings.length < cfg.minLearnings)
    problems.push(`only ${learnings.length} learnings survived validation (floor is ${cfg.minLearnings})`);

  const total = learnings.length + rejected.length;
  if (total >= 6 && rejected.length / total > 0.5)
    problems.push(`${rejected.length} of ${total} candidates failed validation`);

  const grounded = learnings.filter((l) => l.verbatim).length;
  if (learnings.length >= 4 && grounded / learnings.length < 0.5)
    problems.push("fewer than half the learnings are quotable from the source");

  return { status: problems.length ? "NEEDS_REVIEW" : "READY", problems };
}
