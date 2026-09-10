/**
 * audio.mjs — the AudioProvider seam.
 *
 * generateAudio() / getDuration() / deleteAudio(), one interface, two
 * implementations: elevenlabs and none. "none" is not a stub for a missing
 * feature — it is the correct configuration for a deployment that has not
 * bought a TTS key, and the site is fully usable in it. Text is the product;
 * audio is the convenience.
 *
 * AUDIO IS GENERATED LAST, AND ONLY AFTER VALIDATION PASSES. Synthesising eight
 * minutes of speech for an episode that validation then rejects is the most
 * expensive way to waste money in this pipeline, and it is the ordering mistake
 * that is easiest to make.
 */
import { request } from "./http.mjs";
import { log, charge } from "./log.mjs";
import { cfg } from "../config.mjs";
import { putObject, r2Configured } from "./r2.mjs";

export function makeAudio(name = cfg.ttsProvider) {
  const impl = PROVIDERS[name];
  if (!impl) throw new Error(`unknown TTS provider "${name}"`);
  return impl();
}

/* mp3_44100_128 is constant bitrate, so duration is exactly bytes*8/128000.
   Requesting a variable-bitrate format would make this estimate wrong and
   there is no ffprobe on the runner to fall back to. */
const BITRATE = 128000;
export const durationFromBytes = (bytes) => Math.round((bytes * 8) / BITRATE);

const PROVIDERS = {
  none: () => ({
    name: "none",
    async generateAudio() { return null; },
    async deleteAudio() {},
  }),

  elevenlabs: () => ({
    name: "elevenlabs",

    /**
     * @param {string} script  the words to be spoken, nothing else
     * @param {string} key     object key, e.g. "briefings/<episode id>.mp3"
     */
    async generateAudio(script, key) {
      if (!cfg.elevenKey) throw new Error("ELEVENLABS_API_KEY is not set");
      if (!r2Configured()) throw new Error("TTS is configured but R2 is not — there is nowhere to put the file");

      /* The API caps a single request well below the length of an 8-minute
         script, so it is split on paragraph boundaries. previous_text and
         next_text carry prosody across the seam — without them the joins are
         audible as a change of pace mid-sentence. */
      const parts = splitScript(script, 4200);
      const buffers = [];
      for (let i = 0; i < parts.length; i++) {
        const buf = await request(
          `https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoice}?output_format=mp3_44100_128`,
          {
            method: "POST", as: "buffer", timeout: 180000, retries: 3, label: "tts",
            headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
            body: JSON.stringify({
              text: parts[i],
              model_id: cfg.elevenModel,
              previous_text: parts[i - 1] || undefined,
              next_text: parts[i + 1] || undefined,
              voice_settings: { stability: 0.45, similarity_boost: 0.75, speed: 1.0 },
            }),
          });
        buffers.push(buf);
        charge({ ttsChars: parts[i].length });
      }

      /* MP3 frames are self-delimiting, so concatenating the parts produces a
         file every player decodes correctly. This is only true because the
         parts share one codec and sample rate — which is why the format is
         pinned in the query string above rather than left to the default. */
      const mp3 = Buffer.concat(buffers);
      const url = await putObject(key, mp3, "audio/mpeg");
      const duration = durationFromBytes(mp3.length);
      log.info("audio", `${key}: ${(mp3.length / 1e6).toFixed(1)}MB, ~${Math.round(duration / 60)}m`);

      return {
        url, durationSec: duration, bytes: mp3.length,
        provider: "elevenlabs", voice: cfg.elevenVoice, model: cfg.elevenModel,
        generatedAt: new Date().toISOString(),
      };
    },

    /* R2 lifecycle rules delete expired objects far more reliably than a
       nightly job that has to succeed to clean up after itself. Set a 14-day
       rule on the bucket; this exists for the manual case. */
    async deleteAudio() { /* handled by the bucket lifecycle rule */ },
  }),
};

/**
 * Split a script into request-sized parts, cutting at the least audible seam
 * available: a paragraph break first, a sentence end second, a word boundary
 * third. The character-level split at the end is a backstop that should never
 * fire on real text — but "should never" is how a 9,000-character paragraph
 * with no punctuation silently becomes one over-length request that the API
 * rejects at 3am.
 */
export function splitScript(script, max) {
  const out = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  const add = (piece, joiner) => {
    if (!piece) return;
    if (cur && cur.length + joiner.length + piece.length > max) push();
    cur += (cur ? joiner : "") + piece;
  };

  for (const para of String(script).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= max) { add(para, "\n\n"); continue; }
    for (const sentence of para.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [para]) {
      const s = sentence.trim();
      if (s.length <= max) { add(s, " "); continue; }
      /* Longer than a whole request on its own: fall back to words, then to
         raw characters if even a single "word" is oversized. */
      for (const word of s.split(/\s+/)) {
        if (word.length <= max) { add(word, " "); continue; }
        push();
        for (let i = 0; i < word.length; i += max) out.push(word.slice(i, i + max));
      }
    }
  }
  push();
  return out.length ? out : [String(script).slice(0, max)];
}
