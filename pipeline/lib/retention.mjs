/**
 * retention.mjs — what the public sees, and what we remember.
 *
 * THESE ARE TWO DIFFERENT QUESTIONS and conflating them is the mistake this
 * file exists to prevent.
 *
 *   PUBLIC_RETENTION_DAYS (7)   how long an episode stays on the page.
 *   DATA_RETENTION_DAYS (400)   how long we remember that it existed.
 *
 * If the ledger were pruned on the same 7-day clock, the job would rediscover
 * every episode in the feed's back catalogue on day eight and pay to process it
 * again — a site that deletes its own content weekly would re-buy it weekly.
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
        date: mytDate(new Date(e.publishedAt || Date.now())),
        reason: s.reason,
      };
    })
    .filter((p) => {
      const age = daysBetween(p.date, today);
      return age >= 0 && age < cfg.publicRetentionDays;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
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

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    today,
    retentionDays: cfg.publicRetentionDays,
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
