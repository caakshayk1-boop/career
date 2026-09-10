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

/* CHEAPEST FIRST, ALWAYS. The two free providers are tried before the paid one,
   and the paid one is only reachable when a key exists. On a caption-bearing
   source this pipeline's transcript cost is zero. */
function pickOrder(ep) {
  if (cfg.transcriptProvider !== "auto") return [cfg.transcriptProvider];
  const order = [];
  if (ep.transcriptUrl) order.push("published");   // free — the show published one
  if (ep.ytId) order.push("youtube");              // free — caption track
  if (cfg.deepgramKey && ep.audioUrl) order.push("deepgram"); // ~$0.26/episode
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
    /* type=list reports MANUALLY UPLOADED caption tracks only. Almost every
       podcast channel has none of those and only auto-generated ones, so a bare
       list request comes back empty and the episode looks captionless when it
       is not — which is how sixteen readable YouTube episodes were reported as
       "no caption track published for this video".
       Auto-captions are fetched by asking for them directly with kind=asr. */
    const listed = await request(
      `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(ep.ytId)}`,
      { timeout: 20000, retries: 2, label: "yt-captions" }).catch(() => "");
    const langs = [...String(listed).matchAll(/lang_code="([^"]+)"/g)].map((m) => m[1]);
    const manual = langs.find((l) => l.startsWith("en")) || langs[0] || "";

    /* Ordered cheapest-first in the sense that matters here: a human-made track
       is more accurate than ASR, and English before whatever else exists. */
    const attempts = [
      manual && `lang=${encodeURIComponent(manual)}`,
      "lang=en&kind=asr",
      "lang=en-US&kind=asr",
      "lang=hi&kind=asr",        // several of these shows are Hindi or Hinglish
      manual && `lang=${encodeURIComponent(manual)}&kind=asr`,
    ].filter(Boolean);

    let xml = "";
    for (const q of attempts) {
      xml = await request(
        `https://www.youtube.com/api/timedtext?${q}&v=${encodeURIComponent(ep.ytId)}`,
        { timeout: 25000, retries: 1, label: "yt-captions" }).catch(() => "");
      if (/<text\b/.test(xml)) break;
      xml = "";
    }
    if (!xml) throw new Error(
      `no caption track this endpoint will serve (tried ${attempts.length} variants` +
      `${manual ? `, listed: ${langs.join("/")}` : ", none listed"})`);
    const lang = manual || "en";

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

  /**
   * A transcript the show published itself, via Podcasting 2.0's
   * <podcast:transcript> tag.
   *
   * This is the best transcript available and it is free: it was produced by
   * the publisher, usually from the master audio, often with speaker labels
   * already correct. Where it exists nothing else should run. VTT and SRT are
   * the common formats; JSON appears occasionally and its shape is not
   * standardised, so only the obvious segment arrays are read.
   */
  async published(ep) {
    if (!ep.transcriptUrl) throw new Error("no published transcript for this episode");
    const body = await request(ep.transcriptUrl, { timeout: 45000, retries: 2, label: "transcript" });

    let segments;
    if (/json/.test(ep.transcriptType) || /^\s*[[{]/.test(body)) segments = parseJsonTranscript(body);
    else segments = parseCues(body);

    if (!segments.length) throw new Error(`published transcript parsed to nothing (${ep.transcriptType || "unknown format"})`);
    return finish("published", "en", segments);
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
 * WebVTT and SubRip, which differ in three details and nothing else: SRT
 * numbers its cues, uses a comma before the milliseconds, and has no header.
 * One parser reads both rather than two that drift apart.
 *
 *   00:04:37.120 --> 00:04:41.000
 *   <v Speaker>the text
 */
export function parseCues(body) {
  const out = [];
  const blocks = String(body).replace(/\r\n?/g, "\n").split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() && !/^WEBVTT\b/i.test(l));
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;

    const m = lines[idx].match(/(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3}))?/);
    if (!m) continue;
    const t = num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3]);
    const end = m[6] != null ? num(m[5]) * 3600 + num(m[6]) * 60 + num(m[7]) : t;

    /* <v Alice>text</v> carries the speaker; anything else in angle brackets is
       styling and must not survive into a prompt as tokens we pay for. */
    let text = lines.slice(idx + 1).join(" ");
    const voice = text.match(/<v\s+([^>]+)>/i);
    text = text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    /* Cue-level granularity is far finer than anything downstream needs — a
       2-hour VTT is ~4,000 cues of six words each. Merge consecutive cues from
       the same speaker into sentence-sized segments so chunking has something
       to work with and the offsets stay honest (the FIRST cue's time wins). */
    const speaker = voice ? voice[1].trim() : "";
    const last = out[out.length - 1];
    if (last && last.speaker === speaker && last.text.length < 340 && t - last.t < 45) {
      last.text += " " + text;
      last.d = Math.max(last.d, end - last.t);
    } else {
      out.push({ t, d: Math.max(1, end - t), speaker, text });
    }
  }
  return out;
}
const num = (v) => parseInt(String(v || "0").replace(":", ""), 10) || 0;

/** JSON transcripts have no agreed shape. Read the two that actually occur and
 *  refuse the rest rather than guessing at a field name. */
export function parseJsonTranscript(body) {
  const doc = JSON.parse(body);
  const rows = Array.isArray(doc) ? doc : doc.segments || doc.results || doc.transcript || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    t: Math.round(Number(r.startTime ?? r.start ?? r.t ?? 0)),
    d: Math.max(1, Math.round(Number(r.endTime ?? r.end ?? 0) - Number(r.startTime ?? r.start ?? 0)) || 1),
    speaker: String(r.speaker || r.speakerName || "").trim(),
    text: String(r.body ?? r.text ?? "").replace(/\s+/g, " ").trim(),
  })).filter((r) => r.text && Number.isFinite(r.t));
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
