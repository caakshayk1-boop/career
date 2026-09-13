#!/usr/bin/env node
/**
 * verify-sources.mjs — prove every configured feed is the show it claims to be.
 *
 *   npm run podcasts:verify
 *
 * A wrong feed URL is the cheapest possible bug to have and one of the more
 * annoying to notice: a 404 costs a silent morning, and a URL that redirects to
 * a different show costs a page of confidently-wrong content. This fetches each
 * feed, parses it with the same reader the pipeline uses, and prints the show
 * title and newest episode so a human can see at a glance that it is right.
 *
 * Run it after editing sources.json, and set "verified": true by hand — the
 * flag means "a person looked at the output", which is not something a script
 * can set for itself.
 */
import { readFileSync } from "node:fs";
import { cfg, loadSources } from "./config.mjs";
import { items, tag, attr, durationSeconds } from "./lib/xml.mjs";

const all = JSON.parse(readFileSync(cfg.sourcesPath, "utf8")).sources || [];
const enabled = loadSources();
let bad = 0, unreadable = 0;

const PAID_ASR = Boolean(cfg.deepgramKey);
console.log(`\n${all.length} sources configured, ${enabled.length} enabled`);
console.log(PAID_ASR
  ? "Paid transcription IS configured — audio-only shows can be read.\n"
  : "No paid transcription key. A source is only readable if it publishes a\ntranscript or is a YouTube video with captions.\n");

for (const s of all) {
  const state = s.enabled === false ? "paused " : "enabled";
  const url = s.type === "youtube" && /^UC[\w-]{22}$/.test(s.url)
    ? `https://www.youtube.com/feeds/videos.xml?channel_id=${s.url}` : s.url;
  process.stdout.write(`  ${state}  ${s.id.padEnd(24)} `);

  if (s.type === "youtube" && !/^UC[\w-]{22}$/.test(s.url)) {
    console.log("not a channel id — open the channel, View Source, find \"channelId\"\n");
    if (s.enabled !== false) bad++;
    continue;
  }

  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(25000),
      headers: { "user-agent": "career.askakshay.com podcast-intelligence/1.0" } });
    if (!res.ok) { console.log(`HTTP ${res.status}\n`); bad++; continue; }

    /* The desk source is JSON, not a feed. Reading it with the XML parser
       reported "parsed, but contains no items" for a source that was working
       perfectly — a diagnostic tool that lies about a healthy source is worse
       than no diagnostic at all. */
    if (s.type === "desk") {
      const doc = JSON.parse(await res.text());
      const pod = doc?.desk?.podcasts ?? doc?.podcasts;
      const list = (pod && (pod.episodes || pod.items)) || (Array.isArray(pod) ? pod : []);
      if (!list.length) { console.log("reachable, but carries no podcasts today\n"); continue; }
      const yt = list.filter((e) => /youtu\.?be/.test(e.link || e.url || "")).length;
      console.log(`OK  ${list.length} episodes in today's digest`);
      const pad = " ".repeat(35);
      console.log(`${pad}newest: ${String(list[0].title || "").slice(0, 58)}`);
      console.log(`${pad}${yt} of ${list.length} point at YouTube — NOT readable from CI,`);
      console.log(`${pad}so those are listed on the page rather than read.\n`);
      continue;
    }

    const xml = await res.text();
    const feedTitle = tag(xml, "title");
    const list = items(xml);
    if (!list.length) { console.log("parsed, but contains no items\n"); bad++; continue; }

    const newest = list[0];
    const mins = Math.round(durationSeconds(tag(newest, "itunes:duration")) / 60);
    const ytId = tag(newest, "yt:videoId");
    const hasAudio = Boolean(attr(newest, "enclosure", "url") || attr(newest, "media:content", "url"));
    const transcriptTag = newest.match(/<podcast:transcript\b[^>]*>/i);
    const transcriptUrl = transcriptTag
      ? (transcriptTag[0].match(/\burl\s*=\s*["']([^"']*)["']/i) || [])[1] : "";

    console.log(`OK  \u201c${feedTitle.slice(0, 40)}\u201d  ${list.length} items`);
    const pad = " ".repeat(35);
    console.log(`${pad}newest: ${tag(newest, "title").slice(0, 58)}`);
    console.log(`${pad}${tag(newest, "pubDate") || tag(newest, "published") || "no date"}${mins ? ` \u00b7 ${mins}m` : " \u00b7 no duration declared"}`);

    /* THE QUESTION THAT DECIDES WHETHER THIS SOURCE IS WORTH ENABLING. */
    let how, free = true;
    if (transcriptUrl) how = "publishes a transcript \u2014 free";
    else if (ytId) how = "YouTube captions \u2014 free (subject to the caption track existing)";
    else if (hasAudio && PAID_ASR) { how = "audio only \u2014 paid ASR, ~$0.26/episode"; free = false; }
    else if (hasAudio) { how = "AUDIO ONLY, AND NO WAY TO READ IT \u2014 every episode will be skipped"; free = false; }
    else { how = "no audio, no video, no transcript \u2014 nothing to read"; free = false; }

    console.log(`${pad}transcript: ${how}`);
    if (transcriptUrl) console.log(`${pad}            ${transcriptUrl.slice(0, 70)}`);

    if (!free && s.enabled !== false) {
      unreadable++;
      console.log(`${pad}>> DISABLE THIS SOURCE, or set DEEPGRAM_API_KEY to pay for transcription.`);
    }

    /* The show title in sources.json is what the page prints. If it disagrees
       with the feed, the page is lying about which podcast this is. */
    if (s.show && feedTitle && !feedTitle.toLowerCase().includes(s.show.toLowerCase().slice(0, 12)))
      console.log(`${pad}WARNING: configured show "${s.show}" does not match the feed title`);
    if (res.url !== url) console.log(`${pad}NOTE: redirected to ${res.url}`);
  } catch (e) {
    console.log(`FAILED \u2014 ${e.message}`);
    bad++;
  }
  console.log("");
}

if (unreadable) console.log(`${unreadable} enabled source(s) cannot be read with the current configuration.`);
if (bad) console.log(`${bad} source(s) could not be reached or parsed.`);
if (!bad && !unreadable) console.log("Every enabled source is reachable and readable for free.");
console.log("");
process.exit(bad || unreadable ? 1 : 0);
