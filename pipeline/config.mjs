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
  publicRetentionDays: int(process.env.PUBLIC_RETENTION_DAYS, 30),

  /* A CEILING ON THE PAGE, NOT ON THE WINDOW. Thirty days of a working pipeline
     is a bigger page than seven: 17 episodes already weigh 191KB, most of it
     the `passage` text behind each point. Gzipped that is fine, but it grows
     with every source that starts working, and the page fetches the whole file
     before it can render anything. This bounds it. When it binds, the oldest go
     first and the window is effectively shorter than 30 days — which the page
     says, rather than silently showing less than advertised. */
  maxPublicEpisodes: int(process.env.MAX_PUBLIC_EPISODES, 60),
  dataRetentionDays: int(process.env.DATA_RETENTION_DAYS, 400),

  /* ── COST CONTROL ───────────────────────────────────────────────────────
     A 3-hour podcast is not free. These are the brakes.
     maxDailyEpisodes is a hard stop on a single run, not a target. */
  /* Raised from 2. The desk feed is a curated daily list and the reader expects
     to see all of it, not the two most recent — a cap that quietly drops the
     rest recreates the "where did my podcasts go" problem in a different place.
     It stays a cap because it is still the only brake on a runaway feed. */
  /* 12 -> 8, MEASURED AGAINST THE DAILY TOKEN BUCKET, not guessed. The first
     full AI run cost ~25,000 tokens an episode and Groq's free tier allows
     200,000 per model per day, so twelve does not fit in one bucket: that run
     processed 4 and was refused on the other 8. Eight episodes fully written
     beats twelve attempted and four delivered, because the four that fail do
     not degrade — they publish nothing at all.
     Raise it the day the split across two models proves it has room. */
  maxDailyEpisodes: int(process.env.MAX_DAILY_EPISODES, 8),
  maxEpisodeMinutes: int(process.env.MAX_EPISODE_MINUTES, 240),
  minEpisodeMinutes: int(process.env.MIN_EPISODE_MINUTES, 20),
  /* 8 days, one more than the public window: an episode that appears in the
     desk feed a few days after airing should still be processed while it can
     still be shown. */
  /* THIS IS THE RETRY WINDOW, AND IT MUST TRACK THE PUBLIC ONE.
     An episode YouTube refuses today is not settled in the ledger, so every
     later run tries it again — but only while it is still eligible, and
     eligibility stopped at 8 days while the page went on showing 30. An
     episode could therefore sit on the page, unread, with the pipeline no
     longer even attempting it.
     At 31 days a blocked episode gets ~30 attempts instead of ~8. The block has
     not been constant — yt-dlp read eight episodes across 17-22 Sep and then
     stopped — so the backlog is picked up automatically whenever it lifts,
     without anyone re-running anything. */
  maxLookbackHours: int(process.env.MAX_LOOKBACK_HOURS, 744),

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
   * points on this same extractor, so length was never the discriminator.
   *
   * 6 -> 4, MEASURED. 21 episodes were fetched, transcribed and extracted
   * successfully and then discarded by this number alone: the counts were
   * 1,2,2,3,3,3,3,4,4,4,4,4,4,5,5,5,5,5,5,5,5. A floor of 4 releases 14 of
   * them; 3 would release 18 but starts admitting the 1- and 2-point rows,
   * which are clip uploads and lecture recordings rather than conversations.
   * Four cited, verbatim points is a thin episode. Zero is a missing one. */
  minLearnings: int(process.env.MIN_LEARNINGS, 4),

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
  /* ── THE INTERPRETATION LAYER TURNS ITSELF ON WHEN IT CAN ────────────────
   *
   * This defaulted to "local" unconditionally, so adding an API key changed
   * nothing: EXTRACTOR had to be set as well, in a second place, and the
   * workflow shipped with both commented out. Eleven episodes published
   * through the free path — and it says so itself, in its own header, that it
   * "cannot tell you why a point matters".
   *
   * A key present and unused is a configuration that looks done and is not.
   * With a key, interpret; without one, extract. EXTRACTOR still wins over
   * both, so forcing either way stays one variable. */
  extractor: process.env.EXTRACTOR
    || ((process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY) ? "ai" : "local"),
  chunkChars: int(process.env.CHUNK_CHARS, 14000),
  /* How many chunks are read at once. Bounded by the cheap model's TOKENS PER
     MINUTE, not by how fast the machine is: 4 x 14,000 chars is ~14,000 input
     tokens in a burst against an 8,000 TPM ceiling, which is a 429 every time.
     Raise it the day the tier changes, and measure rather than guess. */
  chunkConcurrency: int(process.env.CHUNK_CONCURRENCY, 2),
  /* How many candidates pass 2 is allowed to weigh at once. The ranker returns
     targetLearnings whatever it is shown, so this is a TPM budget, not a
     quality dial: 80 records with verbatim quotations asked 9,615 tokens of a
     model capped at 8,000 per minute, and the episode was lost. Spread across
     chunks, never a global top-N. */
  rankMaxCandidates: int(process.env.RANK_MAX_CANDIDATES, 40),
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
  /* MEASURED ON THIS ACCOUNT, and the earlier measurement was wrong about WHY.
     gpt-oss did return nothing parseable — but because the call omitted
     `reasoning_effort`, so hidden reasoning consumed the whole budget. Sent
     with reasoning_effort:"low" it returns a populated tool call in 1.8s.

     THE DECIDING CONSTRAINT IS NOT QUALITY, IT IS A WALL. This account's
     free tier caps qwen at 1,000 OUTPUT tokens per minute, enforced on the
     request, and no header announces it — x-ratelimit-*-tokens reports the
     8,000 TPM bucket and says nothing about OTPM, so it cannot be paced
     around, only clamped under. Measured: qwen spent 711 output tokens on a
     9,000-char chunk. At the 14,000-char chunk this pipeline actually sends
     it would cross 1,000, and crossing it does not truncate the prose — it
     truncates the JSON, which arrives as "arguments were not valid JSON".

     gpt-oss-120b carries no such cap here (4,000 accepted), so it is the
     default. qwen is better prose and stays one env var away for a day when
     the tier changes:  GROQ_MODEL_PODCASTS=qwen/qwen3.8-27b GROQ_MAX_TOKENS=900 */
  groqModel: process.env.GROQ_MODEL_PODCASTS || "openai/gpt-oss-120b",
  /* ── TWO MODELS, BECAUSE THE DAILY BUDGET IS PER MODEL ───────────────────
   *
   * The first full AI run died two thirds of the way through on a limit that
   * is not per minute at all:
   *     "Rate limit reached ... on tokens per day (TPD): Limit 200000"
   * 12 eligible episodes, 4 processed, 8 refused. One episode costs roughly
   * 25,000 tokens across its passes, so a day's queue wants ~300,000 and the
   * bucket holds 200,000.
   *
   * That bucket is per MODEL. extract.mjs has always asked for `cheap: true`
   * on pass 1 — the per-chunk read, which is 80% of the calls and nearly all
   * of the tokens — and the Groq provider was throwing the flag away and
   * spending one model's allowance on everything.
   *
   * Honouring it puts the bulk reading on 20b and leaves 120b's allowance for
   * passes 2/4/5, the judgement over a short list that decides whether the
   * page is worth reading. Two buckets, each 200k, and the volume lands in
   * the one whose job is volume. This is the same split config already
   * describes for Anthropic — it simply never reached Groq. */
  groqModelCheap: process.env.GROQ_MODEL_CHEAP || "openai/gpt-oss-20b",
  /* Overridable ONLY so the refusal paths can be exercised against a local
     server. Groq answers the same refusal under two status codes and the
     handler for one of them was wrong for months, undetectably, because
     nothing could reach that branch without the live endpoint. */
  groqUrl: process.env.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions",
  /* gpt-oss models think before answering and bill those hidden tokens to
     max_tokens. "low" is what makes the budget reach the answer. Ignored by
     models that do not reason, so it is safe to send unconditionally. */
  groqReasoningEffort: process.env.GROQ_REASONING_EFFORT || "low",
  /* The free tier is token-per-minute limited, so calls are serialised and
     spaced rather than raced into a 429. */
  groqGapMs: int(process.env.GROQ_GAP_MS, 2500),
  /* OUTPUT tokens per minute is the binding limit on the free tier, and it is
     enforced on the REQUEST: asking for 8,000 output tokens is refused before a
     single token is generated — "Request too large ... on output tokens per
     minute (OTPM)" — so a retry cannot help. Ask for less instead.

     4,000 is what gpt-oss-120b accepts on this account, verified against the
     live endpoint rather than read off a pricing page. It is a CEILING, not a
     target: a chunk costs ~500 output tokens, and the headroom is there so a
     long answer truncates nowhere. Lower it with the model, not on its own —
     under a reasoning model, too small a budget spends everything thinking
     and returns an empty 200. */
  groqMaxTokens: int(process.env.GROQ_MAX_TOKENS, 4000),
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

  /* THE COOKIE JAR IS THE DIFFERENCE BETWEEN A FEED AND AN EMPTY PAGE.
   *
   * YouTube answers an anonymous caption request from this IP with HTTP 429,
   * and a datacentre IP with "Sign in to confirm you're not a bot". Measured
   * on 2026-09-19 against KE2YjADcfvA, which had failed every run that day:
   * anonymous → 429 in two seconds; with Safari's cookies → 13,968 bytes of
   * subtitles, first try, same minute. It is not the rate of our requests. It
   * is that they are signed out.
   *
   * Empty by default, so CI — which has no browser and must not pretend to —
   * behaves exactly as before. YTDLP_COOKIES_FROM_BROWSER=safari|chrome reads
   * the live browser profile; YTDLP_COOKIES_FILE points at an exported jar for
   * a machine where the browser database is unreadable (a launchd job without
   * Full Disk Access is the case that bites).
   *
   * THE TRADE, STATED: these are a real logged-in session. yt-dlp's own FAQ
   * warns that heavy automated use of account cookies can get the account
   * flagged. This job makes a few dozen caption requests a morning, which is
   * not heavy — but it is not zero either, and that is Akshay's call to make
   * rather than a default to switch on quietly. */
  ytdlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || "",
  ytdlpCookiesFile: process.env.YTDLP_COOKIES_FILE || "",
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
     signal matched the single most common word in conversational speech.
     2026-09-14.a: the interpretation layer actually runs. Every episode now on
     the page was written by the extractive path, which cannot say why a point
     matters; without this bump they would keep their fragments forever. */
  promptVersion: "2026-09-14.a",

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
