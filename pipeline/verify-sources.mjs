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
let bad = 0;

console.log(`\n${all.length} sources configured, ${enabled.length} enabled\n`);

for (const s of all) {
  const state = s.enabled === false ? "paused " : "enabled";
  const url = s.type === "youtube" && /^UC[\w-]{22}$/.test(s.url)
    ? `https://www.youtube.com/feeds/videos.xml?channel_id=${s.url}` : s.url;
  process.stdout.write(`  ${state}  ${s.id.padEnd(24)} `);

  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(25000),
      headers: { "user-agent": "career.askakshay.com podcast-intelligence/1.0" } });
    if (!res.ok) { console.log(`HTTP ${res.status}`); bad++; continue; }

    const xml = await res.text();
    const feedTitle = tag(xml, "title");
    const list = items(xml);
    if (!list.length) { console.log("parsed, but contains no items"); bad++; continue; }

    const newest = list[0];
    const mins = Math.round(durationSeconds(tag(newest, "itunes:duration")) / 60);
    const hasMedia = Boolean(attr(newest, "enclosure", "url") || tag(newest, "yt:videoId"));

    console.log(`OK  “${feedTitle.slice(0, 40)}”  ${list.length} items`);
    console.log(`${" ".repeat(35)}newest: ${tag(newest, "title").slice(0, 60)}`);
    console.log(`${" ".repeat(35)}${tag(newest, "pubDate") || tag(newest, "published") || "no date"}${mins ? ` · ${mins}m` : " · no duration declared"}${hasMedia ? "" : " · NO MEDIA URL"}`);

    /* The show title in sources.json is what the page prints. If it disagrees
       with the feed, the page is lying about which podcast this is. */
    if (s.show && feedTitle && !feedTitle.toLowerCase().includes(s.show.toLowerCase().slice(0, 12)))
      console.log(`${" ".repeat(35)}WARNING: configured show "${s.show}" does not match the feed title`);
    if (!hasMedia) bad++;
    if (res.url !== url) console.log(`${" ".repeat(35)}NOTE: redirected to ${res.url}`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    bad++;
  }
  console.log("");
}

console.log(bad ? `${bad} source(s) need attention\n` : "All sources reachable and parseable\n");
process.exit(bad ? 1 : 0);
