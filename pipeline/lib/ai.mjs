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
import Anthropic from "@anthropic-ai/sdk";
import { cfg } from "../config.mjs";
import { log, charge } from "./log.mjs";

/* Published list prices, $ per million tokens. Used only to print an estimate
   at the end of a run — an order-of-magnitude alarm, not an invoice. Stale
   prices here make the estimate wrong; they cannot make the pipeline wrong. */
const PRICES = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

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
  anthropic() {
    if (!cfg.anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");
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
