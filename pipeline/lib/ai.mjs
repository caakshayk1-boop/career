/**
 * ai.mjs — the AIProvider seam.
 *
 * Nothing above this file knows which model answered. Everything above it calls
 * `ai.json(spec)` and gets back an object that already matches a schema. Two
 * providers ship:
 *
 *   anthropic — the real one.
 *   mock      — deterministic, offline, no key. The test suite runs the entire
 *               pipeline through it, which is the only reason this thing can be
 *               tested at all without spending money on every commit.
 *
 * WHY STRICT TOOL USE AND NOT "RETURN JSON". Asking a model for JSON in prose
 * and then JSON.parse()-ing the reply fails a few percent of the time — a
 * markdown fence, a trailing comma, a chatty preamble — and every one of those
 * failures lands at the end of a pipeline that has already paid for a
 * transcript. `strict: true` on a tool with `additionalProperties: false`
 * makes the API itself guarantee the arguments validate, so the failure mode
 * moves from "malformed JSON at 3am" to "no tool call", which is trivially
 * detectable.
 *
 * `tool_choice` is left on auto rather than forced: forced tool choice is
 * rejected by some current models, and AI_MODEL is a configuration knob. An
 * explicit instruction plus a single available tool gets the same result on
 * every model in the family.
 */
import { cfg } from "../config.mjs";
import { log, charge } from "./log.mjs";
import { describeNetError } from "./http.mjs";

/* Published list prices, $ per million tokens. Used only to print an estimate
   at the end of a run — an order-of-magnitude alarm, not an invoice. Stale
   prices here make the estimate wrong; they cannot make the pipeline wrong. */
const PRICES = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  /* Groq's free tier is free. Zero here rather than absent, because an unknown
     model falls back to the Opus row below and would print a run that cost
     nothing as though it cost dollars — an alarm that cries wolf is worse than
     no alarm. */
  "qwen/qwen3.8-27b": { in: 0, out: 0 },
  "qwen/qwen3.6-27b": { in: 0, out: 0 },
  "openai/gpt-oss-120b": { in: 0, out: 0 },
  "openai/gpt-oss-20b": { in: 0, out: 0 },
};

/**
 * @returns {Promise<object>|object} the mock provider is synchronous; the
 * anthropic one is not, because the SDK is loaded on demand.
 *
 * WHY THE SDK IS NOT IMPORTED AT THE TOP. The default pipeline never calls a
 * model, and a top-level import would make a package the free path never uses
 * a hard requirement for running it at all — a bare checkout with no
 * `npm install` would fail on an import for code it was never going to reach.
 * Loading it inside the provider keeps the free path dependency-free and turns
 * a missing install into a clear message at the point of use.
 */
export function makeAI(name = cfg.aiProvider) {
  const impl = PROVIDERS[name];
  if (!impl) throw new Error(`unknown AI provider "${name}"`);
  return impl();
}

export function estimateCost(inTokens, outTokens, model = cfg.aiModel) {
  const p = PRICES[model] || PRICES["claude-opus-5"];
  return (inTokens / 1e6) * p.in + (outTokens / 1e6) * p.out;
}

/* THE MODEL'S OWN TOOL CALL, RECOVERED.
 *
 * Groq validates the arguments the model generated and answers 400
 * `tool_use_failed` when they will not parse — the whole call is lost, however
 * good the rest of the answer was. The two shapes seen are the model emitting
 * the entire envelope, {"name": …, "arguments": {…}}, where the API wanted the
 * arguments object alone, and the same JSON inside a ```json fence.
 *
 * Both are recoverable from `failed_generation` without spending another call.
 * Anything else returns null, so the caller fails loudly rather than
 * publishing half an object — a salvage that guesses is worse than no salvage.
 */
export function salvageToolArguments(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const bare = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let v;
  try { v = JSON.parse(bare); } catch { return null; }
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObj(v)) return null;
  /* Unwrap ONLY the envelope shape: a bare `arguments` key on a schema of our
     own would otherwise be mistaken for one. */
  if (typeof v.name === "string" && "arguments" in v) {
    const a = v.arguments;
    if (isObj(a)) return a;
    if (typeof a === "string") {
      try { const p = JSON.parse(a); return isObj(p) ? p : null; } catch { return null; }
    }
    return null;
  }
  return v;
}

const PROVIDERS = {
  /**
   * Groq — the free one.
   *
   * OpenAI-compatible, so structured output is function calling rather than
   * Anthropic's tools block, and there is no prompt caching: the system prompt
   * is re-sent per chunk. That costs nothing here because the tier is free, but
   * it is why this provider does not try to be clever about prompt ordering.
   *
   * MODEL CHOICE WAS MEASURED, NOT PICKED — and the first measurement blamed
   * the wrong thing. Asked for one schema-constrained tool call over a real
   * 9,000-char transcript chunk:
   *
   *     openai/gpt-oss-120b   5 points, 486 out tokens, 1.8s   (effort "low")
   *     openai/gpt-oss-20b    5 points, 424 out tokens, 0.8s   (effort "low")
   *     qwen/qwen3.8-27b      5 points, 711 out tokens, 2.0s   (richer prose)
   *
   * gpt-oss "returned nothing parseable" on the earlier attempt because that
   * attempt sent no reasoning_effort: it is a REASONING model, the hidden
   * tokens are billed to max_tokens, and the budget ran out before the answer.
   * That is a calling bug, not a model verdict, and it is fixed below.
   *
   * qwen writes the better paragraph and is still NOT the default, because
   * this account caps it at 1,000 output tokens per minute — see config.mjs.
   * GROQ_MODEL_PODCASTS overrides; Groq has retired models twice without
   * notice.
   *
   * PACED FOR THE FREE TIER, which is token-per-minute limited. Calls are
   * serialised and spaced; a 429 waits out the window the header names and
   * retries once. Without this an episode's five passes race each other into
   * the limit and the run dies half-written.
   */
  async groq() {
    if (!cfg.groqKey) throw new Error("GROQ_API_KEY is not set");
    const URL = cfg.groqUrl;
    let chain = Promise.resolve(), last = 0;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));

    const gate = () => {
      const w = chain.then(async () => {
        const since = Date.now() - last;
        if (since < cfg.groqGapMs) await nap(cfg.groqGapMs - since);
        last = Date.now();
      });
      chain = w.catch(() => {});
      return w;
    };

    /* PACED BY THE HEADERS, NOT BY A GUESS.
     *
     * A fixed gap cannot work here. The free tier meters tokens per minute, and
     * "Request too large … on output tokens per minute" is not about the size
     * of one request — 2,400 and 900 both succeed in isolation — it is about
     * what is LEFT in the window when the request arrives. A five-pass episode
     * drains it, and the next call is refused however small it is.
     *
     * So the budget is read from every response: x-ratelimit-remaining-tokens
     * and x-ratelimit-reset-tokens say exactly how much is left and when it
     * refills. When the remainder falls under what the next call could plausibly
     * want, wait out the window rather than spend a retry discovering it.
     *
     * Parsed leniently because the reset arrives as "847ms" or "2m52.8s". */
    const resetMs = (v) => {
      const t = String(v || "").trim();
      const m = t.match(/^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
      if (m && (m[1] || m[2])) return (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000;
      const ms = t.match(/^(\d+(?:\.\d+)?)ms$/);
      if (ms) return Number(ms[1]);
      const n = Number(t);
      return Number.isFinite(n) ? n * 1000 : 0;
    };
    let budget = { remaining: Infinity, resetInMs: 0 };

    const post = async (body, attempt = 0, toolAttempt = 0) => {
      await gate();
      /* If the window is nearly spent, wait for it to refill before asking.
         Cheaper than a refusal, and it keeps the run deterministic. */
      if (budget.remaining < cfg.groqMaxTokens * 1.5 && budget.resetInMs > 0) {
        await nap(Math.min(budget.resetInMs + 1500, 90000));
        budget = { remaining: Infinity, resetInMs: 0 };
        last = Date.now();
      }
      /* A NETWORK FAULT IS NOT A VERDICT ON THE EPISODE. Undici reports a
         dropped connection, a DNS miss or a laptop waking from sleep as a bare
         TypeError "fetch failed", and this threw it straight out — failing an
         episode whose transcript had already been read, after up to an hour of
         token pacing. Six of eight episodes on 2026-09-25 died that way. Retry
         the connection with backoff; name the underlying cause if it persists. */
      let res;
      for (let net = 0; ; net++) {
        try {
          res = await fetch(URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${cfg.groqKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180000),
          });
          break;
        } catch (e) {
          if (e.name !== "TypeError" || net >= 4) throw describeNetError(e, "groq");
          await nap(Math.min(60000, 5000 * 2 ** net));
        }
      }
      const rem = Number(res.headers.get("x-ratelimit-remaining-tokens"));
      if (Number.isFinite(rem)) {
        budget = { remaining: rem, resetInMs: resetMs(res.headers.get("x-ratelimit-reset-tokens")) };
      }
      /* TWO DIFFERENT 429s WEAR THE SAME STATUS CODE, and treating them alike
         is why a run could burn three 90-second sleeps and still fail.

         "Request too large … (OTPM)" is a REFUSAL, decided from max_tokens
         before a token is generated. Waiting changes nothing — the same
         request is refused identically a minute later. The only answer is a
         smaller ask, so halve the budget and retry once. If that still will
         not fit, the model is wrong for this account and the error should say
         so rather than be buried under a timeout.

         Every other 429 is genuine throttling, where waiting IS the fix. */
      /* THE SAME REFUSAL ARRIVES UNDER TWO STATUS CODES. Groq answers the
         per-minute refusal with 429 for the output-token bucket and 413 for
         the TPM bucket — identical message, identical remedy, and this branch
         only ever tested for 429. So every 413 fell through to the generic
         throw: eight of ten chunks on #AskAbhijit 381 on 2026-09-18, and both
         that episode and Finance With Sharan then failed VALIDATION, for too
         few surviving learnings, with nothing in the log naming the cause.
         Two transcripts read, paid for and thrown away over a status code. */
      if (res.status === 429 || res.status === 413) {
        const body429 = await res.clone().text().catch(() => "");
        const refused = /request too large/i.test(body429);

        if (refused) {
          const room = Number((body429.match(/Limit\s+(\d+)/i) || [])[1]) || 0;
          const asked = Number(body.max_tokens) || cfg.groqMaxTokens;
          const next = room > 0 ? Math.min(Math.floor(room * 0.8), Math.floor(asked / 2))
                                : Math.floor(asked / 2);
          if (attempt < 1 && next >= 256) {
            return post({ ...body, max_tokens: next }, attempt + 1);
          }
          throw new Error(
            `groq refused the request size for ${body.model}: ${body429.slice(0, 200)}`);
        }

        /* A DAILY CAP IS NOT SOMETHING YOU WAIT OUT INSIDE A RUN.
         *
         * "on tokens per day (TPD): Limit 200000" resets at midnight UTC, not
         * in the 90 seconds this loop is willing to sleep. Treated as ordinary
         * throttling it cost THREE 90-second sleeps per call and roughly five
         * minutes per episode, turning a dead run into a 52-minute one that
         * still published nothing for those episodes — the log is wall-to-wall
         * 280-second gaps between identical refusals.
         *
         * There is nothing to do but stop, and stop loudly. Whatever has
         * already been processed is kept and published; the rest waits for
         * tomorrow's bucket, which is what MAX_DAILY_EPISODES is for. */
        if (/tokens per day|TPD/i.test(body429)) {
          throw new Error(
            `groq daily token budget exhausted for ${body.model} — stopping this run. ` +
            `Already-processed episodes are kept. ${body429.slice(0, 160)}`);
        }

        /* Only a real 429 is throttling worth sleeping on. A 413 that did not
           match the refusal above is something else, and belongs in the error
           below rather than behind 90 seconds of silence. */
        if (res.status === 429 && attempt < cfg.groqRetries) {
          const hinted = resetMs(res.headers.get("retry-after"))
            || resetMs(res.headers.get("x-ratelimit-reset-tokens"));
          await nap(Math.min(Math.max(hinted, 5000) + 1500, 90000));
          budget = { remaining: Infinity, resetInMs: 0 };
          last = Date.now();
          return post(body, attempt + 1);
        }
      }
      /* `tool_use_failed` IS A 400 AND IT IS NOT THE REQUEST'S FAULT.
       *
       * Groq rejects the call when the model's own tool arguments will not
       * parse. It fell straight through to the generic throw below with no
       * retry, which cost desk-10e8d11118e8 its whole episode on 2026-09-18 —
       * a transcript that had already been read and paid for.
       *
       * Generation is stochastic, so the same prompt usually parses on the
       * next attempt. Retry twice, then hand the raw text out to the caller,
       * which can often recover it. Its own counter, because the 429 path
       * halves max_tokens off `attempt` and the two must not consume each
       * other's budget. */
      if (res.status === 400) {
        const b400 = await res.clone().text().catch(() => "");
        if (/tool_use_failed/.test(b400)) {
          if (toolAttempt < 2) return post(body, attempt, toolAttempt + 1);
          const tool = ((body.tools || [])[0] || {}).function || {};
          const err = new Error(
            `groq could not produce valid ${tool.name || "tool"} arguments in 3 attempts`);
          try { err.failedGeneration = JSON.parse(b400)?.error?.failed_generation || ""; }
          catch { err.failedGeneration = ""; }
          throw err;
        }
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`groq ${res.status}: ${t.slice(0, 180)}`);
      }
      const d = await res.json();
      const u = d.usage || {};
      charge({ inTokens: u.prompt_tokens || 0, outTokens: u.completion_tokens || 0 });
      return d;
    };

    return {
      name: "groq",
      model: cfg.groqModel,

      async json({ system, user, schema, name, description, cheap = false, maxTokens = 8000 }) {
        let d;
        try {
          d = await post({
          /* The per-chunk read goes to the cheap model — not to save money,
             which is zero either way, but because the DAILY token bucket is
             per model and this pass is nearly all of the tokens. */
          model: cheap ? cfg.groqModelCheap : cfg.groqModel,
          /* CLAMPED. The free tier limits OUTPUT tokens per minute and enforces
             it on the request, so asking for 8,000 is refused outright — not
             throttled, refused, which no retry can fix. The caller's number is
             a ceiling for a paid provider; here it is whichever is smaller. */
          max_tokens: Math.min(maxTokens, cfg.groqMaxTokens),
          /* Reasoning models bill their hidden thinking to max_tokens; without
             this the budget is spent before the tool call is emitted. */
          reasoning_effort: cfg.groqReasoningEffort,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          tools: [{ type: "function", function: {
            name, description: description || name,
            parameters: { ...schema, additionalProperties: false },
          } }],
          tool_choice: "required",
          });
        } catch (e) {
          const salvaged = salvageToolArguments(e && e.failedGeneration);
          if (salvaged) return salvaged;
          throw e;
        }
        const msg = (d.choices || [{}])[0].message || {};
        const call = (msg.tool_calls || [])[0];
        if (!call) {
          throw new Error(`no ${name} tool call — model said: ${String(msg.content || "").slice(0, 200)}`);
        }
        try {
          return JSON.parse(call.function.arguments);
        } catch {
          /* Same two shapes reach us here when the API accepted them. */
          const salvaged = salvageToolArguments(call.function.arguments);
          if (salvaged) return salvaged;
          throw new Error(`${name} arguments were not valid JSON`);
        }
      },

      async text({ system, user, cheap = false, maxTokens = 4000 }) {
        const d = await post({
          model: cheap ? cfg.groqModelCheap : cfg.groqModel,
          max_tokens: Math.min(maxTokens, cfg.groqMaxTokens),
          reasoning_effort: cfg.groqReasoningEffort,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        });
        return String(((d.choices || [{}])[0].message || {}).content || "").trim();
      },
    };
  },

  async anthropic() {
    if (!cfg.anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const { default: Anthropic } = await import("@anthropic-ai/sdk").catch(() => {
      throw new Error("EXTRACTOR=ai needs the Anthropic SDK — run `npm install`");
    });
    /* maxRetries 0: http.mjs owns retry policy for the rest of the pipeline,
       but the SDK's own backoff is better informed than ours for this API
       (it reads the rate-limit headers), so it keeps its default of 2 and we
       do not wrap it in a second retry loop. Two nested backoffs turn a
       30-second rate limit into a four-minute one. */
    const client = new Anthropic({ apiKey: cfg.anthropicKey, timeout: 600000 });

    return {
      name: "anthropic",
      model: cfg.aiModel,

      /**
       * One schema-constrained call.
       * @param {object} o
       * @param {string} o.system   cached across calls — keep it byte-stable
       * @param {string} o.user
       * @param {object} o.schema   JSON Schema for the tool's input
       * @param {string} o.name     tool name, also the verb in the instruction
       * @param {boolean} o.cheap   route to AI_MODEL_CHEAP
       */
      async json({ system, user, schema, name, description, cheap = false, effort = "high", maxTokens = 16000 }) {
        const model = cheap ? cfg.aiModelCheap : cfg.aiModel;
        const res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          /* The system prompt is identical for every chunk of every episode, so
             it caches. On a 12-chunk episode that is 11 cache reads at a tenth
             of the price. The volatile part (the transcript) is in the user
             turn, AFTER the breakpoint — putting it first would invalidate the
             prefix on every single call and buy nothing. */
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: user }],
          thinking: { type: "adaptive" },
          output_config: { effort },
          tools: [{
            name, description, strict: true,
            input_schema: { ...schema, additionalProperties: false },
          }],
          tool_choice: { type: "auto" },
        });

        const u = res.usage || {};
        charge({ inTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0), outTokens: u.output_tokens || 0 });

        if (res.stop_reason === "refusal")
          throw new Error(`model declined: ${res.stop_details?.category || "unspecified"}`);

        const call = res.content.find((b) => b.type === "tool_use" && b.name === name);
        if (!call) {
          const said = res.content.find((b) => b.type === "text");
          throw new Error(`no ${name} tool call — model said: ${(said?.text || "").slice(0, 200)}`);
        }
        /* Documented pitfall: tool input arrives as an object but its string
           values may carry model-specific escaping. Never string-match on it. */
        return call.input;
      },

      /** Free-form prose, for the audio script and the summary, where a schema
       *  would only get in the way. */
      async text({ system, user, cheap = false, effort = "medium", maxTokens = 4000 }) {
        const res = await client.messages.create({
          model: cheap ? cfg.aiModelCheap : cfg.aiModel,
          max_tokens: maxTokens,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: user }],
          thinking: { type: "adaptive" },
          output_config: { effort },
        });
        const u = res.usage || {};
        charge({ inTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0), outTokens: u.output_tokens || 0 });
        if (res.stop_reason === "refusal") throw new Error("model declined the request");
        return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      },
    };
  },

  /**
   * Offline provider.
   *
   * It does NOT fake intelligence: it echoes real sentences taken from the
   * supplied transcript, at their real offsets. That is deliberate — the
   * validator downstream checks every citation against the transcript, and a
   * mock that returned lorem ipsum would make the validator pass vacuously and
   * the tests worthless. Everything the mock produces is genuinely grounded, so
   * a validation test that fails is a real bug in the validator.
   */
  mock() {
    return {
      name: "mock",
      model: "mock",
      async json({ user, name }) {
        const lines = [...user.matchAll(/\[(\d+:\d\d(?::\d\d)?)\](?:\s*\S+:)?\s*(.{40,})/g)]
          .map((m) => ({ ts: m[1], text: m[2].trim() }));

        if (name === "record_candidates") {
          return { candidates: lines.slice(0, 6).map((l, i) => ({
            headline: l.text.split(/[.,;]/)[0].slice(0, 70) || `Point ${i + 1}`,
            idea: l.text.slice(0, 240),
            why: "Mock rationale — the offline provider does not interpret.",
            action: i % 2 ? "Mock action." : "",
            evidence: l.text.slice(0, 180),
            timestamp: l.ts,
            kind: "said",
            confidence: 0.7,
          })) };
        }
        if (name === "record_ranked") {
          const c = JSON.parse(user.match(/<candidates>([\s\S]*?)<\/candidates>/)?.[1] || "[]");
          return { learnings: c.slice(0, 10).map((x, i) => ({ ...x, rank: i + 1 })) };
        }
        if (name === "record_meta") {
          return { guest: "", summary: "Mock summary of the conversation, produced offline for testing.", topics: ["mock"] };
        }
        return {};
      },
      async text() {
        return "Here are the ideas worth taking away from today's conversation. (Mock briefing.)";
      },
    };
  },
};
