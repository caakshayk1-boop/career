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
   * YouTube captions.
   *
   * TWO ROUTES, AND THE ORDER MATTERS.
   *
   * The bare timedtext endpoint needs no key and is the obvious one, but Google
   * serves it EMPTY to datacentre IPs — which is every CI runner. Twelve
   * readable episodes came back "no caption track" from GitHub Actions while
   * having perfectly good auto-captions.
   *
   * The watch page carries `captionTracks` with a SIGNED baseUrl per track.
   * Those URLs carry the parameters the bare endpoint is missing and answer
   * from the same IP it refuses. So: watch page first, bare endpoint as the
   * fallback for when the page is a consent wall but the endpoint replies.
   *
   * Neither is a documented API, and this is why the provider sits behind an
   * interface rather than being the pipeline's backbone. When both fail the
   * episode is LISTED with the reason, never deleted and never published with
   * invented timings.
   */
  async youtube(ep) {
    const tried = [];

    /* InnerTube FIRST. It is the only one of the three that is designed to be
       called by a non-browser, and it is what actually answers from a server. */
    const fromInner = await captionsFromInnerTube(ep.ytId, tried)
      .catch((e) => { tried.push(`innertube: ${e.message.slice(0, 60)}`); return null; });
    if (fromInner) return fromInner;

    const fromPage = await captionsFromWatchPage(ep.ytId, tried)
      .catch((e) => { tried.push(`watch page: ${e.message.slice(0, 60)}`); return null; });
    if (fromPage) return fromPage;

    const fromApi = await captionsFromTimedText(ep.ytId, tried)
      .catch((e) => { tried.push(`timedtext: ${e.message.slice(0, 60)}`); return null; });
    if (fromApi) return fromApi;

    throw new Error(`no caption track reachable — ${tried.join("; ")}`);
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
 * InnerTube — YouTube's own player API, the one the apps use.
 *
 * WHY THIS EXISTS AFTER TWO OTHER ROUTES FAILED. Scraping the watch page and
 * hitting the public timedtext endpoint both assume a browser on a residential
 * connection, and Google withholds captions from datacentre IPs on both. The
 * mobile and TV clients cannot scrape a web page — they call
 * /youtubei/v1/player and are answered — so a request that presents itself as
 * one of those clients gets the caption track list that the web routes are
 * denied. This is what every working server-side transcript tool does.
 *
 * Still undocumented, still Google's to change. It sits behind the same
 * interface as the others and a failure still LISTS the episode.
 */
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // the public web key, in every page

/* Ordered by how reliably each is answered from a server. ANDROID and IOS are
   the ones that work; TVHTML5 is a third shape worth trying before giving up. */
const INNERTUBE_CLIENTS = [
  /* WEB first. It is the shape InnerTube is least fussy about — the mobile
     clients now reject a context missing fields their apps always send, which
     is what the ANDROID and IOS 400s were, and the caption tracks are the same
     either way. */
  { name: "WEB", id: 1,
    ctx: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US",
           userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36,gzip(gfe)" },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },

  { name: "MWEB", id: 2,
    ctx: { clientName: "MWEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" },

  /* The mobile clients want a fuller context than a bare name and version. */
  { name: "ANDROID", id: 3,
    ctx: { clientName: "ANDROID", clientVersion: "19.44.38", androidSdkVersion: 34,
           osName: "Android", osVersion: "14", platform: "MOBILE", hl: "en", gl: "US",
           userAgent: "com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip" },
    ua: "com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip" },

  { name: "IOS", id: 5,
    ctx: { clientName: "IOS", clientVersion: "19.45.4", deviceMake: "Apple", deviceModel: "iPhone16,2",
           osName: "iPhone", osVersion: "18.1.0.22B83", platform: "MOBILE", hl: "en", gl: "US",
           userAgent: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)" },
    ua: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)" },

  /* Last, and with a real version string — "2.0" was rejected as an unsupported
     device, which is the endpoint answering rather than refusing. */
  { name: "TVHTML5", id: 85,
    ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15" },
];

async function captionsFromInnerTube(videoId, tried) {
  for (const client of INNERTUBE_CLIENTS) {
    let data;
    try {
      data = await request(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`, {
        method: "POST", as: "json", timeout: 30000, retries: 1, label: "innertube",
        headers: {
          "content-type": "application/json",
          "user-agent": client.ua,
          "accept-language": "en-US,en;q=0.9",
          "x-youtube-client-name": String(client.id),
          "x-youtube-client-version": client.ctx.clientVersion,
        },
        body: JSON.stringify({ videoId, context: { client: client.ctx },
          contentCheckOk: true, racyCheckOk: true }),
      });
    } catch (e) {
      /* The response body on a 400 says exactly which context field InnerTube
         objected to. Truncating it to 40 characters threw away the only useful
         part and left three identical, unactionable lines in the log. */
      tried.push(`innertube ${client.name}: ${e.message.replace(/\s+/g, " ").slice(0, 180)}`);
      continue;
    }

    /* A playability failure is per-video, not per-client: age gates and private
       videos will refuse every client, so say so once and stop. */
    const status = data?.playabilityStatus?.status;
    if (status && status !== "OK") {
      tried.push(`innertube ${client.name}: ${status}${data.playabilityStatus.reason ? ` (${data.playabilityStatus.reason})` : ""}`);
      continue;
    }

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length) { tried.push(`innertube ${client.name}: no caption tracks`); continue; }

    /* Human English, then auto English, then anything — several of these shows
       are Hindi or Hinglish and an ASR Hindi track beats no transcript. */
    const pick =
      tracks.find((t) => /^en/i.test(t.languageCode || "") && t.kind !== "asr") ||
      tracks.find((t) => /^en/i.test(t.languageCode || "")) ||
      tracks[0];
    if (!pick?.baseUrl) { tried.push(`innertube ${client.name}: track has no url`); continue; }

    const xml = await request(pick.baseUrl, {
      timeout: 30000, retries: 2, label: "yt-captions",
      headers: { "user-agent": client.ua },
    }).catch(() => "");
    const segments = parseTimedText(xml);
    if (!segments.length) { tried.push(`innertube ${client.name}: ${pick.languageCode} track empty`); continue; }

    log.info("transcript", `innertube ${client.name}: ${pick.languageCode}${pick.kind === "asr" ? " (auto)" : ""}`);
    return finish("youtube-captions", pick.languageCode || "en", segments);
  }
  return null;
}

/**
 * The watch page's own caption index.
 *
 * YouTube embeds a player config containing `captionTracks`, each with a signed
 * `baseUrl`. Fetching that URL returns the same timedtext XML the public
 * endpoint would, but with the parameters that make it actually answer.
 */
async function captionsFromWatchPage(videoId, tried) {
  const BROWSER = {
    /* A real browser UA and a consent cookie. Without them the response is a
       cookie wall carrying no player config at all. */
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    cookie: "CONSENT=YES+cb; SOCS=CAI",
  };

  const html = await request(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    { timeout: 30000, retries: 2, label: "yt-page", headers: BROWSER });

  const block = html.match(/"captionTracks":\s*(\[.*?\])/s);
  if (!block) {
    tried.push(/consent\.youtube\.com|CONSENT_BUMP/.test(html)
      ? "watch page: consent wall" : "watch page: no captionTracks in the player config");
    return null;
  }

  let tracks;
  try { tracks = JSON.parse(block[1].replace(/\\u0026/g, "&")); }
  catch { tried.push("watch page: captionTracks did not parse"); return null; }
  if (!Array.isArray(tracks) || !tracks.length) { tried.push("watch page: zero tracks"); return null; }

  /* A human-made English track first, then auto English, then anything at all —
     several of these shows are Hindi or Hinglish, and an ASR Hindi track is far
     better than no transcript. */
  const pick =
    tracks.find((t) => /^en/i.test(t.languageCode || "") && t.kind !== "asr") ||
    tracks.find((t) => /^en/i.test(t.languageCode || "")) ||
    tracks[0];
  if (!pick || !pick.baseUrl) { tried.push("watch page: track carries no url"); return null; }

  const xml = await request(pick.baseUrl.replace(/\\u0026/g, "&"),
    { timeout: 30000, retries: 2, label: "yt-captions", headers: BROWSER });

  const segments = parseTimedText(xml);
  if (!segments.length) { tried.push(`watch page: the ${pick.languageCode} track was empty`); return null; }
  return finish("youtube-captions", pick.languageCode || "en", segments);
}

/** The bare public endpoint. Kept as a fallback: it occasionally answers when
 *  the watch page is a consent wall. */
async function captionsFromTimedText(videoId, tried) {
  const listed = await request(
    `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`,
    { timeout: 20000, retries: 1, label: "yt-captions" }).catch(() => "");
  const langs = [...String(listed).matchAll(/lang_code="([^"]+)"/g)].map((m) => m[1]);
  const manual = langs.find((l) => l.startsWith("en")) || langs[0] || "";

  /* type=list reports MANUALLY UPLOADED tracks only, and almost every podcast
     channel has none. Auto-captions must be asked for by name. */
  const attempts = [
    manual && `lang=${encodeURIComponent(manual)}`,
    "lang=en&kind=asr", "lang=en-US&kind=asr", "lang=hi&kind=asr",
  ].filter(Boolean);

  for (const q of attempts) {
    const xml = await request(
      `https://www.youtube.com/api/timedtext?${q}&v=${encodeURIComponent(videoId)}`,
      { timeout: 25000, retries: 1, label: "yt-captions" }).catch(() => "");
    const segments = parseTimedText(xml);
    if (segments.length) return finish("youtube-captions", manual || "en", segments);
  }
  tried.push(`timedtext: ${attempts.length} variants empty${manual ? `, listed ${langs.join("/")}` : ", none listed"}`);
  return null;
}

/** YouTube's timedtext XML. Entities are DOUBLE-escaped in it — one decode pass
 *  leaves `&#39;` sitting in the text and it reaches the page. */
export function parseTimedText(xml) {
  return [...String(xml).matchAll(/<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => ({
      t: Math.round(parseFloat(m[1])),
      d: Math.round(parseFloat(m[2] || "0")),
      speaker: "",
      text: decode(decode(m[3])).replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
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
