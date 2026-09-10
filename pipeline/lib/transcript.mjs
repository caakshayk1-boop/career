/**
 * transcript.mjs — audio or video in, timestamped segments out.
 *
 * THE OUTPUT SHAPE IS THE CONTRACT, and it is timestamped on purpose:
 *
 *   { provider, language, durationSec, segments: [{ t, d, speaker, text }] }
 *
 * `t` is seconds from the start. Everything the product promises rests on it —
 * "▶ 04:37:12" next to a learning is only trustworthy if the sentence it came
 * from carried its own offset all the way through chunking and extraction. A
 * provider that returns a flat wall of text is accepted but degrades the
 * product to unsourced claims, so it is recorded as such rather than quietly
 * substituted.
 *
 * PROVIDER ORDER. Captions first — free, instant, and already correct for any
 * show that publishes them. Deepgram second, because paid ASR on a 2-hour
 * episode is the single largest line item in this pipeline (~$0.26 at Nova-3
 * pricing) and should never run when a caption track exists.
 */
import { request } from "./http.mjs";
import { log, charge } from "./log.mjs";
import { cfg } from "../config.mjs";
import { cached } from "./store.mjs";
import { readFileSync } from "node:fs";
import { decode } from "./xml.mjs";

export async function getTranscript(ep) {
  /* Keyed by the episode id AND the transcript provider setting: switching from
     captions to Deepgram must not silently reuse the worse transcript. */
  return cached("transcript", `${ep.id}|${cfg.transcriptProvider}`, async () => {
    const order = pickOrder(ep);
    let lastErr;
    for (const name of order) {
      try {
        const t = await PROVIDERS[name](ep);
        if (t && t.segments.length) {
          log.info("transcript", `${ep.id}: ${name}, ${t.segments.length} segments`);
          return t;
        }
        lastErr = new Error(`${name} returned nothing`);
      } catch (e) { lastErr = e; log.warn("transcript", `${name} failed: ${e.message}`); }
    }
    throw lastErr || new Error("no transcript provider available");
  });
}

function pickOrder(ep) {
  if (cfg.transcriptProvider !== "auto") return [cfg.transcriptProvider];
  const order = [];
  if (ep.ytId) order.push("youtube");
  if (cfg.deepgramKey && ep.audioUrl) order.push("deepgram");
  return order;
}

const PROVIDERS = {
  /**
   * YouTube caption tracks.
   *
   * BE HONEST ABOUT THIS ONE: the timedtext endpoint is not a documented API.
   * It works, it needs no key, and it is by far the cheapest transcript
   * available — but it is fetched from a datacentre IP here and Google
   * sometimes answers those with an empty body rather than an error. That is
   * why it is a provider behind an interface and not the pipeline's backbone:
   * when it returns nothing, the run falls through to ASR or the episode is
   * recorded FAILED with the reason. It never degrades into publishing an
   * episode with invented timestamps.
   */
  async youtube(ep) {
    const tracks = await request(
      `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(ep.ytId)}`,
      { timeout: 20000, retries: 2, label: "yt-captions" });
    const langs = [...tracks.matchAll(/lang_code="([^"]+)"/g)].map((m) => m[1]);
    const lang = langs.find((l) => l.startsWith("en")) || langs[0];
    if (!lang) throw new Error("no caption track published for this video");

    const xml = await request(
      `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(ep.ytId)}`,
      { timeout: 25000, retries: 2, label: "yt-captions" });

    const segments = [...xml.matchAll(/<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g)]
      .map((m) => ({
        t: Math.round(parseFloat(m[1])),
        d: Math.round(parseFloat(m[2] || "0")),
        speaker: "",
        /* Caption XML is double-escaped: &amp;#39; is an apostrophe. One decode
           pass leaves &#39; sitting in the text and it reaches the page. */
        text: decode(decode(m[3])).replace(/\s+/g, " ").trim(),
      }))
      .filter((s) => s.text);

    if (!segments.length) throw new Error("caption track was empty");
    return finish("youtube-captions", lang, segments);
  },

  /** Deepgram pre-recorded, from the enclosure URL — no download, no ffmpeg,
   *  no temp files on the runner. Paragraph granularity, not word: a
   *  word-level array on a 2-hour episode is ~25k objects to hold in memory
   *  for no gain, since nothing downstream needs sub-sentence resolution. */
  async deepgram(ep) {
    if (!cfg.deepgramKey) throw new Error("DEEPGRAM_API_KEY not set");
    const res = await request(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&paragraphs=true&punctuate=true",
      {
        method: "POST", as: "json", timeout: 900000, retries: 2, label: "deepgram",
        headers: { authorization: `Token ${cfg.deepgramKey}`, "content-type": "application/json" },
        body: JSON.stringify({ url: ep.audioUrl }),
      });

    const alt = res?.results?.channels?.[0]?.alternatives?.[0];
    const paras = alt?.paragraphs?.paragraphs || [];
    const segments = paras.map((p) => ({
      t: Math.round(p.start),
      d: Math.round(p.end - p.start),
      speaker: p.speaker != null ? `S${p.speaker}` : "",
      text: (p.sentences || []).map((s) => s.text).join(" ").trim(),
    })).filter((s) => s.text);

    if (!segments.length && alt?.transcript) {
      /* Diarisation off or unavailable. Still usable, but it has no offsets, so
         mark it: validation refuses to attach timestamps it cannot support. */
      return { ...finish("deepgram", "en", [{ t: 0, d: 0, speaker: "", text: alt.transcript }]), timestamped: false };
    }
    charge({});
    return finish("deepgram", res?.results?.channels?.[0]?.detected_language || "en", segments);
  },

  /**
   * Offline provider, for rehearsing a run without paying for one.
   *
   * Takes segments from the episode record (how the unit suite injects them) or
   * from a JSON file named by FIXTURE_TRANSCRIPT (how you rehearse the whole
   * path against a real feed, before spending anything on a real transcript):
   *
   *   TRANSCRIPT_PROVIDER=fixture FIXTURE_TRANSCRIPT=./sample.json npm run podcasts:dry
   *
   * It is a provider like any other, so nothing downstream knows or cares —
   * which is the point of the interface.
   */
  async fixture(ep) {
    if (ep.fixtureTranscript) return finish("fixture", "en", ep.fixtureTranscript);
    const path = process.env.FIXTURE_TRANSCRIPT;
    if (!path) throw new Error("no fixture transcript supplied and FIXTURE_TRANSCRIPT is not set");
    const segs = JSON.parse(readFileSync(path, "utf8"));
    return finish("fixture", "en", Array.isArray(segs) ? segs : segs.segments || []);
  },
};

function finish(provider, language, segments) {
  segments.sort((a, b) => a.t - b.t);
  const last = segments[segments.length - 1];
  return {
    provider, language, segments, timestamped: true,
    durationSec: last ? last.t + (last.d || 0) : 0,
    chars: segments.reduce((n, s) => n + s.text.length, 0),
  };
}

/**
 * Quality gate. A transcript that is too short, or that is mostly the same
 * sentence repeated (what a stuck ASR stream produces), cannot yield ten real
 * ideas, and running four AI passes over it is money spent to produce
 * something validation will reject anyway. Cheaper to stop here.
 */
export function assessQuality(t, ep) {
  const problems = [];
  const minutes = (t.durationSec || ep.durationSec || 0) / 60;
  const wordsPerMin = minutes ? t.chars / 5 / minutes : 0;

  if (t.chars < 6000) problems.push(`transcript is only ${t.chars} characters`);
  if (minutes > 20 && wordsPerMin < 40) problems.push(`${Math.round(wordsPerMin)} words/min — the transcript has gaps`);

  const lines = t.segments.map((s) => s.text.toLowerCase());
  const unique = new Set(lines).size;
  if (lines.length > 40 && unique / lines.length < 0.45)
    problems.push(`${Math.round((1 - unique / lines.length) * 100)}% of lines are duplicates`);

  return { ok: problems.length === 0, problems, wordsPerMin: Math.round(wordsPerMin) };
}
