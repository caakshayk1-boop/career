/**
 * extractive.mjs — 10 to 20 takeaway points from a transcript, for nothing.
 *
 * NO MODEL RUNS HERE. Every point is a sentence somebody actually said, chosen
 * from the transcript rather than written about it. That is a real constraint
 * and a real guarantee, in that order:
 *
 *   The constraint — there is no interpretation. This cannot tell you why a
 *   point matters, because saying why would mean generating text, and
 *   generating text is the thing that costs money and invents things. What you
 *   get is the twenty sentences from two hours that carry the most information,
 *   not an essay about them.
 *
 *   The guarantee — fabrication is structurally impossible. A point IS its
 *   evidence. Its timestamp is the timestamp of the words. There is no gap
 *   between what the page prints and what was said for an error to live in.
 *
 * HOW SENTENCES ARE SCORED. Nine signals, each of which is a cheap proxy for
 * "a stranger would want to know this". They are summed, not multiplied: a
 * sentence should be able to earn its place on one strong signal (a hard
 * number) rather than needing all of them.
 *
 * The single most important one is not in the list — it is what gets REMOVED
 * first. A podcast transcript is mostly questions, agreement noises, and
 * restatement. Cutting those is worth more than any amount of clever ranking
 * over what is left.
 */
import { content, coverage, hhmmss } from "./text.mjs";

/* ── SIGNALS ───────────────────────────────────────────────────────────────
   Weights are deliberately blunt integers. Fractional tuning here is fitting
   noise: the difference between a good point and a bad one is usually two or
   three signals, not a 0.15 adjustment to one. */

const SIGNALS = [
  /* Specificity. A number is the most reliable single indicator that a
     sentence carries information rather than sentiment. */
  { w: 3.0, re: /\b\d+(\.\d+)?\s*(%|percent|per cent|x|times|basis points|bps)\b/i, why: "quantified" },
  { w: 2.2, re: /[$£€]\s?\d|\b\d+\s*(million|billion|thousand|k\b|m\b|bn\b)/i, why: "money" },
  { w: 1.6, re: /\b(\d+|one|two|three|four|five|six|seven|ten|twenty)\s+(years?|months?|weeks?|days?|hours?|people|companies|times)\b/i, why: "magnitude" },

  /* Causal structure. "X because Y" and "which means Z" are where a claim
     stops being an observation and becomes a mechanism. */
  { w: 2.4, re: /\b(because|which means|the reason (is|was|why)|so that|therefore|as a result|that's why|leads to|causes)\b/i, why: "causal" },

  /* Correction and contrast. The highest-value thing in an interview is
     usually the moment the guest disagrees with the obvious answer. */
  { w: 2.6, re: /\b(most people (think|believe|assume)|contrary to|the opposite|counterintuitive|actually,|in fact,|but the truth|what nobody|the mistake|got (it )?wrong|turns out)\b/i, why: "counterintuitive" },

  /* Rules, frameworks and definitions — the things that transfer to another
     situation, which is the whole point of listening to somebody else's. */
  { w: 2.0, re: /\b(the rule (is|was)|the key (is|was)|what matters is|the way to|the trick is|I (always|never)|you (have to|need to|should)|the question (I|to) ask)\b/i, why: "rule" },
  { w: 1.4, re: /\b(is defined as|means that|is really about|is not|isn't about|the difference between)\b/i, why: "definition" },

  /* Enumeration. "Three things" almost always introduces a list worth having. */
  { w: 1.5, re: /\b(first(ly)?|second(ly)?|third(ly)?|two things|three things|the first|the second)\b/i, why: "enumerated" },

  /* Personal specificity — a concrete lived example rather than a generality. */
  { w: 1.2, re: /\b(I (learned|realised|realized|discovered|changed|stopped|started)|we (tried|built|shipped|cut|hired))\b/i, why: "concrete" },
];

/* Sentences that are structurally not takeaways, however well they score. A
   question is the host's job, not the guest's insight; agreement noise is
   conversational glue. These are removed before scoring, not penalised during
   it — a heavily-penalised sentence can still win, and none of these should
   ever be able to. */
const NEVER = [
  /^\s*(so|and|but|well|right|yeah|yes|no|ok|okay|sure|exactly|totally|absolutely|interesting|amazing|wow|ha)\b[\s,.!?]*$/i,
  /^\s*(thank you|thanks|thanks for having me|welcome back|welcome to|let's take a break|we're back|good to be here|my pleasure)\b/i,
  /^\s*(you know what I mean|I mean|kind of|sort of|that's fair|that makes sense|say more|tell me about)\b/i,
];

/* Filler that should cost a sentence its place if it dominates it. */
const FILLER = /\b(you know|I mean|kind of|sort of|like,|sort of like|right\?|you know what I mean|um|uh|er)\b/gi;

/**
 * Split segments into sentences that each keep an honest offset.
 *
 * A segment often holds several sentences and one timestamp. Assigning the
 * segment's start to all of them would put a citation up to a minute early on a
 * long caption, so the offset is interpolated across the segment by character
 * position — the same approximation the segment itself already is.
 */
export function sentences(segments) {
  const out = [];
  for (const seg of segments) {
    const parts = seg.text.match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g) || [seg.text];
    const total = seg.text.length || 1;
    let offset = 0;
    for (const raw of parts) {
      const text = raw.trim();
      const at = offset;
      offset += raw.length;
      if (text.length < 25) continue;
      out.push({
        text,
        t: Math.round(seg.t + (seg.d || 0) * (at / total)),
        speaker: seg.speaker || "",
        segT: seg.t,
      });
    }
  }
  return out;
}

/**
 * Which speaker is the host?
 *
 * The one who asks the questions. On a two-hander the host talks less and ends
 * more sentences with a question mark, and both signals point the same way. It
 * matters because a host's framing is not the guest's claim, and the most
 * quotable-sounding line in an interview is often the interviewer's.
 *
 * Returns "" when there is no diarisation, in which case nothing is weighted.
 */
export function findHost(sents) {
  const by = new Map();
  for (const s of sents) {
    if (!s.speaker) continue;
    const r = by.get(s.speaker) || { chars: 0, questions: 0, n: 0 };
    r.chars += s.text.length;
    r.n++;
    if (/\?\s*$/.test(s.text)) r.questions++;
    by.set(s.speaker, r);
  }
  if (by.size !== 2) return "";
  const [a, b] = [...by.entries()];
  const rate = ([, r]) => (r.n ? r.questions / r.n : 0);
  /* Question rate first; word count as the tie-break, because a guest who asks
     the host a couple of questions should not flip the decision. */
  if (Math.abs(rate(a) - rate(b)) > 0.08) return rate(a) > rate(b) ? a[0] : b[0];
  return a[1].chars < b[1].chars ? a[0] : b[0];
}

function score(sent, vocab, host, duration) {
  const text = sent.text;

  /* A question is not a takeaway. This is a hard exclusion, not a penalty. */
  if (/\?\s*$/.test(text)) return null;
  if (NEVER.some((re) => re.test(text))) return null;

  const cw = content(text);
  if (cw.length < 6) return null;                 // too thin to say anything
  if (text.length > 420) return null;             // a run-on, not a point

  let s = 0;
  const why = [];
  for (const sig of SIGNALS) if (sig.re.test(text)) { s += sig.w; why.push(sig.why); }

  /* Centrality: how much of this sentence's vocabulary recurs across the whole
     conversation. The classic extractive signal — a sentence about what the
     episode keeps returning to is more likely to be the point of it. */
  const central = cw.filter((w) => (vocab.get(w) || 0) > 2).length / cw.length;
  s += central * 2.4;

  /* Information density: distinct content words per word. Rewards a sentence
     that says several things over one that says one thing at length. */
  s += (new Set(cw).size / Math.max(8, text.split(/\s+/).length)) * 2.0;

  /* Length band. Under ~12 words there is rarely a complete idea; past ~45 the
     sentence stops being scannable, which is the entire product here. */
  const wc = text.split(/\s+/).length;
  if (wc >= 12 && wc <= 45) s += 1.0; else if (wc < 9 || wc > 60) s -= 1.2;

  /* Filler, proportionally. */
  const filler = (text.match(FILLER) || []).length;
  s -= filler * 0.9;

  /* The host frames, the guest claims. Only applied when diarisation told us
     who is who — guessing would systematically demote the wrong person. */
  if (host && sent.speaker === host) s -= 1.6;

  /* Openings and sign-offs. The first and last few minutes of a podcast are
     introductions, credentials and thanks. */
  if (duration) {
    const pos = sent.t / duration;
    if (pos < 0.03 || pos > 0.97) s -= 2.0;
  }

  return s > 0 ? { ...sent, score: s, signals: why } : null;
}

/**
 * Pick the points.
 *
 * @param {object[]} segments  noise-stripped, timestamped
 * @param {object} opts
 * @param {number} opts.min    floor — below this the episode is not worth publishing
 * @param {number} opts.max    ceiling
 * @param {number} opts.duration
 */
export function takeaways(segments, { min = 10, max = 20, duration = 0 } = {}) {
  const sents = sentences(segments);
  if (sents.length < min * 2) return { points: [], reason: `only ${sents.length} usable sentences` };

  /* Corpus vocabulary, for the centrality term. */
  const vocab = new Map();
  for (const s of sents) for (const w of new Set(content(s.text))) vocab.set(w, (vocab.get(w) || 0) + 1);

  const host = findHost(sents);
  const scored = sents.map((s) => score(s, vocab, host, duration)).filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { points: [], reason: "no sentence scored above zero" };

  /* SPREAD ACROSS THE CONVERSATION, then rank within that.

     Taking the global top 20 reliably returns 20 sentences from the same
     fifteen minutes — whichever stretch happened to be dense — and silently
     drops the other ninety. Bucketing the episode by time and taking the best
     from each bucket in rotation covers the whole conversation, which is what a
     reader assumes a list of takeaways does. */
  const span = duration || (sents[sents.length - 1]?.t ?? 0) || 1;
  const buckets = Math.min(max, 10);
  const byBucket = new Map();
  for (const s of scored) {
    const b = Math.min(buckets - 1, Math.floor((s.t / span) * buckets));
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(s);
  }

  const picked = [];
  const isDuplicate = (cand) => picked.some((p) =>
    coverage(cand.text, p.text) > 0.62 || coverage(p.text, cand.text) > 0.62);

  /* Round-robin over the buckets so early rounds spread wide and later rounds
     top up from wherever the strongest material actually is. */
  for (let round = 0; picked.length < max && round < 40; round++) {
    let took = 0;
    for (let b = 0; b < buckets && picked.length < max; b++) {
      const list = byBucket.get(b);
      if (!list || !list.length) continue;
      /* Advance past anything that has become a duplicate since last round. */
      while (list.length && isDuplicate(list[0])) list.shift();
      if (!list.length) continue;
      picked.push(list.shift());
      took++;
    }
    if (!took) break;
  }

  if (picked.length < min) return { points: [], reason: `only ${picked.length} distinct points (floor is ${min})` };

  /* CHRONOLOGICAL, not ranked. The selection is by score; the presentation
     follows the conversation, because a reader going top to bottom is following
     an argument that was made in an order. A score-ordered list of twenty
     context-free sentences reads as noise even when every one is good. */
  picked.sort((a, b) => a.t - b.t);

  return {
    points: picked.map((p, i) => ({
      rank: i + 1,
      point: pill(p.text),
      detail: p.text,
      /* "Expand to read in detail" has to show MORE than the line already on
         screen, or the expansion is a no-op that costs a tap. The passage is
         the sentence back in the conversation it came from — which is also the
         only way to tell whether a point means what it appears to mean. */
      passage: passageAt(segments, p.segT),
      t: p.t,
      speaker: p.speaker,
      isHost: Boolean(host && p.speaker === host),
      score: Math.round(p.score * 100) / 100,
      signals: p.signals,
    })),
    host,
    considered: sents.length,
    scored: scored.length,
  };
}

/**
 * The scannable line.
 *
 * Speech opens with connective tissue that carries no meaning on the page —
 * "So", "And I think", "You know, the thing is". Stripping it is the single
 * biggest readability win available without rewriting the sentence, and
 * stripping is not rewriting: every word that remains is still theirs, in
 * order. Nothing is added, so nothing can be invented.
 */
export function pill(text, limit = 155) {
  let s = String(text).trim()
    .replace(/^(?:(?:and|so|but|well|now|okay|ok|right|yeah|yes|look|see|i mean|you know|the thing is|here's the thing|to be honest|honestly|basically|actually)[\s,]+)+/i, "")
    .replace(FILLER, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();

  if (!s) s = String(text).trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);

  if (s.length <= limit) return s;
  /* Prefer a clause boundary inside the limit; fall back to a word boundary.
     Never cut mid-word — a truncated word reads as corruption, not brevity. */
  const window = s.slice(0, limit);
  const clause = Math.max(window.lastIndexOf(" — "), window.lastIndexOf(", "), window.lastIndexOf("; "));
  const cut = clause > limit * 0.55 ? clause : window.lastIndexOf(" ");
  return s.slice(0, cut > 0 ? cut : limit).replace(/[,;:\s]+$/, "") + "…";
}

/**
 * The surrounding passage: the segment a point came from, plus enough either
 * side to read as speech rather than a fragment.
 *
 * Bounded by BOTH a character budget and a time window. Character budget alone
 * pulls in three minutes of terse back-and-forth; time window alone pulls in a
 * wall of text when somebody is monologuing. The point's own segment is always
 * included even if it alone blows the budget.
 */
export function passageAt(segments, segT, { chars = 900, seconds = 75 } = {}) {
  const i = segments.findIndex((s) => s.t === segT);
  if (i === -1) return "";

  const out = [segments[i]];
  let size = segments[i].text.length;
  let lo = i, hi = i;

  /* Grow outwards, preferring whichever side is closer in time, so the passage
     stays centred on the point rather than drifting forward. */
  for (;;) {
    const prev = lo > 0 ? segments[lo - 1] : null;
    const next = hi < segments.length - 1 ? segments[hi + 1] : null;
    const canPrev = prev && segT - prev.t <= seconds && size + prev.text.length <= chars;
    const canNext = next && next.t - segT <= seconds && size + next.text.length <= chars;
    if (!canPrev && !canNext) break;
    const takePrev = canPrev && (!canNext || segT - prev.t <= next.t - segT);
    const seg = takePrev ? prev : next;
    if (takePrev) { out.unshift(seg); lo--; } else { out.push(seg); hi++; }
    size += seg.text.length;
  }

  return out.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
}

/** A one-paragraph description of the episode, assembled from the points that
 *  were chosen. Not a generated summary — a statement of what is in the list. */
export function describe(points, ep) {
  const span = points.length ? `${hhmmss(points[0].t)}–${hhmmss(points[points.length - 1].t)}` : "";
  return `${points.length} points taken verbatim from ${ep.show}${span ? `, spanning ${span}` : ""}. ` +
    `Selected from the transcript by information density — every line below is what was said, not a description of it.`;
}
