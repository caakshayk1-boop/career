/**
 * http.mjs — one fetch wrapper for every network call in the pipeline.
 *
 * WHY THIS IS NOT JUST fetch(). Three of the four services this job talks to
 * rate-limit, and all four occasionally hang. A bare fetch() has no timeout at
 * all in Node — the default is "wait forever" — so a single stalled TTS request
 * would hold a GitHub Actions runner until the 6-hour job limit killed it, and
 * the morning refresh would simply not happen. Every call goes through here.
 *
 * RETRY POLICY. Retry only what retrying can fix: network faults, 408, 429 and
 * 5xx. A 400 or a 401 means the request or the key is wrong, and hammering it
 * four more times turns one clear error into four confusing ones.
 */
import { log } from "./log.mjs";

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} ${url}${body ? ` — ${String(body).slice(0, 200)}` : ""}`);
    this.status = status;
    this.retryable = RETRYABLE.has(status);
  }
}

/**
 * @param {object} o
 * @param {number} o.timeout   per-attempt timeout in ms
 * @param {number} o.retries   attempts AFTER the first
 * @param {"json"|"text"|"buffer"|"response"} o.as
 */
/** "fetch failed" says nothing; the cause (ECONNRESET, ENOTFOUND, ETIMEDOUT…)
 *  is what tells a sleeping laptop from a dead host. Keep the message, add it. */
export function describeNetError(e, label) {
  if (!e || e.name !== "TypeError" || !e.cause) return e;
  const c = e.cause;
  const why = [c.code, c.message].filter(Boolean).join(" ");
  return Object.assign(new Error(`${e.message} (${label}: ${why})`), { cause: c });
}

export async function request(url, {
  method = "GET", headers = {}, body, timeout = 30000, retries = 3,
  as = "text", label = "http",
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) {
      /* Exponential with jitter. Without the jitter, several sources that all
         429 at once retry in lockstep and 429 again together. */
      const wait = Math.min(16000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      log.warn(label, `retry ${attempt}/${retries} in ${wait}ms`, { url: short(url) });
      await sleep(wait);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: "follow" });
      if (!res.ok) {
        /* Honour Retry-After when the server bothers to send one; guessing is
           strictly worse than being told. */
        const ra = Number(res.headers.get("retry-after"));
        const err = new HttpError(res.status, url, await res.text().catch(() => ""));
        if (err.retryable && attempt < retries) {
          if (Number.isFinite(ra) && ra > 0 && ra < 120) await sleep(ra * 1000);
          lastErr = err;
          continue;
        }
        throw err;
      }
      if (as === "response") return res;
      if (as === "json") return await res.json();
      if (as === "buffer") return Buffer.from(await res.arrayBuffer());
      return await res.text();
    } catch (e) {
      const aborted = e.name === "AbortError";
      const fatal = e instanceof HttpError && !e.retryable;
      if (fatal || attempt === retries) throw aborted ? new Error(`timeout after ${timeout}ms — ${short(url)}`) : describeNetError(e, short(url));
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const short = (u) => { try { const x = new URL(u); return x.host + x.pathname.slice(0, 40); } catch { return String(u).slice(0, 60); } };
