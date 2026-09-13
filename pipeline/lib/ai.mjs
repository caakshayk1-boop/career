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

const PROVIDERS = {
  /**
   * Groq — the free one.
   *
   * OpenAI-compatible, so structured output is function calling rather than
   * Anthropic's tools block, and there is no prompt caching: the system prompt
   * is re-sent per chunk. That costs nothing here because the tier is free, but
   * it is why this provider does not try to be clever about prompt ordering.
   *
   * MODEL CHOICE WAS MEASURED, NOT PICKED. On this account the generation-
   * capable models are gpt-oss-120b/20b and qwen3.6/3.8-27b. Asked for one
   * schema-constrained tool call:
   *
   *     qwen/qwen3.8-27b      returned the call, 2 learnings, fields populated
   *     openai/gpt-oss-120b   returned nothing parseable
   *
   * which is the failure already recorded against gpt-oss elsewhere in this
   * estate: it is a REASONING model whose hidden tokens consume max_tokens and
   * leave an empty 200 behind. It is not the default here for that reason, and
   * GROQ_MODEL overrides in case this account's roster changes again — Groq has
   * retired models twice without notice.
   *
   * PACED FOR THE FREE TIER, which is token-per-minute limited. Calls are
   * serialised and spaced; a 429 waits out the window the header names and
   * retries once. Without this an episode's five passes race each other into
   * the limit and the run dies half-written.
   */
  async groq() {
    if (!cfg.groqKey) throw new Error("GROQ_API_KEY is not set");
    const URL = "https://api.groq.com/openai/v1/chat/completions";
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

    const post = async (body, attempt = 0) => {
      await gate();
      /* If the window is nearly spent, wait for it to refill before asking.
         Cheaper than a refusal, and it keeps the run deterministic. */
      if (budget.remaining < cfg.groqMaxTokens * 1.5 && budget.resetInMs > 0) {
        await nap(Math.min(budget.resetInMs + 1500, 90000));
        budget = { remaining: Infinity, resetInMs: 0 };
        last = Date.now();
      }
      const res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const rem = Number(res.headers.get("x-ratelimit-remaining-tokens"));
      if (Number.isFinite(rem)) {
        budget = { remaining: rem, resetInMs: resetMs(res.headers.get("x-ratelimit-reset-tokens")) };
      }
      if (res.status === 429 && attempt < cfg.groqRetries) {
        const hinted = resetMs(res.headers.get("retry-after"))
          || resetMs(res.headers.get("x-ratelimit-reset-tokens"));
        await nap(Math.min(Math.max(hinted, 5000) + 1500, 90000));
        budget = { remaining: Infinity, resetInMs: 0 };
        last = Date.now();
        return post(body, attempt + 1);
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

      async json({ system, user, schema, name, description, maxTokens = 8000 }) {
        const d = await post({
          model: cfg.groqModel,
          /* CLAMPED. The free tier limits OUTPUT tokens per minute and enforces
             it on the request, so asking for 8,000 is refused outright — not
             throttled, refused, which no retry can fix. The caller's number is
             a ceiling for a paid provider; here it is whichever is smaller. */
          max_tokens: Math.min(maxTokens, cfg.groqMaxTokens),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          tools: [{ type: "function", function: {
            name, description: description || name,
            parameters: { ...schema, additionalProperties: false },
          } }],
          tool_choice: "required",
        });
        const msg = (d.choices || [{}])[0].message || {};
        const call = (msg.tool_calls || [])[0];
        if (!call) {
          throw new Error(`no ${name} tool call — model said: ${String(msg.content || "").slice(0, 200)}`);
        }
        try {
          return JSON.parse(call.function.arguments);
        } catch {
          throw new Error(`${name} arguments were not valid JSON`);
        }
      },

      async text({ system, user, maxTokens = 4000 }) {
        const d = await post({
          model: cfg.groqModel,
          max_tokens: Math.min(maxTokens, cfg.groqMaxTokens),
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
