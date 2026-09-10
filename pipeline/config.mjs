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
  maxDailyEpisodes: int(process.env.MAX_DAILY_EPISODES, 3),
  maxEpisodeMinutes: int(process.env.MAX_EPISODE_MINUTES, 240),
  minEpisodeMinutes: int(process.env.MIN_EPISODE_MINUTES, 20),
  maxLookbackHours: int(process.env.MAX_LOOKBACK_HOURS, 72),

  /* ── EXTRACTION ─────────────────────────────────────────────────────────
     targetLearnings is a CEILING, never a quota. minLearnings is the floor
     below which the episode is not worth publishing at all. If an episode
     yields 6 good ideas it ships with 6. */
  targetLearnings: int(process.env.TARGET_LEARNINGS, 10),
  minLearnings: int(process.env.MIN_LEARNINGS, 5),
  chunkChars: int(process.env.CHUNK_CHARS, 14000),
  chunkOverlapChars: int(process.env.CHUNK_OVERLAP_CHARS, 900),

  /* ── PROVIDERS ──────────────────────────────────────────────────────────
     Named, not imported. "mock" and "none" are first-class: they are what the
     test suite and a credential-free dry run use. */
  aiProvider: process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock"),
  /* TWO MODELS, BY TASK. Pass 1 is recall over a dozen chunks — read this
     section, list anything that might qualify — and it is where the token
     volume is; the cheap model is genuinely good enough and is 80% of the
     calls. Passes 2, 4 and 5 are judgement over a short list, which is the part
     that decides whether the page is worth reading. Running the whole thing on
     the cheap model saves about twenty cents an episode and costs the product. */
  aiModel: process.env.AI_MODEL || "claude-opus-5",
  aiModelCheap: process.env.AI_MODEL_CHEAP || "claude-haiku-4-5",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",

  ttsProvider: process.env.TTS_PROVIDER || (process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "none"),
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
  promptVersion: "2026-09-10.a",

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
