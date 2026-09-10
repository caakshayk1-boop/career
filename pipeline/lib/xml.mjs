/**
 * xml.mjs — a deliberately small reader for podcast RSS and YouTube's Atom feed.
 *
 * WHY NOT A LIBRARY. This repo has exactly one devDependency and no build step,
 * and that is a property worth keeping: `npm install` is the whole setup. A
 * general XML parser is 40x the code needed here because it has to handle
 * things podcast feeds never contain. What feeds DO contain and a naive regex
 * gets wrong is CDATA, namespaced tags, attribute-only elements and HTML
 * entities — so those four are handled explicitly and tested against real
 * fixtures. Anything more exotic is a feed we do not read.
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#34": '"' };

export function decode(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
/* Lone surrogates and out-of-range code points throw in fromCodePoint; a feed
   with one bad character must not take down the run. */
const safeChar = (n) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
  ? String.fromCodePoint(n) : "");

/** Strip CDATA wrappers, decode entities, collapse whitespace. */
export function text(raw) {
  if (raw == null) return "";
  return decode(String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    .replace(/\s+/g, " ").trim();
}

/** Text content of the first <tag>…</tag>, namespace-insensitive: `tag("link")`
 *  matches <link>, and `tag("itunes:duration")` matches only that one. */
export function tag(xml, name, { first = true } = {}) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}\\s*>`, first ? "i" : "gi");
  if (first) { const m = xml.match(re); return m ? text(m[1]) : ""; }
  return [...xml.matchAll(re)].map((m) => text(m[1]));
}

/** One attribute off the first matching element — <enclosure url="…"/> and
 *  <media:content url="…"/> carry their payload only in attributes. */
export function attr(xml, name, key) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const el = xml.match(new RegExp(`<${n}\\b[^>]*>`, "i"));
  if (!el) return "";
  const m = el[0].match(new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decode(m[2] ?? m[3] ?? "") : "";
}

/** Split a feed into its item blocks. RSS uses <item>, Atom uses <entry>. */
export function items(xml) {
  const rss = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)].map((m) => m[1]);
  if (rss.length) return rss;
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi)].map((m) => m[1]);
}

/** Remove markup from a description block, keeping the sentence structure.
 *  Feed descriptions are HTML and go straight into a prompt; raw <p> tags are
 *  tokens we pay for and noise the model has to ignore. */
export const stripHtml = (s) =>
  text(String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<\/p>/gi, " ").replace(/<[^>]+>/g, ""));

/** iTunes durations arrive as "8040", "2:14:00" or "14:00". All three, plus
 *  junk, which returns 0 rather than NaN — NaN poisons every comparison
 *  downstream and turns an eligibility check into a silent pass. */
export function durationSeconds(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(":").map((x) => parseInt(x, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
