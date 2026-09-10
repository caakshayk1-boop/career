/**
 * store.mjs — the two files this pipeline owns, and the cache under them.
 *
 * THERE IS NO DATABASE, DELIBERATELY. This site is an assets-only Cloudflare
 * Worker with no server, and the whole product is one reader looking at seven
 * days of episodes. A D1 instance would add a Worker script, a binding, a
 * migration story and a second deploy path in exchange for querying a table
 * that will never hold more than a few hundred rows. Instead:
 *
 *   pipeline/state.json    the ledger — every episode ever seen, so the job is
 *                          idempotent and never pays to process one twice.
 *                          Committed. Small: one line per episode, no bodies.
 *   public/podcasts.json   the published artifact — exactly what the page
 *                          renders, containing only the public retention window.
 *   pipeline/.cache/       transcripts and raw insight JSON, keyed by content.
 *                          gitignored, restored in CI from actions/cache.
 *
 * The split is the point. The ledger is the memory; the artifact is the
 * product; the cache is the money. Losing the cache costs a re-run's API
 * spend. Losing the ledger causes duplicate work and duplicate cards. Losing
 * the artifact costs nothing — the next run rebuilds it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cfg } from "../config.mjs";

export const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex");

/** Stable episode id. Derived from source + the most stable identifier the feed
 *  gives us, in that order of preference: an explicit GUID, else the media URL,
 *  else the page URL, else title+date. NEVER the title alone — shows re-title
 *  episodes after publishing and every one of them would come back as new. */
export function episodeId(sourceId, raw) {
  const key = raw.guid || raw.audioUrl || raw.url || `${raw.title}|${raw.publishedAt}`;
  return `${sourceId}-${sha1(`${sourceId}|${key}`).slice(0, 12)}`;
}

const readJson = (p, fallback) => {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback; }
  catch { return fallback; }
};

/* Written with a trailing newline and 2-space indent so a daily commit produces
   a diff a human can actually read in a PR. */
const writeJson = (p, v) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };

/* ── LEDGER ──────────────────────────────────────────────────────────────── */

export function loadState() {
  const s = readJson(cfg.statePath, null) || { version: 1, episodes: {} };
  s.episodes ||= {};
  return s;
}

export const saveState = (s) => writeJson(cfg.statePath, s);

/**
 * Has this episode already been dealt with? True for anything terminal —
 * published, permanently rejected, or skipped as ineligible.
 *
 * A version bump un-sticks it: an episode processed under an older prompt is
 * eligible again, which is how a prompt improvement gets applied without a
 * separate flag that wipes the ledger.
 */
export function isSettled(state, id) {
  const e = state.episodes[id];
  if (!e || cfg.force) return false;
  if (e.promptVersion !== cfg.promptVersion || e.processingVersion !== cfg.processingVersion) return false;
  return ["PUBLISHED", "REJECTED", "SKIPPED", "NEEDS_REVIEW"].includes(e.status);
}

/** One ledger row. No transcripts, no learnings — those live in the cache and
 *  the artifact. This file is read on every run and must stay small. */
export function remember(state, id, patch) {
  const prev = state.episodes[id] || {};
  state.episodes[id] = {
    ...prev, ...patch, id,
    processingVersion: cfg.processingVersion,
    promptVersion: cfg.promptVersion,
    seenAt: prev.seenAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return state.episodes[id];
}

/* ── CACHE ───────────────────────────────────────────────────────────────── */

const cachePath = (kind, key) => join(cfg.cachePath, kind, sha1(key).slice(0, 2), sha1(key) + ".json");

export function cacheGet(kind, key) { return readJson(cachePath(kind, key), null); }
export function cacheSet(kind, key, value) { writeJson(cachePath(kind, key), value); return value; }

/** Memoise an expensive async step on disk. This one function is why a re-run
 *  after a TTS failure costs nothing: the transcript and the insights are
 *  already on disk and only the audio step repeats. */
export async function cached(kind, key, fn) {
  const hit = cacheGet(kind, key);
  if (hit) return hit;
  return cacheSet(kind, key, await fn());
}

/** Evict cache entries older than the DATA retention window. Bounded growth
 *  matters here — the cache is restored into a CI runner on every run. */
export function pruneCache(days = cfg.dataRetentionDays) {
  const cutoff = Date.now() - days * 86400000;
  let n = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.mtimeMs < cutoff) { unlinkSync(p); n++; }
    }
  };
  walk(cfg.cachePath);
  return n;
}

/* ── PUBLISHED ARTIFACT ──────────────────────────────────────────────────── */

export const loadPublished = () =>
  readJson(cfg.out, null) || { version: 1, episodes: [], days: [] };

export const savePublished = (doc) => writeJson(cfg.out, doc);
