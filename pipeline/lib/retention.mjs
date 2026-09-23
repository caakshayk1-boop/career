/**
 * retention.mjs — what the public sees, and what we remember.
 *
 * THESE ARE TWO DIFFERENT QUESTIONS and conflating them is the mistake this
 * file exists to prevent.
 *
 *   PUBLIC_RETENTION_DAYS (30)  how long an episode stays on the page.
 *   DATA_RETENTION_DAYS (400)   how long we remember that it existed.
 *
 * If the ledger were pruned on the same public clock, the job would rediscover
 * every episode in the feed's back catalogue the day after it expired and pay
 * to process it again — a site that deletes its own content monthly would
 * re-buy it monthly.
 *
 * MAX_PUBLIC_EPISODES (60) is a third, independent bound: the window says how
 * OLD, the ceiling says how MANY. A 30-day window on a good month is a page
 * nobody can load, so when the ceiling binds the oldest go first and the
 * artifact reports the window it is actually showing rather than the one that
 * was configured.
 * The ledger row is a few hundred bytes; the reprocessing is dollars.
 */
import { cfg, mytDate, daysBetween } from "../config.mjs";
import { run } from "./log.mjs";

/**
 * Build the published artifact from the episodes we hold.
 * Episodes outside the public window are simply not written — no delete step,
 * no partial state. The artifact is rebuilt from scratch every run, so a bug in
 * this function is one commit away from being fixed rather than something that
 * has already destroyed data.
 */
/**
 * Episodes the reader was told about but which could not be read.
 *
 * They appear on the page as titles, which is what they were before any of this
 * existed. The alternative — showing only what the pipeline could process — is
 * how a feature that was meant to add depth ends up REMOVING content, and that
 * is exactly what the first version did.
 */
export function buildPending(entries) {
  const today = mytDate();
  return entries
    .filter((s) => s.pending && s.episode)
    .map((s) => {
      const e = s.episode;
      return {
        id: e.id, title: e.title, show: e.show, url: e.url,
        takeaways: e.deskTakeaways || [],
        date: mytDate(e.curated ? new Date() : new Date(e.publishedAt || Date.now())),
        reason: s.reason,
      };
    })
    .filter((p) => {
      const age = daysBetween(p.date, today);
      return age >= 0 && age < cfg.publicRetentionDays;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** The pending rows already on the page, re-filtered through today's window.
 *
 *  Used by --republish, which rebuilds the artifact from the ledger WITHOUT
 *  running discovery and so has no pending list of its own. Writing one anyway
 *  publishes an empty block and deletes every "listed, not read" row from the
 *  page — the exact shape of the regression that removed the reader's own
 *  podcast list the first time. A rebuild is not a re-discovery.
 *
 *  It reads the previous ARTIFACT rather than the ledger on purpose: pending
 *  episodes are deliberately never written to the ledger (that is what keeps
 *  them retryable), so the artifact is the only place they exist.
 */
export function carryPending(prevDoc) {
  const today = mytDate();
  return ((prevDoc && prevDoc.pending) || [])
    .filter((p) => p && p.id && p.date)
    .filter((p) => { const age = daysBetween(p.date, today); return age >= 0 && age < cfg.publicRetentionDays; });
}

/** Merge pending entries from eligibility and from processing failures, keeping
 *  one row per episode. Both paths can name the same episode when a run retries
 *  something that was pending yesterday. */
export function mergePending(...lists) {
  const by = new Map();
  for (const list of lists) for (const p of list || []) if (p && p.id) by.set(p.id, p);
  return [...by.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function buildPublic(episodes, extra = {}) {
  const today = mytDate();

  const live = episodes
    .filter((e) => e.status === "PUBLISHED" && e.date)
    .filter((e) => {
      const age = daysBetween(e.date, today);
      return age >= 0 && age < cfg.publicRetentionDays;
    })
    .sort((a, b) => (b.date === a.date ? (b.publishedAt || "").localeCompare(a.publishedAt || "") : b.date.localeCompare(a.date)));

  /* Oldest first out when the ceiling binds. `live` is already newest-first. */
  const overflow = live.length > cfg.maxPublicEpisodes ? live.length - cfg.maxPublicEpisodes : 0;
  if (overflow) live.length = cfg.maxPublicEpisodes;

  run.counts.pruned = episodes.filter((e) => e.status === "PUBLISHED").length - live.length;

  /* Days are derived from the episodes, not generated as a calendar range: a
     day with nothing worth processing should not render an empty heading. */
  const byDate = new Map();
  for (const e of live) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e.id);
  }

  const days = [...byDate.entries()].map(([date, ids]) => ({
    date, label: dayLabel(date, today), episodeIds: ids,
  }));

  /* What the page should SAY the window is. Advertising 30 days while the
     episode ceiling has trimmed it to 20 is the page lying about itself. */
  const effectiveDays = overflow && live.length
    ? Math.min(cfg.publicRetentionDays, daysBetween(live[live.length - 1].date, today) + 1)
    : cfg.publicRetentionDays;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    today,
    retentionDays: effectiveDays,
    retentionConfigured: cfg.publicRetentionDays,
    trimmedForSize: overflow,
    days,
    episodes: live,
    ...extra,
  };
}

/** "Today" / "Yesterday" / a weekday name. Computed at build time in MYT, which
 *  means the label is correct when the page is deployed and goes stale as the
 *  day turns — the page recomputes it in the browser for exactly that reason. */
function dayLabel(date, today) {
  const age = daysBetween(date, today);
  if (age === 0) return "Today";
  if (age === 1) return "Yesterday";
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}

/** Drop ledger rows past the DATA window. Keeps state.json from growing without
 *  bound over years, while staying far outside any feed's republish horizon. */
export function pruneState(state) {
  const today = mytDate();
  let n = 0;
  for (const [id, e] of Object.entries(state.episodes)) {
    const seen = (e.seenAt || "").slice(0, 10);
    if (seen && daysBetween(seen, today) > cfg.dataRetentionDays) { delete state.episodes[id]; n++; }
  }
  return n;
}
