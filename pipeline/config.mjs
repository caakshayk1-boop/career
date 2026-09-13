/**
 * config.mjs — every knob the daily job has, in one place, read from the
 * environment.
 *
 * WHY ENV AND NOT A CONFIG FILE. The two things that must never be committed
 * are the API keys and the R2 credentials. Everything else could live in a
 * file, but splitting configuration across two mechanisms is how a limit gets
 * changed in the file and silently overridden by a stale workflow env. One
 * mechanism, one place to look.
 *
 * The defaults are chosen so that `node pipeline/run.mjs --dry-run` works on a
 * laptop with NO credentials at all: the mock AI provider and the null audio
 * provider produce a complete, structurally valid artifact. That is what makes
 * the pipeline testable, and it is the reason every provider is looked up by
 * name rather than imported directly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const int = (v, d) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(v));

export const cfg = {
  /* ── RETENTION ──────────────────────────────────────────────────────────
     Two numbers, deliberately separate. PUBLIC_RETENTION_DAYS controls what a
     visitor can see. DATA_RETENTION_DAYS controls how long we remember that an
     episode existed — which is what stops the job reprocessing the same
     episode a week later at full cost. Collapsing these into one number is the
     bug that makes a "7-day site" re-buy its own back catalogue every Monday. */
  publicRetentionDays: int(process.env.PUBLIC_RETENTION_DAYS, 7),
  dataRetentionDays: int(process.env.DATA_RETENTION_DAYS, 400),

  /* ── COST CONTROL ───────────────────────────────────────────────────────
     A 3-hour podcast is not free. These are the brakes.
     maxDailyEpisodes is a hard stop on a single run, not a target. */
  /* Raised from 2. The desk feed is a curated daily list and the reader expects
     to see all of it, not the two most recent — a cap that quietly drops the
     rest recreates the "where did my podcasts go" problem in a different place.
     It stays a cap because it is still the only brake on a runaway feed. */
  maxDailyEpisodes: int(process.env.MAX_DAILY_EPISODES, 12),
  maxEpisodeMinutes: int(process.env.MAX_EPISODE_MINUTES, 240),
  minEpisodeMinutes: int(process.env.MIN_EPISODE_MINUTES, 20),
  /* 8 days, one more than the public window: an episode that appears in the
     desk feed a few days after airing should still be processed while it can
     still be shown. */
  maxLookbackHours: int(process.env.MAX_LOOKBACK_HOURS, 192),

  /* ── EXTRACTION ─────────────────────────────────────────────────────────
     targetLearnings is a CEILING, never a quota. minLearnings is the floor
     below which the episode is not worth publishing at all. If an episode
     yields 6 good ideas it ships with 6. */
  targetLearnings: int(process.env.TARGET_LEARNINGS, 20),
  /* SIX, WHICH IS WHAT THE LINE ABOVE ALREADY PROMISED.
   *
   * "If an episode yields 6 good ideas it ships with 6" was the stated rule and
   * the floor was 10, so an episode yielding 6, 7 or 8 shipped with none. The
   * comment described the intent and the number contradicted it.
   *
   * Measured on the five that were being refused: CA Rachana Ranade on the NSE
   * IPO produced 8 distinct points and Think School on starting a business
   * produced 7 — both substantive, both silently dropped. The other three
   * produced 1, 0 and a rate-limit, and 6 still refuses all three.
   *
   * The floor exists to reject an episode with nothing to say, not to reject a
   * short one that says a few things well. A 12-minute Warikoo clip cleared 20
   * points on this same extractor, so length was never the discriminator. */
  minLearnings: int(process.env.MIN_LEARNINGS, 6),

  /* ── EXTRACTOR ──────────────────────────────────────────────────────────
     "local"  sentences chosen from the transcript by information density.
              Costs nothing, ever. Cannot fabricate — every point IS a
              quotation. Cannot interpret either: there is no "why this
              matters", because writing that would mean generating text.
     "ai"     the five-pass model pipeline. Adds interpretation, ranking and a
              written summary, at roughly $0.50 an episode.
     Local is the default because the running cost of this site is zero and the
     whole point of that is that it stays zero. Setting ANTHROPIC_API_KEY does
     NOT silently switch it — EXTRACTOR=ai is a separate, deliberate decision. */
  extractor: process.env.EXTRACTOR || "local",
  chunkChars: int(process.env.CHUNK_CHARS, 14000),
  chunkOverlapChars: int(process.env.CHUNK_OVERLAP_CHARS, 900),

  /* ── PROVIDERS ──────────────────────────────────────────────────────────
     Named, not imported. "mock" and "none" are first-class: they are what the
     test suite and a credential-free dry run use. */
  /* Groq before Anthropic when both are present: it is free and this site's
     running cost is the reason the local extractor was the default at all.
     AI_PROVIDER still wins over both, and with neither key it is still mock. */
  aiProvider: process.env.AI_PROVIDER
    || (process.env.GROQ_API_KEY ? "groq"
        : process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock"),
  groqKey: process.env.GROQ_API_KEY || "",
  /* MEASURED ON THIS ACCOUNT, not chosen from a docs page. Asked for one
     schema-constrained tool call, qwen3.8-27b returned it with every field
     populated and gpt-oss-120b returned nothing parseable — the reasoning-model
     failure already on record here, where hidden tokens eat max_tokens and
     leave an empty 200. Overridable because Groq has retired models twice. */
  groqModel: process.env.GROQ_MODEL_PODCASTS || "qwen/qwen3.8-27b",
  /* The free tier is token-per-minute limited, so calls are serialised and
     spaced rather than raced into a 429. */
  groqGapMs: int(process.env.GROQ_GAP_MS, 2500),
  /* OUTPUT tokens per minute is the binding limit on the free tier, and it is
     enforced on the REQUEST: asking for 8,000 output tokens is refused before a
     single token is generated — "Request too large ... on output tokens per
     minute (OTPM)" — so a retry cannot help. Ask for less instead. */
  groqMaxTokens: int(process.env.GROQ_MAX_TOKENS, 2400),
  /* Three, not one. A token-per-minute window can be genuinely full for most of
     a minute, and one retry discovers that and gives up. */
  groqRetries: int(process.env.GROQ_RETRIES, 3),
  /* The model the run will actually use, so the cost estimate prices the right
     thing. Without it estimateCost falls back to cfg.aiModel — an Anthropic
     model — whichever provider is in use. */
  get activeAiModel() {
    return this.aiProvider === "groq" ? this.groqModel
         : this.aiProvider === "anthropic" ? this.aiModel
         : "mock";
  },
  /* TWO MODELS, BY TASK. Pass 1 is recall over a dozen chunks — read this
     section, list anything that might qualify — and it is where the token
     volume is; the cheap model is genuinely good enough and is 80% of the
     calls. Passes 2, 4 and 5 are judgement over a short list, which is the part
     that decides whether the page is worth reading. Running the whole thing on
     the cheap model saves about twenty cents an episode and costs the product. */
  aiModel: process.env.AI_MODEL || "claude-opus-5",
  aiModelCheap: process.env.AI_MODEL_CHEAP || "claude-haiku-4-5",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",

  /* AUDIO IS OFF. It was two thirds of the running cost — roughly $1.05 of a
     $1.55 episode — for a convenience nobody asked to keep. The provider
     interface stays: set TTS_PROVIDER=elevenlabs and a key to turn it back on,
     and everything downstream already handles an episode that has audio. */
  ttsProvider: process.env.TTS_PROVIDER || "none",
  elevenKey: process.env.ELEVENLABS_API_KEY || "",
  elevenVoice: process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
  elevenModel: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5",

  transcriptProvider: process.env.TRANSCRIPT_PROVIDER || "auto",
  deepgramKey: process.env.DEEPGRAM_API_KEY || "",

  /* ── AUDIO STORAGE ──────────────────────────────────────────────────────
     Audio does NOT go in git. Three minutes of MP3 a day is 60MB a week and
     git keeps every byte forever, so a "7-day site" would carry a 3GB history
     by next September. R2 is the store; if it is not configured the pipeline
     still publishes text and simply reports no audio. */
  r2Bucket: process.env.R2_BUCKET || "",
  r2Account: process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || "",
  r2KeyId: process.env.R2_ACCESS_KEY_ID || "",
  r2Secret: process.env.R2_SECRET_ACCESS_KEY || "",
  r2PublicBase: (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, ""),

  /* ── NOTEBOOKLM ─────────────────────────────────────────────────────────
     Off by default and unimplemented on purpose. See lib/notebooklm.mjs. */
  notebookLM: bool(process.env.NOTEBOOKLM_ENABLED, false),

  /* ── RUN MODE ───────────────────────────────────────────────────────────── */
  dryRun: bool(process.env.DRY_RUN, false),
  force: bool(process.env.FORCE_REPROCESS, false),

  /* ── VERSIONING ─────────────────────────────────────────────────────────
     Stamped onto every episode. Bumping promptVersion is what lets a future
     run legitimately reprocess an episode it has already paid for, without
     inventing a separate "reprocess everything" switch that someone will
     eventually run by accident. */
  processingVersion: "1.0.0",
  /* BUMPING THIS REPROCESSES EVERYTHING. The ledger marks an episode settled
     under the version that produced it, so a scoring change that is not
     accompanied by a bump silently leaves yesterday's worse points on the page
     forever. .b: the first production run returned dependent fragments —
     sentences beginning "Because…", "That is because…" — because the causal
     signal matched the single most common word in conversational speech. */
  promptVersion: "2026-09-10.b",

  /* ── PATHS ──────────────────────────────────────────────────────────────── */
  out: join(ROOT, "public", "podcasts.json"),
  statePath: join(ROOT, "pipeline", "state.json"),
  sourcesPath: join(ROOT, "pipeline", "sources.json"),
  cachePath: join(ROOT, "pipeline", ".cache"),
};

/** Timezone the site speaks. Every human-facing date is MYT, matching the
 *  rest of the repo — a UTC date stamp reads a day early after 8am here. */
export const TZ = "Asia/Kuala_Lumpur";

export function loadSources() {
  const raw = JSON.parse(readFileSync(cfg.sourcesPath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.sources || [];
  return list.filter((s) => s && s.id && s.url && s.enabled !== false);
}

/** MYT calendar date (YYYY-MM-DD) for an instant. Built from parts rather than
 *  toISOString() — the latter is UTC and puts a 7am episode on yesterday. */
export function mytDate(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** Whole days between two MYT calendar dates. Compared as UTC midnights so no
 *  DST or offset arithmetic is involved; the strings are already local. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
