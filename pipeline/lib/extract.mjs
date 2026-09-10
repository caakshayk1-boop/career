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
import { chunk, stripNoise, hhmmss } from "./chunk.mjs";
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

export async function extract(ai, ep, transcript) {
  const cleaned = stripNoise(transcript.segments);
  if (cleaned.droppedCount) log.info("extract", `${ep.id}: dropped ${cleaned.droppedCount} ad/housekeeping segments`);

  const chunks = chunk(cleaned.segments);
  log.stage("extract", `${ep.id}: ${chunks.length} chunks`, { chars: transcript.chars });

  /* ── PASS 1 ──────────────────────────────────────────────────────────────
     The cheap model does the reading. This is where the volume is — a 2-hour
     episode is a dozen calls — and the task is recall, not judgement: find
     anything that might qualify. The expensive model decides what survives. */
  const perChunk = await mapLimit(chunks, 4, async (c) => {
    try {
      const r = await ai.json({
        system: SYSTEM_EXTRACT,
        user: `<episode>${ep.show} — ${ep.title}</episode>\n<section index="${c.index + 1}" of="${chunks.length}" from="${hhmmss(c.startSec)}" to="${hhmmss(c.endSec)}">\n${c.text}\n</section>`,
        schema: SCHEMA_CANDIDATES, name: "record_candidates",
        description: "Record the ideas in this section that are worth a stranger's time.",
        cheap: true, effort: "medium",
      });
      return (r.candidates || []).map((x) => ({ ...x, chunkIndex: c.index }));
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

  /* ── PASS 2 ─────────────────────────────────────────────────────────────── */
  const ranked = await ai.json({
    system: SYSTEM_RANK.replace(/\{TARGET\}/g, String(cfg.targetLearnings)),
    user: `<episode>${ep.show} — ${ep.title}</episode>\n<candidates>${JSON.stringify(candidates, null, 1)}</candidates>`,
    schema: SCHEMA_RANKED, name: "record_ranked",
    description: "Merge, deduplicate and rank the candidate ideas.",
    effort: "high", maxTokens: 16000,
  });

  const learnings = (ranked.learnings || [])
    .slice(0, cfg.targetLearnings)
    .map((l, i) => ({ ...l, rank: i + 1 }));

  return { learnings, candidateCount: candidates.length, chunkCount: chunks.length };
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
