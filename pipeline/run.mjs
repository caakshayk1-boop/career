#!/usr/bin/env node
/**
 * run.mjs — the morning job.
 *
 *   node pipeline/run.mjs              process today's episodes and publish
 *   node pipeline/run.mjs --dry-run    everything except writing the artifact
 *   node pipeline/run.mjs --republish  rebuild the artifact from the ledger only
 *
 * IDEMPOTENCE IS THE PROPERTY THAT MATTERS. Run it twice in a morning and the
 * second run does nothing but rewrite the same artifact: the ledger has already
 * settled every episode, and the transcript and insight caches mean even a
 * forced reprocess pays only for what actually changed. Two runs must never
 * produce two cards for one conversation, which is why the episode id is
 * derived from the feed's own identifier and never from the title.
 *
 * FAILURE IS PER-EPISODE. One episode that cannot be transcribed does not stop
 * the other two, and it is recorded with a reason rather than dropped. The run
 * exits non-zero only if it could not publish at all — a partially successful
 * morning is a normal morning.
 */
import { cfg, loadSources, mytDate } from "./config.mjs";
import { log, run, finishRun, charge } from "./lib/log.mjs";
import { loadState, saveState, remember, isSettled, cached, pruneCache, savePublished } from "./lib/store.mjs";
import { discover, selectEligible } from "./lib/ingest.mjs";
import { getTranscript, assessQuality } from "./lib/transcript.mjs";
import { extract, extractLocal, meta, script } from "./lib/extract.mjs";
import { validateLearnings, verdict } from "./lib/validate.mjs";
import { makeAI, estimateCost } from "./lib/ai.mjs";
import { makeAudio } from "./lib/audio.mjs";
import { buildPublic, buildPending, mergePending, pruneState } from "./lib/retention.mjs";

const argv = new Set(process.argv.slice(2));
const REPUBLISH_ONLY = argv.has("--republish");
if (argv.has("--dry-run")) cfg.dryRun = true;
if (argv.has("--force")) cfg.force = true;

/* ── STATES ────────────────────────────────────────────────────────────────
   Explicit, and every transition is written to the ledger before the next step
   starts. A run that dies mid-episode leaves that episode in the state it had
   actually reached, so the next run can see where it stopped rather than
   starting from DISCOVERED with a paid-for transcript sitting unused in cache. */
const S = {
  DISCOVERED: "DISCOVERED", TRANSCRIBING: "TRANSCRIBING", ANALYZING: "ANALYZING",
  VALIDATING: "VALIDATING", GENERATING_AUDIO: "GENERATING_AUDIO",
  PUBLISHED: "PUBLISHED", NEEDS_REVIEW: "NEEDS_REVIEW", FAILED: "FAILED", SKIPPED: "SKIPPED",
};

let pending = [];

async function main() {
  const state = loadState();
  const LOCAL = cfg.extractor === "local";
  /* The AI provider is not even constructed on the free path — constructing it
     throws without a key, and the whole point is that no key is needed. */
  const ai = LOCAL ? null : await makeAI();
  const audio = makeAudio();
  log.stage("start", `extractor=${cfg.extractor}${ai ? ` (${ai.name}:${ai.model})` : " — no model, no cost"}` +
    ` tts=${audio.name} points=${cfg.minLearnings}-${cfg.targetLearnings} retention=${cfg.publicRetentionDays}d${cfg.dryRun ? " DRY-RUN" : ""}`);

  if (!REPUBLISH_ONLY) {
    const sources = loadSources();
    log.stage("ingest", `${sources.length} sources`);

    const candidates = (await Promise.all(sources.map(discover))).flat();
    const { eligible, skipped } = selectEligible(candidates, state, isSettled);
    /* Held for the artifact: everything the reader was told about that we could
       not read. These are shown as titles rather than removed from the page. */
    pending = buildPending(skipped);

    for (const s of skipped) {
      /* Only ineligibility that will still hold tomorrow is written to the
         ledger. "over the daily cap" must NOT settle the episode — it is
         genuinely eligible and should be picked up on the next run. */
      /* An episode we could not READ is not settled — it is pending, and a
         later run with different providers configured should pick it up. Only
         permanent ineligibility is written to the ledger. */
      if (s.pending) continue;
      if (/^(older than|no usable|published in the future|under the|over the \d+m)/.test(s.reason))
        remember(state, s.id, { status: S.SKIPPED, reason: s.reason, title: s.title });
    }
    log.info("ingest", `${eligible.length} eligible, ${skipped.length} skipped`);

    for (const ep of eligible) {
      try { await processEpisode(ep, state, ai, audio); }
      catch (e) {
        /* ── A SOURCE THAT CAN NEVER BE READ IS NOT A DAILY FAILURE ────────
         *
         * Every error here was written to the ledger as FAILED and retried on
         * every run, forever. Measured on 2026-09-16: 12 eligible, 0
         * processed, 12 failed — and most of those were videos with NO
         * CAPTION TRACK AT ALL. No provider will ever return one, so the job
         * spent its whole budget re-asking a question with a permanent answer
         * and reported a dozen failures a day for a feed that was working.
         *
         * Two different things wear one label, and they need opposite
         * handling:
         *
         *   PERMANENT  no captions published, video unavailable, private,
         *              members-only. Retrying is pointless. SKIPPED, with the
         *              reason, exactly like an episode that is too old.
         *   TRANSIENT  LOGIN_REQUIRED (an IP block — it works from a home
         *              connection), 429, a network fault. FAILED, retried.
         *
         * This is not a way to make the failure count look better. A skipped
         * episode is still listed with its reason; what changes is that the
         * pipeline stops treating a fact about the world as a fault of its
         * own, and stops spending tomorrow's run on it. */
        const why = String(e && e.message || "");
        /* The patterns come from errors this pipeline has ACTUALLY produced,
           now that yt-dlp's stderr is surfaced rather than the command line:
           a premiere that has not aired is not a failure and will not be one
           until it does; a video with no caption track never will be. A 429
           is deliberately NOT here — that is this job asking too fast, which
           is our fault and is worth retrying after the pacing fix. */
        const permanent = /no caption|captionTracks|no subtitles|video is unavailable|private video|members-only|removed by the uploader|no usable audio|is not available/i.test(why);
        if (permanent) {
          log.info("process", `${ep.id}: ${why.slice(0, 120)} — skipped for good, no provider can read it`);
          remember(state, ep.id, { status: S.SKIPPED, reason: why.slice(0, 300),
                                   title: ep.title, show: ep.show });
          run.counts.skipped = (run.counts.skipped || 0) + 1;
          continue;
        }
        log.fail("process", ep.id, e.message);
        remember(state, ep.id, { status: S.FAILED, reason: e.message.slice(0, 300), title: ep.title, show: ep.show });
        run.counts.failed++;
        /* A FAILURE MUST NOT DELETE THE EPISODE FROM THE PAGE. The two desk
           episodes that failed on "no caption track published for this video"
           were neither read nor listed — they simply vanished, which is the
           same complaint that made the desk feed a source in the first place.
           A failure means we could not read it today, not that it stopped
           existing. It is listed, with the reason. */
        pending.push({
          id: ep.id, title: ep.title, show: ep.show, url: ep.url,
          takeaways: ep.deskTakeaways || [],
          date: mytDate(ep.curated ? new Date() : new Date(ep.publishedAt || Date.now())),
          reason: e.message.slice(0, 160),
        });
      }
      /* Saved after EVERY episode, not at the end. A run killed by the CI job
         timeout must not lose the two episodes it already paid for. */
      if (!cfg.dryRun) saveState(state);
    }
  }

  /* ── PUBLISH ────────────────────────────────────────────────────────────── */
  const published = Object.values(state.episodes).filter((e) => e.status === S.PUBLISHED && e.payload)
    .map((e) => e.payload);

  const doc = buildPublic(published, {
    /* Dedupe: an episode can be named by eligibility AND by a processing
       failure in the same run. One row each. */
    pending: mergePending(pending),
    generator: {
      processingVersion: cfg.processingVersion, promptVersion: cfg.promptVersion,
      extractor: cfg.extractor, ai: ai ? `${ai.name}:${ai.model}` : "none", tts: audio.name,
    },
    run: summarise(),
  });

  if (cfg.dryRun) log.stage("publish", `DRY RUN — would publish ${doc.episodes.length} episodes across ${doc.days.length} days`);
  else { savePublished(doc); log.stage("publish", `${doc.episodes.length} episodes across ${doc.days.length} days`); }

  const prunedRows = pruneState(state);
  const prunedFiles = pruneCache();
  if (!cfg.dryRun) saveState(state);
  log.info("retention", `public window ${cfg.publicRetentionDays}d`, {
    hidden: run.counts.pruned, ledgerRowsDropped: prunedRows, cacheFilesDropped: prunedFiles });

  report();
  /* A morning with nothing new is normal — most days a feed has no new episode
     worth processing. Failing the workflow for that would train everyone to
     ignore a red run. Only a total inability to publish is an error. */
  process.exit(run.counts.processed === 0 && run.counts.failed > 0 && doc.episodes.length === 0 ? 1 : 0);
}

async function processEpisode(ep, state, ai, audio) {
  log.stage("episode", `${ep.show} — ${ep.title.slice(0, 70)}`, { id: ep.id });
  remember(state, ep.id, { status: S.TRANSCRIBING, title: ep.title, show: ep.show, url: ep.url });

  const transcript = await getTranscript(ep);
  const quality = assessQuality(transcript, ep);
  if (!quality.ok && transcript.chars < 4000)
    throw new Error(`transcript unusable: ${quality.problems.join("; ")}`);

  remember(state, ep.id, { status: S.ANALYZING });
  /* Cached on episode id + extractor + prompt version: a re-run after a crashed
     publish costs nothing, and changing either legitimately busts it. The local
     extractor is fast and free, so the cache is about determinism there rather
     than money — the same episode must not produce a different list tomorrow. */
  const analysis = await cached("insights", `${ep.id}|${cfg.extractor}|${cfg.promptVersion}`,
    () => (ai ? extract(ai, ep, transcript) : extractLocal(ep, transcript)));

  remember(state, ep.id, { status: S.VALIDATING });
  const checked = validateLearnings(analysis.learnings, transcript, ep);
  const v = verdict(checked, quality);
  for (const r of checked.rejected) log.info("validate", `${ep.id}: dropped “${r.headline.slice(0, 44)}” — ${r.reason}`);

  if (v.status !== "READY") {
    /* Never publish to hit a number. An episode held here is visible in the
       ledger with its reasons and can be released by hand. */
    log.warn("validate", `${ep.id} held for review: ${v.problems.join("; ")}`);
    remember(state, ep.id, { status: S.NEEDS_REVIEW, reason: v.problems.join("; "), title: ep.title, show: ep.show });
    run.counts.failed++;
    return;
  }

  /* The header. On the free path there is no model to write one, so the guest
     is left empty rather than guessed at from the title, and the summary states
     what the list is rather than pretending to characterise the conversation. */
  const m = ai
    ? await cached("meta", `${ep.id}|${cfg.promptVersion}`, () => meta(ai, ep, checked.learnings))
    : { guest: "", summary: analysis.summary || "", topics: [] };

  /* AUDIO LAST. Validation has passed, so this is speech for something that
     will definitely be published. */
  remember(state, ep.id, { status: S.GENERATING_AUDIO });
  let audioAsset = null;
  if (audio.name !== "none" && ai) {
    try {
      const spoken = await cached("script", `${ep.id}|${cfg.promptVersion}`, () => script(ai, ep, checked.learnings, m.guest));
      audioAsset = await audio.generateAudio(spoken, `briefings/${ep.id}.mp3`);
    } catch (e) {
      /* A failed briefing is a missing convenience, not a failed episode. The
         page renders the text and simply shows no player. */
      log.warn("audio", `${ep.id}: ${e.message} — publishing without audio`);
    }
  }

  const payload = {
    id: ep.id, sourceId: ep.sourceId, show: ep.show, title: ep.title,
    guest: (m.guest || "").trim(), topics: m.topics || [], summary: m.summary || "",
    url: ep.url, type: ep.type, image: ep.image,
    publishedAt: ep.publishedAt,
    /* A curated episode is dated by the digest that listed it, not by when it
       aired: it belongs on the day the reader was told about it. */
    date: mytDate(ep.curated ? new Date() : new Date(ep.publishedAt || Date.now())),
    durationSec: transcript.durationSec || ep.durationSec || 0,
    processedAt: new Date().toISOString(),
    status: S.PUBLISHED,
    transcriptProvider: transcript.provider,
    timestamped: Boolean(transcript.timestamped),
    extractor: analysis.extractor || cfg.extractor,
    learnings: checked.learnings.map((l) => ({
      rank: l.rank, headline: l.headline, idea: l.idea, why: l.why, action: l.action,
      /* `passage` is the expansion — the point back in the conversation. Only
         the local extractor produces one; the page shows it when it is there. */
      detail: l.detail || "", passage: l.passage || "",
      evidence: l.evidence, t: l.t, kind: l.kind, confidence: l.confidence,
      grounding: l.groundingScore, repaired: Boolean(l.tRepaired || l.demoted),
    })),
    rejectedCount: checked.rejected.length,
    audio: audioAsset,
    readSeconds: readingTime(checked.learnings, m.summary),
  };

  remember(state, ep.id, { status: S.PUBLISHED, title: ep.title, show: ep.show, payload });
  run.counts.processed++;
  log.stage("published", `${ep.id}: ${payload.learnings.length} points${audioAsset ? `, ${Math.round(audioAsset.durationSec / 60)}m audio` : ""}`);
}

/* 220 wpm is a scanning rate, not a reading rate — this page is skimmed, and an
   honest low number is what makes the promise ("three minutes") credible. */
const readingTime = (learnings, summary) => {
  const words = learnings.reduce((n, l) => n + `${l.headline} ${l.idea} ${l.why} ${l.action}`.split(/\s+/).length, 0)
    + String(summary || "").split(/\s+/).length;
  return Math.max(60, Math.round((words / 220) * 60));
};

const summarise = () => ({
  at: new Date().toISOString(),
  ...run.counts,
  errors: run.errors.slice(0, 20),
  estimatedCostUsd: Math.round(estimateCost(run.cost.inTokens, run.cost.outTokens, cfg.activeAiModel) * 10000) / 10000,
});

function report() {
  const r = finishRun();
  /* PRICED AGAINST THE MODEL THAT ACTUALLY RAN. estimateCost defaults to
     cfg.aiModel, which is the Anthropic model whatever provider is in use — so
     a free Groq run of 21,853 in / 7,437 out printed "$0.295". An estimate
     that reports a free run as costing money is worse than none: it is exactly
     the number someone decides on. */
  const ai$ = estimateCost(r.cost.inTokens, r.cost.outTokens, cfg.activeAiModel);
  /* ElevenLabs bills per character; the rate varies by plan, so this uses the
     Creator-tier figure as an order of magnitude and says so. */
  const tts$ = (r.cost.ttsChars / 1000) * 0.15;
  console.log(`
──────────────────────────────────────────────────────────
  discovered ${r.counts.discovered}   eligible ${r.counts.eligible}   processed ${r.counts.processed}   failed ${r.counts.failed}
  skipped ${r.counts.skipped}   hidden by retention ${r.counts.pruned}
  ai ${r.cost.aiCalls} calls  ${r.cost.inTokens} in / ${r.cost.outTokens} out  ≈ $${ai$.toFixed(3)}
  tts ${r.cost.ttsChars} chars  ≈ $${tts$.toFixed(3)} (Creator-tier rate)
  total ≈ $${(ai$ + tts$).toFixed(3)}   in ${(r.durationMs / 1000).toFixed(1)}s
──────────────────────────────────────────────────────────`);
  if (r.errors.length) {
    console.log("  errors:");
    for (const e of r.errors) console.log(`    ${e.stage} ${e.id}: ${e.message}`);
  }
}

main().catch((e) => { console.error("\nFATAL:", e.stack || e.message); process.exit(1); });
