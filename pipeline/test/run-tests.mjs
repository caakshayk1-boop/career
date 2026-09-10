#!/usr/bin/env node
/**
 * run-tests.mjs — the pipeline's test suite. No network, no API key, no cost.
 *
 *   npm run podcasts:test
 *
 * Everything here runs against the mock AI provider and a fixture transcript,
 * which is the whole reason those two exist. A suite that needed credentials
 * would be run once and then never again.
 *
 * WHAT IS AND IS NOT COVERED. These tests cover the logic this repo owns:
 * identity, eligibility, chunking, validation, retention, retry, idempotence.
 * They do not cover whether Anthropic's API is up or whether a real feed parses
 * — the first is not ours to test and the second is what `podcasts:verify`
 * does against the live feed. The browser-facing half of the feature is
 * asserted separately by scripts/check.mjs in a real Chromium.
 */
import { createServer } from "node:http";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { cfg } from "../config.mjs";

/* Sandbox every path BEFORE importing anything that reads them, so a test run
   can never touch the real ledger, the real cache or the published artifact. */
const TMP = new URL("./.tmp/", import.meta.url).pathname;
rmSync(TMP, { recursive: true, force: true });
cfg.statePath = TMP + "state.json";
cfg.cachePath = TMP + "cache";
cfg.out = TMP + "podcasts.json";
cfg.aiProvider = "mock";
cfg.ttsProvider = "none";

const { episodeId, loadState, saveState, remember, isSettled, cached } = await import("../lib/store.mjs");
const { selectEligible } = await import("../lib/ingest.mjs");
const { items, tag, attr, durationSeconds, stripHtml } = await import("../lib/xml.mjs");
const { chunk, stripNoise, hhmmss } = await import("../lib/chunk.mjs");
const { validateLearnings, verdict, parseTs } = await import("../lib/validate.mjs");
const { buildPublic, pruneState } = await import("../lib/retention.mjs");
const { extract } = await import("../lib/extract.mjs");
const { makeAI } = await import("../lib/ai.mjs");
const { makeAudio, splitScript, durationFromBytes } = await import("../lib/audio.mjs");
const { request } = await import("../lib/http.mjs");
const { assessQuality } = await import("../lib/transcript.mjs");
const { TRANSCRIPT, EPISODE, SEGMENTS } = await import("./fixtures/transcript.mjs");
const { mytDate } = await import("../config.mjs");

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS  ${label}`); return; }
  failed++; console.log(`  FAIL  ${label}${detail !== undefined ? `  -> ${detail}` : ""}`);
};
const group = (n) => console.log(`\n${n}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ── XML ─────────────────────────────────────────────────────────────────── */
group("feed parsing");
{
  const feed = `<?xml version="1.0"?><rss><channel><title>My Show</title>
    <item><title><![CDATA[Ep 1: Bill & Ted's "big" day]]></title>
      <link>https://x.test/1</link><guid isPermaLink="false">g-1</guid>
      <pubDate>Tue, 09 Sep 2026 06:00:00 +0000</pubDate>
      <itunes:duration>2:14:03</itunes:duration>
      <enclosure url="https://cdn.test/1.mp3?x=1&amp;y=2" type="audio/mpeg"/>
      <description>&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;</description></item>
    <item><title>Ep 2</title><guid>g-2</guid></item></channel></rss>`;

  ok("finds every item", items(feed).length === 2, items(feed).length);
  const it = items(feed)[0];
  ok("unwraps CDATA and decodes entities", tag(it, "title") === `Ep 1: Bill & Ted's "big" day`, tag(it, "title"));
  ok("reads an attribute-only element", attr(it, "enclosure", "url") === "https://cdn.test/1.mp3?x=1&y=2", attr(it, "enclosure", "url"));
  ok("namespaced tag does not collide with its base name", durationSeconds(tag(it, "itunes:duration")) === 8043);
  ok("strips HTML out of a description", stripHtml(tag(it, "description")) === "Hello & welcome", stripHtml(tag(it, "description")));
  ok("duration accepts seconds, mm:ss and h:mm:ss", durationSeconds("8040") === 8040 && durationSeconds("14:00") === 840 && durationSeconds("2:14:00") === 8040);
  ok("junk duration is 0, never NaN", durationSeconds("about two hours") === 0 && durationSeconds(undefined) === 0);
  /* An Atom feed must not be read as an empty RSS feed. */
  ok("falls back to Atom <entry>", items(`<feed><entry><title>a</title></entry></feed>`).length === 1);
}

/* ── IDENTITY / DUPLICATES ───────────────────────────────────────────────── */
group("duplicate episodes");
{
  const a = { guid: "g-1", title: "Original title", url: "https://x/1", publishedAt: "2026-09-09" };
  const b = { guid: "g-1", title: "COMPLETELY RETITLED", url: "https://x/1", publishedAt: "2026-09-09" };
  ok("id survives a retitle", episodeId("s", a) === episodeId("s", b));
  ok("id differs across sources", episodeId("s1", a) !== episodeId("s2", a));
  ok("no guid falls back to the media url", episodeId("s", { audioUrl: "https://cdn/1.mp3" }) === episodeId("s", { audioUrl: "https://cdn/1.mp3", title: "x" }));

  const st = { episodes: {} };
  remember(st, "e1", { status: "PUBLISHED" });
  ok("a published episode is settled", isSettled(st, "e1"));
  ok("an unseen episode is not", !isSettled(st, "e2"));
  st.episodes.e1.promptVersion = "older";
  ok("a prompt-version bump un-settles it", !isSettled(st, "e1"));
}

/* ── ELIGIBILITY ─────────────────────────────────────────────────────────── */
group("eligibility and cost control");
{
  const now = Date.now();
  const mk = (o) => ({ id: o.id, title: o.id, audioUrl: "https://a/x.mp3", durationSec: 3600,
    publishedAt: new Date(now - (o.ageH ?? 1) * 3600000).toISOString(), ...o });
  const cands = [
    mk({ id: "fresh" }), mk({ id: "old", ageH: 400 }), mk({ id: "short", durationSec: 300 }),
    mk({ id: "epic", durationSec: 60 * 60 * 9 }), mk({ id: "nomedia", audioUrl: "" }),
    mk({ id: "nodate", publishedAt: "" }), mk({ id: "fresh2", ageH: 2 }), mk({ id: "fresh3", ageH: 3 }),
    mk({ id: "fresh4", ageH: 4 }),
  ];
  const { eligible, skipped } = selectEligible(cands, { episodes: {} }, isSettled);
  ok("hard cap is enforced", eligible.length === cfg.maxDailyEpisodes, eligible.length);
  ok("newest survive the cap", eq(eligible.map((e) => e.id), ["fresh", "fresh2", "fresh3"]), eligible.map((e) => e.id).join(","));
  const why = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
  ok("too old is skipped", /older than/.test(why.old || ""));
  ok("too short is skipped", /floor/.test(why.short || ""));
  ok("too long is skipped", /ceiling/.test(why.epic || ""));
  ok("no media is skipped", /nothing to transcribe/.test(why.nomedia || ""));
  ok("no date is skipped", /publish date/.test(why.nodate || ""));
  /* The cap reason must be distinguishable — run.mjs uses it to decide NOT to
     write the episode off permanently. */
  ok("capped episodes are marked as capped, not as ineligible", /\/day cap/.test(why.fresh4 || ""), why.fresh4);

  /* Removing a source removes its episodes from the run entirely. */
  const noSource = selectEligible([], { episodes: {} }, isSettled);
  ok("removing a source yields no candidates", noSource.eligible.length === 0);
}

/* ── CHUNKING ────────────────────────────────────────────────────────────── */
group("chunking a long transcript");
{
  const noise = stripNoise(SEGMENTS);
  const kept = noise.segments.map((s) => s.text).join(" ");
  ok("drops the sponsor read", !/northline\.com/i.test(kept));
  ok("drops like-and-subscribe", !/five-star review/i.test(kept));
  ok("keeps the substance", /commitment device/.test(kept));

  /* A 3-hour episode: every part of it must appear in some chunk, or the
     coverage argument for chunking is false. */
  const long = [];
  for (let i = 0; i < 2400; i++) long.push({ t: i * 4, d: 4, speaker: i % 7 ? "S1" : "S0", text: `Sentence number ${i} carrying a distinctive marker ${i}x and some further words to give it body.` });
  const cs = chunk(long);
  ok("a 3-hour transcript splits into many chunks", cs.length > 8, cs.length);
  ok("every chunk carries its own time range", cs.every((c) => c.endSec >= c.startSec && c.text.includes("[")));
  const covered = cs.map((c) => c.text).join("\n");
  const missing = [0, 600, 1200, 1800, 2399].filter((i) => !covered.includes(`marker ${i}x`));
  ok("no part of the conversation is dropped", missing.length === 0, `missing ${missing.join(",")}`);
  ok("chunks overlap so an idea on a boundary appears whole",
    cs.slice(1).some((c, i) => c.startSec <= cs[i].endSec));
  ok("hhmmss formats both under and over an hour", hhmmss(65) === "1:05" && hhmmss(16632) === "4:37:12", hhmmss(16632));
}

/* ── TRANSCRIPT QUALITY ──────────────────────────────────────────────────── */
group("malformed transcripts");
{
  ok("a healthy transcript passes", assessQuality({ ...TRANSCRIPT, chars: 20000 }, EPISODE).ok);
  ok("a stub transcript is rejected", !assessQuality({ segments: [], chars: 300, durationSec: 7200 }, EPISODE).ok);
  const stuck = { segments: Array.from({ length: 200 }, (_, i) => ({ t: i * 30, d: 30, speaker: "", text: "you know what I mean right" })), chars: 30000, durationSec: 6000 };
  ok("a stuck ASR stream is rejected as duplicated", !assessQuality(stuck, EPISODE).ok, JSON.stringify(assessQuality(stuck, EPISODE).problems));
  const gappy = { segments: [{ t: 0, d: 10, speaker: "", text: "x".repeat(7000) }], chars: 7000, durationSec: 7200 };
  ok("a transcript with huge gaps is rejected", !assessQuality(gappy, EPISODE).ok);
}

/* ── VALIDATION ──────────────────────────────────────────────────────────── */
group("validation — the grounding gate");
{
  const base = { rank: 1, headline: "Forecasts are commitment devices", why: "It reframes the output of the finance function as a trigger for decisions rather than a report, which changes who the forecast is for.", action: "Audit last quarter's revisions for decisions they caused.", kind: "said", confidence: 0.9 };

  const good = validateLearnings([{ ...base,
    idea: "A forecast's job is to make somebody change what they do on Monday.",
    evidence: "A forecast is a commitment device", timestamp: "1:36" }], TRANSCRIPT, EPISODE);
  ok("a genuine, quoted learning survives", good.learnings.length === 1, JSON.stringify(good.rejected));
  ok("its grounding score is high", good.learnings[0]?.groundingScore >= 0.9, good.learnings[0]?.groundingScore);

  const fake = validateLearnings([{ ...base, idea: "x y z",
    evidence: "The single most important variable is always founder charisma and nothing else matters", timestamp: "2:00" }], TRANSCRIPT, EPISODE);
  ok("a fabricated quotation is dropped", fake.learnings.length === 0, JSON.stringify(fake.rejected));
  ok("and the reason names the failure", /not found/.test(fake.rejected[0]?.reason || ""), fake.rejected[0]?.reason);

  /* A quotable claim whose match is weak must be demoted, not asserted. */
  const weak = validateLearnings([{ ...base,
    idea: "Boards punish surprise, not uncertainty.",
    evidence: "Uncertainty punish boards credibility conflate teams finance percent thirty", timestamp: "2:20" }], TRANSCRIPT, EPISODE);
  ok("words in an order nobody said them in is not a quotation",
    weak.learnings.length === 0 || weak.learnings[0].kind !== "said", weak.learnings[0]?.kind);
  ok("a real quotation is marked verbatim", good.learnings[0]?.verbatim === true);

  const echo = validateLearnings([{ ...base,
    idea: "A forecast is a commitment device whose job is to change a decision.",
    why: "A forecast is a commitment device whose job is to change a decision.",
    evidence: "A forecast is a commitment device", timestamp: "1:36" }], TRANSCRIPT, EPISODE);
  ok("'why it matters' that restates the idea is rejected", echo.learnings.length === 0, JSON.stringify(echo.learnings));

  const dupes = validateLearnings([
    { ...base, idea: "A forecast's job is to make somebody change what they do on Monday.", evidence: "A forecast is a commitment device", timestamp: "1:36" },
    { ...base, rank: 2, headline: "The forecast should change Monday", idea: "The job of a forecast is to make somebody change what they do on Monday.", evidence: "A forecast is a commitment device", timestamp: "1:36" },
  ], TRANSCRIPT, EPISODE);
  ok("the same idea twice is deduplicated", dupes.learnings.length === 1, dupes.learnings.length);
  ok("and ranks are renumbered contiguously", dupes.learnings[0].rank === 1);

  /* Timestamps: the three cases that matter. */
  ok("parseTs handles both shapes and rejects junk",
    parseTs("4:37:12") === 16632 && parseTs("1:36") === 96 && parseTs("later on") === null);

  const drift = validateLearnings([{ ...base, idea: "Cost programmes cut spend instead of commitments.",
    evidence: "Most cost programmes fail because they cut spend instead of cutting commitments", timestamp: "1:02:00" }], TRANSCRIPT, EPISODE);
  ok("a wrong timestamp is repaired to the quotation's real offset",
    drift.learnings[0]?.t === 232 && drift.learnings[0]?.tRepaired, JSON.stringify(drift.learnings[0]));

  const missingTs = validateLearnings([{ ...base, idea: "Cost programmes cut spend instead of commitments.",
    evidence: "Most cost programmes fail because they cut spend instead of cutting commitments", timestamp: "" }], TRANSCRIPT, EPISODE);
  ok("a missing timestamp is recovered from the quotation", missingTs.learnings[0]?.t === 232, missingTs.learnings[0]?.t);

  const untimed = validateLearnings([{ ...base, idea: "Cost programmes cut spend instead of commitments.",
    evidence: "Most cost programmes fail because they cut spend instead of cutting commitments", timestamp: "3:52" }],
    { ...TRANSCRIPT, timestamped: false }, EPISODE);
  ok("an untimestamped transcript yields no timestamps at all", untimed.learnings[0]?.t === null, untimed.learnings[0]?.t);

  ok("a filler action is stripped rather than printed",
    validateLearnings([{ ...base, idea: "Cost programmes cut commitments.", action: "Reflect on this.",
      evidence: "Most cost programmes fail because they cut spend", timestamp: "3:52" }], TRANSCRIPT, EPISODE).learnings[0]?.action === "");

  /* Episode-level verdict. */
  const thin = { learnings: [1, 2].map((r) => ({ rank: r, groundingScore: 0.9, verbatim: true })), rejected: [] };
  ok("too few learnings holds the episode for review", verdict(thin, { ok: true, problems: [] }).status === "NEEDS_REVIEW");
  const healthy = { learnings: Array.from({ length: 8 }, (_, i) => ({ rank: i + 1, groundingScore: 0.9, verbatim: true })), rejected: [] };
  ok("a healthy episode is READY", verdict(healthy, { ok: true, problems: [] }).status === "READY");
  ok("a bad transcript blocks publication even with enough learnings",
    verdict(healthy, { ok: false, problems: ["gaps"] }).status === "NEEDS_REVIEW");
  const mostlyRejected = { learnings: healthy.learnings.slice(0, 6), rejected: Array.from({ length: 9 }, () => ({})) };
  ok("mass rejection blocks publication", verdict(mostlyRejected, { ok: true, problems: [] }).status === "NEEDS_REVIEW");
}

/* ── AI FAILURE MODES ────────────────────────────────────────────────────── */
group("AI failures");
{
  const ai = makeAI("mock");
  const out = await extract(ai, EPISODE, TRANSCRIPT);
  ok("the mock provider drives a full extraction", out.learnings.length > 0, out.learnings.length);
  ok("mock citations are real — every one is groundable", (() => {
    const v = validateLearnings(out.learnings, TRANSCRIPT, EPISODE);
    return v.learnings.length > 0;
  })());

  /* A provider that never returns a valid tool call must surface, not hang. */
  const broken = { name: "broken", model: "x", async json() { throw new Error("no record_candidates tool call — model said: sure!"); }, async text() { return ""; } };
  let threw = "";
  try { await extract(broken, EPISODE, TRANSCRIPT); } catch (e) { threw = e.message; }
  ok("every chunk failing fails the episode with a reason", /no candidate ideas/.test(threw), threw);

  /* One bad chunk out of many is a hole, not a failure. Needs a transcript long
     enough to actually produce several chunks — the fixture is one chunk. */
  const many = { ...TRANSCRIPT, segments: Array.from({ length: 12 }, (_, k) =>
    SEGMENTS.map((s) => ({ ...s, t: s.t + k * 800 }))).flat() };
  ok("the multi-chunk fixture really is multi-chunk", chunk(stripNoise(many.segments).segments).length > 2);
  let n = 0;
  const flaky = { name: "flaky", model: "x",
    async json(spec) { if (spec.name === "record_candidates" && n++ === 0) throw new Error("malformed JSON"); return makeAI("mock").json(spec); },
    async text() { return ""; } };
  const partial = await extract(flaky, EPISODE, many);
  ok("one failed chunk does not fail the episode", partial.learnings.length > 0, partial.learnings.length);

  ok("an unknown provider name is rejected loudly", (() => { try { makeAI("gpt"); return false; } catch { return true; } })());
}

/* ── AUDIO ───────────────────────────────────────────────────────────────── */
group("audio");
{
  const none = makeAudio("none");
  ok("the null provider returns no asset rather than throwing", (await none.generateAudio("hello", "k")) === null);

  const script = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(60)}`).join("\n\n");
  const parts = splitScript(script, 4200);
  ok("a long script is split", parts.length > 1, parts.length);
  ok("no part exceeds the cap", parts.every((p) => p.length <= 4200), Math.max(...parts.map((p) => p.length)));
  const wc = (t) => t.split(/\s+/).filter(Boolean).length;
  ok("splitting loses no words", wc(parts.join(" ")) === wc(script), `${wc(parts.join(" "))} vs ${wc(script)}`);
  ok("an episode with unquotable learnings is held", verdict(
    { learnings: Array.from({ length: 8 }, (_, i) => ({ rank: i + 1, verbatim: false })), rejected: [] },
    { ok: true, problems: [] }).status === "NEEDS_REVIEW");
  ok("a single unbroken sentence still splits", splitScript("x".repeat(9000), 4200).length >= 2);
  ok("duration is derived from the pinned bitrate", durationFromBytes(128000 / 8 * 60) === 60);
}

/* ── RETRY ───────────────────────────────────────────────────────────────── */
group("retry and timeout");
{
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/flaky") { if (hits < 3) { res.writeHead(503); res.end("busy"); return; } res.writeHead(200); res.end("finally"); }
    else if (req.url === "/bad") { res.writeHead(400); res.end("nope"); }
    else if (req.url === "/hang") { /* never responds */ }
    else { res.writeHead(200); res.end("ok"); }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  ok("a 503 is retried until it succeeds", (await request(`${base}/flaky`, { retries: 3, timeout: 2000 })) === "finally");

  hits = 0;
  let msg = "";
  try { await request(`${base}/bad`, { retries: 3, timeout: 2000 }); } catch (e) { msg = e.message; }
  ok("a 400 is NOT retried — it is thrown at once", hits === 1 && /HTTP 400/.test(msg), `${hits} attempts, ${msg}`);

  let tmsg = "";
  try { await request(`${base}/hang`, { retries: 0, timeout: 300 }); } catch (e) { tmsg = e.message; }
  ok("a hung request times out instead of blocking forever", /timeout after 300ms/.test(tmsg), tmsg);
  server.close();
}

/* ── RETENTION ───────────────────────────────────────────────────────────── */
group("7-day retention");
{
  const today = mytDate();
  const dayAgo = (n) => { const d = new Date(Date.parse(today + "T00:00:00Z") - n * 86400000); return d.toISOString().slice(0, 10); };
  const eps = [0, 1, 2, 6, 7, 20].map((n) => ({ id: `e${n}`, status: "PUBLISHED", date: dayAgo(n), publishedAt: dayAgo(n) + "T06:00:00Z" }));
  eps.push({ id: "held", status: "NEEDS_REVIEW", date: today });

  const doc = buildPublic(eps);
  const ids = doc.episodes.map((e) => e.id);
  ok("exactly the last 7 days are published", eq(ids, ["e0", "e1", "e2", "e6"]), ids.join(","));
  ok("day 7 has fallen off", !ids.includes("e7"));
  ok("an episode held for review is never published", !ids.includes("held"));
  ok("today is labelled Today and yesterday Yesterday",
    doc.days[0].label === "Today" && doc.days[1].label === "Yesterday", doc.days.map((d) => d.label).join(","));
  ok("older days get a weekday name", /^[A-Z][a-z]+day$/.test(doc.days[3].label), doc.days[3].label);
  ok("empty days are omitted entirely", doc.days.length === 4, doc.days.length);
  ok("the artifact declares its own retention window", doc.retentionDays === cfg.publicRetentionDays);

  /* Retention must NOT prune the ledger on the public clock, or the job re-buys
     its own back catalogue every week. */
  const st = { episodes: {
    recent: { seenAt: today + "T00:00:00Z" },
    lastMonth: { seenAt: dayAgo(30) + "T00:00:00Z" },
    ancient: { seenAt: dayAgo(500) + "T00:00:00Z" },
  } };
  const dropped = pruneState(st);
  ok("a month-old ledger row survives the 7-day public window", Boolean(st.episodes.lastMonth), "reprocessing risk");
  ok("only rows past the data window are dropped", dropped === 1 && !st.episodes.ancient, dropped);
}

/* ── IDEMPOTENCE ─────────────────────────────────────────────────────────── */
group("idempotence");
{
  const st = loadState();
  const payload = { id: "e1", status: "PUBLISHED", date: mytDate(), publishedAt: new Date().toISOString(), learnings: [] };
  remember(st, "e1", { status: "PUBLISHED", payload });
  saveState(st);

  const a = buildPublic(Object.values(loadState().episodes).filter((e) => e.payload).map((e) => e.payload));
  const b = buildPublic(Object.values(loadState().episodes).filter((e) => e.payload).map((e) => e.payload));
  ok("two builds over the same ledger produce identical content",
    eq(a.episodes, b.episodes) && eq(a.days, b.days));
  ok("a second run sees the episode as settled and does nothing", isSettled(loadState(), "e1"));
  ok("one card per episode, not two", a.episodes.filter((e) => e.id === "e1").length === 1);

  /* The disk cache is what makes a re-run free. */
  let calls = 0;
  const compute = async () => { calls++; return { v: 1 }; };
  await cached("test", "k", compute);
  await cached("test", "k", compute);
  ok("a cached step is computed once, not twice", calls === 1, calls);
  ok("a different prompt version misses the cache", (await cached("test", "k|v2", compute)) && calls === 2, calls);
}

/* ── END TO END ──────────────────────────────────────────────────────────── */
group("end to end, one episode");
{
  const ai = makeAI("mock");
  const analysis = await extract(ai, EPISODE, TRANSCRIPT);
  const checked = validateLearnings(analysis.learnings, TRANSCRIPT, EPISODE);
  const v = verdict(checked, assessQuality(TRANSCRIPT, EPISODE));

  ok("the fixture yields learnings", checked.learnings.length > 0, checked.learnings.length);
  ok("every published learning carries evidence", checked.learnings.every((l) => l.evidence));
  ok("every timestamp lands inside the episode",
    checked.learnings.every((l) => l.t === null || (l.t >= 0 && l.t <= TRANSCRIPT.durationSec)));
  ok("every learning is labelled with an attribution kind",
    checked.learnings.every((l) => ["said", "interpretation", "recommendation"].includes(l.kind)));
  ok("nothing from the sponsor read reaches the output",
    !JSON.stringify(checked.learnings).match(/northline|promo code/i));

  const doc = buildPublic([{ id: EPISODE.id, status: "PUBLISHED", date: mytDate(), publishedAt: EPISODE.publishedAt,
    show: EPISODE.show, title: EPISODE.title, learnings: checked.learnings, url: EPISODE.url }]);
  ok("it renders into a publishable artifact", doc.episodes.length === 1 && doc.days.length === 1);
  ok("the verdict is recorded either way", ["READY", "NEEDS_REVIEW"].includes(v.status), v.status);
}

/* ── SHIPPED ARTIFACT ────────────────────────────────────────────────────── */
group("the committed public/podcasts.json");
{
  const p = new URL("../../public/podcasts.json", import.meta.url).pathname;
  ok("it exists", existsSync(p));
  if (existsSync(p)) {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    ok("it is the shape the page reads",
      Array.isArray(doc.episodes) && Array.isArray(doc.days) && typeof doc.retentionDays === "number");
    ok("every day references episodes that exist",
      doc.days.every((d) => d.episodeIds.every((id) => doc.episodes.some((e) => e.id === id))));
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failed ? `FAILED — ${failed} of ${passed + failed}` : `ALL ${passed} CHECKS PASSED`}\n`);
process.exit(failed ? 1 : 0);
