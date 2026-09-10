/**
 * ingest.mjs — sources in, candidate episodes out.
 *
 * This layer knows nothing about AI. Its only job is to turn a feed URL into a
 * list of episode records with a STABLE id, and to say which of them are worth
 * spending money on. Everything downstream assumes those two things.
 *
 * ELIGIBILITY IS COST CONTROL, not curation. An episode is skipped here if it
 * is too old (the site only shows 7 days, so processing a 3-week-old episode
 * buys a card that is deleted before anyone sees it), too short (a 12-minute
 * news round-up does not contain ten ideas), or too long (a 6-hour stream is
 * usually a stream, and the transcript cost is superlinear in practice because
 * of the merge pass). Each skip is recorded with its reason — a silent skip is
 * indistinguishable from a bug.
 */
import { request } from "./http.mjs";
import { log, run } from "./log.mjs";
import { cfg } from "../config.mjs";
import { episodeId } from "./store.mjs";
import { items, tag, attr, stripHtml, durationSeconds, decode } from "./xml.mjs";

const YT_ID = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;

/** Discover from one configured source. Never throws: one dead feed must not
 *  take the other four down with it. */
export async function discover(source) {
  if (source.type === "desk") return discoverDesk(source);
  try {
    const xml = await request(feedUrl(source), {
      timeout: 25000, retries: 3, label: "ingest",
      headers: { "user-agent": "career.askakshay.com podcast-intelligence/1.0" },
    });
    const raw = items(xml).map((block) => parseItem(block, source)).filter(Boolean);
    log.info("ingest", `${source.id}: ${raw.length} items`);
    run.counts.discovered += raw.length;
    return raw;
  } catch (e) {
    log.fail("ingest", source.id, e.message);
    return [];
  }
}

/** A YouTube channel is read through its Atom feed — a documented, stable
 *  endpoint that needs no API key. Scraping the channel page instead is the
 *  kind of thing that works until Google ships a layout change on a Tuesday. */
function feedUrl(s) {
  if (s.type === "youtube" && /^UC[\w-]{22}$/.test(s.url))
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${s.url}`;
  return s.url;
}

function parseItem(block, source) {
  const title = tag(block, "title");
  if (!title) return null;

  /* Atom (YouTube) puts the URL in an attribute and the id in <yt:videoId>;
     RSS puts them in <link> and <guid>. Try both shapes rather than branching
     on source.type — some shows publish an Atom feed and are not YouTube. */
  const url = tag(block, "link") || attr(block, "link", "href") || tag(block, "id");
  const audioUrl = attr(block, "enclosure", "url") || attr(block, "media:content", "url");
  const publishedAt = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated");
  const ytId = tag(block, "yt:videoId") || (url.match(YT_ID) || [])[1] || "";

  /* PODCASTING 2.0 <podcast:transcript>. This is the difference between a
     free pipeline and a paid one: a show that publishes a transcript URL costs
     nothing to read, and one that does not needs paid ASR at ~$0.26 an episode.
     Increasingly common and worth preferring wherever it exists.
     Several are often listed (VTT, SRT, JSON, HTML) — take the first machine
     -readable one and ignore the HTML, which is a web page, not a transcript. */
  const transcripts = [...block.matchAll(/<podcast:transcript\b[^>]*>/gi)].map((m) => ({
    url: (m[0].match(/\burl\s*=\s*"([^"]*)"|\burl\s*=\s*'([^']*)'/i) || []).slice(1).find(Boolean) || "",
    type: ((m[0].match(/\btype\s*=\s*"([^"]*)"|\btype\s*=\s*'([^']*)'/i) || []).slice(1).find(Boolean) || "").toLowerCase(),
  })).filter((t) => t.url);
  const transcript = transcripts.find((t) => /vtt|srt|subrip|json/.test(t.type)) || null;

  const rec = {
    sourceId: source.id,
    show: source.show || source.id,
    type: ytId ? "youtube" : "rss",
    title,
    url: ytId ? `https://www.youtube.com/watch?v=${ytId}` : url,
    ytId,
    audioUrl,
    transcriptUrl: transcript ? decode(transcript.url) : "",
    transcriptType: transcript ? transcript.type : "",
    guid: tag(block, "guid") || tag(block, "id") || "",
    publishedAt: toIso(publishedAt),
    durationSec: durationSeconds(tag(block, "itunes:duration")),
    description: stripHtml(tag(block, "description") || tag(block, "media:description") || tag(block, "summary")).slice(0, 2000),
    image: attr(block, "itunes:image", "href") || attr(block, "media:thumbnail", "url") || source.image || "",
  };
  rec.id = episodeId(source.id, rec);
  return rec;
}

/* RFC-822 (RSS) and ISO-8601 (Atom) both parse with Date, but a feed with a
   malformed date must not produce "Invalid Date" and silently sort to the top
   of the day list. An unparseable date means we do not know when it aired,
   which makes it ineligible — handled by the caller. */
function toIso(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

/**
 * The desk feed — the podcast list this site already had.
 *
 * WHY THIS IS A SOURCE AND NOT A FALLBACK. §12 has listed these episodes since
 * before any of this existed, and the first version of Podcast Intelligence
 * REPLACED that list the moment it processed one episode of its own. That is
 * the wrong shape: the desk feed is the curated list of what to read, so it
 * belongs at the front of the pipeline, not behind it as a consolation prize.
 *
 * It carries no media URL and no transcript — just a title, a show and a link —
 * so what happens next depends entirely on where that link points. A YouTube
 * link can be read for free. Anything else is listed as PENDING rather than
 * dropped, because an episode disappearing from the page is exactly the
 * complaint this is fixing.
 */
async function discoverDesk(source) {
  try {
    const doc = await request(source.url, {
      timeout: 25000, retries: 3, label: "desk", as: "json",
      headers: { "user-agent": "career.askakshay.com podcast-intelligence/1.0" },
    });

    /* Read it exactly as index.html reads it, key fallbacks and all — the
       producer lives in another repo and the two must not disagree about what
       the payload is called. */
    const pod = doc?.desk?.podcasts ?? doc?.podcasts;
    const list = (pod && (pod.episodes || pod.items)) || (Array.isArray(pod) ? pod : []);

    if (list.length) {
      /* Logged once per run: the shape is defined elsewhere and this is the
         only way a change in it becomes visible before it becomes a bug. */
      log.info("desk", `keys on the first item: ${Object.keys(list[0]).join(",")}`);
    }

    const out = list.map((e) => {
      const url = e.link || e.url || "";
      const ytId = (String(url).match(YT_ID) || [])[1] || "";
      const rec = {
        sourceId: source.id,
        show: e.show || e.author || e.podcast || source.show || "Podcast",
        type: ytId ? "youtube" : "link",
        title: e.title || "",
        url, ytId,
        audioUrl: e.audio || e.enclosure || "",
        transcriptUrl: e.transcript || "",
        transcriptType: "",
        guid: url || e.id || e.guid || e.title || "",
        publishedAt: toIso(e.published || e.date || e.pubDate) || new Date().toISOString(),
        durationSec: durationSeconds(e.duration),
        description: stripHtml(e.summary || e.description || ""),
        image: e.image || e.thumbnail || "",
        /* Whatever one-liner the feed already carried. Kept so a PENDING entry
           still shows what it always showed rather than becoming a bare title. */
        deskTakeaways: [].concat(e.takeaways || e.takeaway || []).filter(Boolean).map(String),
        /* CURATED. The desk feed is today's list — somebody already decided
           these are the episodes worth knowing about. Filtering them by air
           date is the wrong question: an episode that aired three weeks ago and
           appears in today's digest belongs on today's page. Eligibility skips
           the age check for these, and retention dates them by the digest. */
        curated: true,
      };
      rec.id = episodeId(source.id, rec);
      return rec;
    }).filter((r) => r.title);

    log.info("ingest", `${source.id}: ${out.length} items`);
    run.counts.discovered += out.length;
    return out;
  } catch (e) {
    log.fail("ingest", source.id, e.message);
    return [];
  }
}

/**
 * @returns {{eligible: object[], skipped: {id:string,title:string,reason:string}[]}}
 */
export function selectEligible(candidates, state, isSettled) {
  const skipped = [];
  const now = Date.now();
  const eligible = [];

  for (const c of candidates) {
    const skip = (reason, pending = false) =>
      skipped.push({ id: c.id, title: c.title, reason, pending, episode: pending ? c : null });

    if (isSettled(state, c.id)) { skip("already processed"); continue; }
    if (!c.publishedAt && !c.curated) { skip("no usable publish date"); continue; }

    if (!c.curated) {
      const ageHours = (now - Date.parse(c.publishedAt)) / 3600000;
      if (ageHours > cfg.maxLookbackHours) { skip(`older than ${cfg.maxLookbackHours}h`); continue; }
      if (ageHours < -2) { skip("published in the future"); continue; }
    }

    /* Duration of 0 means the feed did not declare one. That is common and not
       a reason to skip — the transcript step will find out. Only an explicitly
       declared out-of-range duration is disqualifying. */
    const mins = c.curated ? 0 : c.durationSec / 60;
    if (c.durationSec && mins < cfg.minEpisodeMinutes) { skip(`${Math.round(mins)}m — under the ${cfg.minEpisodeMinutes}m floor`); continue; }
    if (c.durationSec && mins > cfg.maxEpisodeMinutes) { skip(`${Math.round(mins)}m — over the ${cfg.maxEpisodeMinutes}m ceiling`); continue; }
    /* FAIL FAST, AND SAY WHY. An episode with an audio URL and no transcript is
       unreadable unless paid ASR is configured. Discovering that one episode at
       a time, after the run has already spent time on it, produces a morning of
       identical FAILED rows and no obvious cause. Check the configuration here,
       once, and name the fix. */
    /* NOT A DROP. An episode we cannot read is still an episode the reader was
       told about, so it is marked pending and shown as a title — which is what
       it always was — rather than vanishing from the page. Removing content
       because we could not improve it is worse than leaving it alone. */
    if (!transcribable(c)) { skip(untranscribableReason(c), true); continue; }

    eligible.push(c);
  }

  /* Newest first, then hard-capped. The cap is the last thing applied so that a
     day with eight new episodes publishes the three most recent rather than the
     three that happened to sort first alphabetically. */
  eligible.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const over = eligible.splice(cfg.maxDailyEpisodes);
  for (const o of over)
    /* A curated item over the cap is still shown, as a title. Silently dropping
       it recreates the "where did my podcasts go" problem one layer down. */
    skipped.push({ id: o.id, title: o.title, reason: `over the ${cfg.maxDailyEpisodes}/day cap`,
                   pending: Boolean(o.curated), episode: o.curated ? o : null });

  run.counts.eligible += eligible.length;
  run.counts.skipped += skipped.length;
  return { eligible, skipped };
}

const skip2 = (arr, c, reason) => arr.push({ id: c.id, title: c.title, reason });

/** Can this episode be read with the providers actually configured right now? */
export function transcribable(c) {
  if (cfg.transcriptProvider === "fixture") return true;
  if (c.ytId) return true;                              // caption track, free
  if (c.transcriptUrl) return true;                     // <podcast:transcript>, free
  return Boolean(cfg.deepgramKey && c.audioUrl);        // paid ASR
}

const untranscribableReason = (c) =>
  c.audioUrl
    ? "audio only, and no transcript — needs DEEPGRAM_API_KEY, or use a source that publishes captions"
    : "no audio, no video and no transcript — nothing to read";
