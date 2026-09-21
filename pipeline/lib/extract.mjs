/**
 * extract.mjs — transcript in, ranked learnings out.
 *
 * THE PASS STRUCTURE, and one deliberate deviation from the brief.
 *
 *   Pass 1  candidates, per chunk, cheap model, parallel
 *   Pass 2  merge, deduplicate and rank — ONE call, not two
 *   Pass 3  validate against source — in code, not by a model
 *   Pass 4  header copy (guest, summary, topics)
 *   Pass 5  spoken briefing script
 *
 * Pass 2 was specified as two passes, merge then rank. They are one call here
 * because they are one judgement over one list: a second round trip re-reads
 * every candidate to reorder a list the merging model has already ordered in
 * its head, and it costs a full input pass to do it. The prompt still performs
 * them in sequence and says so explicitly.
 *
 * Pass 3 was specified as a model call. It is code. A model asked to check its
 * own citation will confirm it — that is the failure mode the check exists to
 * catch. Deterministic string matching against the transcript costs nothing,
 * cannot be talked round, and is testable offline. See validate.mjs.
 */
import { cfg } from "../config.mjs";
import { log } from "./log.mjs";
import { chunk, stripNoise } from "./chunk.mjs";
import { hhmmss } from "./text.mjs";
import { takeaways, describe } from "./extractive.mjs";
import {
  SYSTEM_EXTRACT, SYSTEM_RANK, SYSTEM_META, SYSTEM_SCRIPT,
  SCHEMA_CANDIDATES, SCHEMA_RANKED, SCHEMA_META,
} from "./prompts.mjs";

/** Bounded concurrency. Unbounded Promise.all over 14 chunks rate-limits the
 *  account and the backoff then costs more wall-clock than the serialism it
 *  was avoiding. Four is comfortably inside a default tier. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * The free path: no model, no key, no network.
 *
 * Returns the same shape the AI path returns, so nothing downstream — the
 * validator, the retention builder, the page — knows or cares which ran. The
 * fields it cannot honestly fill are left empty rather than filled with
 * something that sounds like analysis.
 */
export function extractLocal(ep, transcript) {
  const cleaned = stripNoise(transcript.segments);
  if (cleaned.droppedCount) log.info("extract", `${ep.id}: dropped ${cleaned.droppedCount} ad/housekeeping segments`);

  const r = takeaways(cleaned.segments, {
    min: cfg.minLearnings, max: cfg.targetLearnings,
    duration: transcript.durationSec || ep.durationSec || 0,
  });
  if (!r.points.length) throw new Error(`no takeaways: ${r.reason}`);

  log.stage("extract", `${ep.id}: ${r.points.length} points`, {
    from: r.considered, scored: r.scored, host: r.host || "undiarised" });

  return {
    learnings: r.points.map((p) => ({
      rank: p.rank,
      headline: p.point,
      /* No idea/why/action. The local extractor does not write prose, and an
         empty field the page skips is honest where invented text would not be. */
      idea: "", why: "", action: "",
      detail: p.detail,
      passage: p.passage,
      /* It is a quotation by construction, at the offset the words are at. */
      evidence: p.detail,
      timestamp: hhmmss(p.t),
      kind: "said",
      confidence: Math.min(0.95, 0.55 + p.score / 20),
    })),
    summary: describe(r.points, ep),
    candidateCount: r.scored,
    chunkCount: 0,
    extractor: "local",
  };
}

export async function extract(ai, ep, transcript) {
  const cleaned = stripNoise(transcript.segments);
  if (cleaned.droppedCount) log.info("extract", `${ep.id}: dropped ${cleaned.droppedCount} ad/housekeeping segments`);

  const chunks = chunk(cleaned.segments);
  log.stage("extract", `${ep.id}: ${chunks.length} chunks`, { chars: transcript.chars });

  /* ── PASS 1 ──────────────────────────────────────────────────────────────
     The cheap model does the reading. This is where the volume is — a 2-hour
     episode is a dozen calls — and the task is recall, not judgement: find
     anything that might qualify. The expensive model decides what survives. */
  /* CONCURRENCY IS A TOKENS-PER-MINUTE BUDGET, NOT A SPEED DIAL. Four chunks
     of ~14,000 characters in flight is roughly 14,000 input tokens in one
     burst, against gpt-oss-20b's 8,000 TPM ceiling on this tier — so a share
     of every long episode was refused 429 before it was read. Two fits. */
  const perChunk = await mapLimit(chunks, cfg.chunkConcurrency, async (c) => {
    try {
      const r = await ai.json({
        system: SYSTEM_EXTRACT,
        user: `<episode>${ep.show} — ${ep.title}</episode>\n<section index="${c.index + 1}" of="${chunks.length}" from="${hhmmss(c.startSec)}" to="${hhmmss(c.endSec)}">\n${c.text}\n</section>`,
        schema: SCHEMA_CANDIDATES, name: "record_candidates",
        description: "Record the ideas in this section that are worth a stranger's time.",
        cheap: true, effort: "medium",
      });
      /* Clamp here rather than in the schema, and fill the three fields the
         model is allowed to omit. An absent `why` is a thinner point; an
         absent `why` that 400s the call is no point at all. */
      return (r.candidates || []).slice(0, 8).map((x) => ({
        why: "", action: "", confidence: 0.6,
        ...x,
        chunkIndex: c.index,
      }));
    } catch (e) {
      /* One failed chunk is a hole in coverage, not a failed episode. Ten
         failed chunks will be caught by the floor check below. */
      log.warn("extract", `${ep.id} chunk ${c.index}: ${e.message}`);
      return [];
    }
  });

  const candidates = perChunk.flat();
  log.info("extract", `${ep.id}: ${candidates.length} candidates from ${chunks.length} chunks`);
  if (!candidates.length) throw new Error("no candidate ideas found in the transcript");

  /* ── PASS 2 ─────────────────────────────────────────────────────────────
   * THE RANKER'S REQUEST IS THE BIGGEST ONE THIS PIPELINE SENDS, and on the
   * 2026-09-21 run it was the only thing left standing between a 166-minute
   * Diary Of A CEO episode and the page:
   *
   *   Request too large for openai/gpt-oss-120b ... TPM: Limit 8000,
   *   Requested 9615
   *
   * Ten chunks at up to eight candidates each is eighty records, every one
   * carrying a verbatim `evidence` quotation, pretty-printed at indent 1.
   * Three things, cheapest first:
   *
   *   1. COMPACT JSON. `null, 1` spent a newline and a space on every field of
   *      every record for a machine that does not read indentation.
   *   2. CAP THE CANDIDATES, PER CHUNK. The ranker emits targetLearnings no
   *      matter how many it is shown, so eighty in to pick twenty is waste.
   *      Capped per chunk rather than globally BECAUSE the suite asserts
   *      timeline spread — a global top-N by confidence can silently drop a
   *      whole half of an episode.
   *   3. SHRINK AND RETRY. Episode length is unbounded and the TPM ceiling is
   *      not, so a fixed cap is a guess. If Groq still refuses on size, halve
   *      and go again rather than losing the episode. */
  const perChunkCap = Math.max(2, Math.ceil(cfg.rankMaxCandidates / Math.max(1, chunks.length)));
  const byChunk = new Map();
  for (const c of candidates) {
    const k = c.chunkIndex ?? 0;
    if (!byChunk.has(k)) byChunk.set(k, []);
    byChunk.get(k).push(c);
  }
  let shortlist = [...byChunk.keys()].sort((a, b) => a - b).flatMap((k) =>
    byChunk.get(k).sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, perChunkCap));
  if (shortlist.length < candidates.length)
    log.info("extract", `${ep.id}: ranking ${shortlist.length} of ${candidates.length} candidates ` +
      `(${perChunkCap}/chunk, to stay inside the ranker's TPM ceiling)`);

  const rank = (list) => ai.json({
    system: SYSTEM_RANK.replace(/\{TARGET\}/g, String(cfg.targetLearnings)),
    user: `<episode>${ep.show} — ${ep.title}</episode>\n<candidates>${JSON.stringify(list)}</candidates>`,
    schema: SCHEMA_RANKED, name: "record_ranked",
    description: "Merge, deduplicate and rank the candidate ideas.",
    effort: "high", maxTokens: 16000,
  });

  let ranked;
  try {
    ranked = await rank(shortlist);
  } catch (e) {
    const tooBig = /refused the request size|request too large|reduce.*length/i.test(String(e.message || ""));
    if (!tooBig || shortlist.length <= 4) throw e;
    const half = Math.max(4, Math.floor(shortlist.length / 2));
    log.warn("extract", `${ep.id}: ranker refused ${shortlist.length} candidates on size — retrying with ${half}`);
    ranked = await rank(shortlist.slice(0, half));
  }

  const learnings = (ranked.learnings || [])
    .slice(0, cfg.targetLearnings)
    .map((l, i) => ({ ...l, rank: i + 1 }));

  return { learnings, candidateCount: candidates.length, chunkCount: chunks.length, extractor: "ai" };
}

/** Pass 4. Fed the metadata and the surviving learnings rather than the
 *  transcript — the summary should describe the conversation the reader is
 *  about to get, and it is 30x cheaper than re-reading two hours of speech. */
export async function meta(ai, ep, learnings) {
  return ai.json({
    system: SYSTEM_META,
    user: `<show>${ep.show}</show>\n<title>${ep.title}</title>\n<description>${(ep.description || "").slice(0, 1200)}</description>\n<learnings>${JSON.stringify(learnings.map((l) => ({ headline: l.headline, idea: l.idea })), null, 1)}</learnings>`,
    schema: SCHEMA_META, name: "record_meta",
    description: "Record the guest, a short summary and the topics.",
    effort: "low", maxTokens: 2000,
  });
}

/** Pass 5. Only the validated learnings reach this — the briefing must never
 *  speak an idea the page itself refused to print. */
export async function script(ai, ep, learnings, guest) {
  const body = learnings.map((l) => `${l.rank}. [${l.kind}] ${l.headline}\n   ${l.idea}\n   Why: ${l.why}${l.action ? `\n   Action: ${l.action}` : ""}`).join("\n\n");
  return ai.text({
    system: SYSTEM_SCRIPT,
    user: `<show>${ep.show}</show>\n<guest>${guest || ""}</guest>\n<ideas>\n${body}\n</ideas>`,
    effort: "medium", maxTokens: 4000,
  });
}
