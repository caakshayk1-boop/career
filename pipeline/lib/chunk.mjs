/**
 * chunk.mjs — a 2-hour transcript into passes a model can actually read.
 *
 * The instruction "do not send a 3-hour transcript in one request" is usually
 * justified by context limits. That is the least important reason. The real one
 * is attention: given 300k characters and asked for ten ideas, a model reliably
 * over-weights the first and last ten minutes and returns a summary of the
 * introduction. Chunking forces uniform coverage — every part of the
 * conversation gets its own pass and competes on merit in the merge.
 *
 * WHAT IS PRESERVED, and why each matters:
 *   timestamp — the citation. Without it a learning is an unsourced claim.
 *   speaker   — "the guest said" vs "the host said" is the difference between
 *               a claim and a question. Losing it produces cards that credit
 *               the guest with the host's framing.
 *   continuity— chunks overlap, because the best ideas in a long conversation
 *               are built over several minutes and a hard cut mid-argument
 *               yields half an idea, twice.
 */
import { cfg } from "../config.mjs";

/** Seconds → 04:37 or 1:04:37. Used in prompts and on the page, so it lives in
 *  one place; two implementations drift and the page then disagrees with the
 *  citation the model was given. */
export function hhmmss(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/* Sponsor reads are the highest-density source of confident, well-structured,
   completely worthless "insights" in any commercial podcast — they are written
   to sound like advice. Dropping them before extraction is far more reliable
   than asking a model to ignore them, and it is free. Matching is deliberately
   conservative: a segment must hit a promo pattern to be dropped, and a lone
   mention of a brand name is not enough. */
const AD = [
  /\b(this episode|today'?s episode|this podcast) is (brought to you|sponsored) by\b/i,
  /\b(use|with) (the )?(promo |discount )?code\b[^.]{0,40}\b(at checkout|for \d+% off|to get)\b/i,
  /\bgo to [a-z0-9.-]+\.(com|co|io)\/[a-z0-9-]+ (and|to) (get|save|claim)\b/i,
  /\b\d{1,2}% off your first (order|month|purchase)\b/i,
  /\bterms and conditions apply\b/i,
];
/* Continuation signal: what ad copy looks like once the "sponsored by" line has
   already gone past. Deliberately narrow — a false positive here deletes
   content, and content is the product. */
const TRAILING_PROMO = /(https?:\/\/|\b[a-z0-9-]+\.(com|co|io)\/|\bpromo code\b|\bdiscount code\b|\b\d{1,2}% off\b|\bfree trial\b|\bour sponsor\b)/i;

const HOUSEKEEPING = [
  /\b(like,? comment (and|&) subscribe|smash that (like|subscribe)|hit the bell)\b/i,
  /\bleave (us )?a (five[- ]star )?review (on|wherever)\b/i,
  /\b(welcome back to|you'?re listening to) the (show|podcast)\b/i,
];

export function stripNoise(segments) {
  const dropped = new Set();
  for (let i = 0; i < segments.length; i++) {
    if (!AD.some((r) => r.test(segments[i].text)) && !HOUSEKEEPING.some((r) => r.test(segments[i].text))) continue;
    dropped.add(i);
    /* A promo runs on past its give-away line, so keep dropping FORWARD while
       the following segments still read as promo. Forward only, and only while
       the signal holds: an earlier version of this widened by +/-45 seconds
       either side and ate the first substantive answer of the episode, which
       is a far more expensive mistake than leaving one line of ad copy in. */
    for (let j = i + 1; j < segments.length && segments[j].t - segments[i].t <= 40; j++) {
      if (!TRAILING_PROMO.test(segments[j].text)) break;
      dropped.add(j);
    }
  }
  return {
    segments: segments.filter((_, i) => !dropped.has(i)),
    droppedCount: dropped.size,
  };
}

/**
 * Group segments into overlapping, timestamped chunks.
 *
 * Boundaries prefer a speaker change: cutting where the floor changes hands is
 * the closest cheap approximation of a topic boundary, and it never splits a
 * single answer in half.
 */
export function chunk(segments, { size = cfg.chunkChars, overlap = cfg.chunkOverlapChars } = {}) {
  const chunks = [];
  let cur = [], curChars = 0;

  const flush = () => {
    if (!cur.length) return;
    chunks.push({
      index: chunks.length,
      startSec: cur[0].t,
      endSec: cur[cur.length - 1].t + (cur[cur.length - 1].d || 0),
      segments: cur,
      text: render(cur),
    });
    /* Carry the tail forward so an idea spanning the boundary appears whole in
       the next chunk. Overlap is a cost — it is re-read and re-charged — so it
       is a fraction of the chunk, not a second copy of it. */
    const tail = [];
    let n = 0;
    for (let i = cur.length - 1; i >= 0 && n < overlap; i--) { tail.unshift(cur[i]); n += cur[i].text.length; }
    cur = tail; curChars = n;
  };

  for (const s of segments) {
    const speakerChanged = cur.length && cur[cur.length - 1].speaker !== s.speaker;
    if (curChars + s.text.length > size && (speakerChanged || curChars > size * 1.15)) flush();
    cur.push(s); curChars += s.text.length;
  }
  flush();

  /* The overlap tail can leave a final chunk that is nothing but the previous
     chunk's ending. It contributes no new material and costs a full pass. */
  return chunks.filter((c, i) => i === 0 || c.text.length > overlap * 1.2);
}

/** Chunk text as the model sees it. Every line is prefixed with its offset so
 *  the model can cite one, and speaker labels are only emitted when the
 *  transcript actually carried them — inventing "HOST:" where diarisation was
 *  unavailable teaches the model to attribute confidently and wrongly. */
function render(segs) {
  return segs.map((s) => `[${hhmmss(s.t)}]${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`).join("\n");
}

/** Nearest real segment to a claimed offset, with the text that was actually
 *  said there. This is what validation checks a citation against. */
export function segmentAt(segments, t) {
  if (!segments.length) return null;
  let best = segments[0], bestD = Infinity;
  for (const s of segments) {
    const d = Math.abs(s.t - t);
    if (d < bestD) { best = s; bestD = d; }
  }
  return { segment: best, driftSec: bestD };
}
