/**
 * log.mjs — structured run logging.
 *
 * The failure this exists to prevent: a nightly job that fails quietly and
 * leaves yesterday's page up. Every stage writes a line, every failure records
 * a reason against an episode id, and the run ends with a report that is
 * written into the published artifact so the page itself can say "2 of 5
 * episodes failed" instead of just showing fewer cards.
 */
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6, " ");

export const run = {
  started: new Date().toISOString(),
  stages: [],
  errors: [],
  cost: { aiCalls: 0, inTokens: 0, outTokens: 0, ttsChars: 0 },
  counts: { discovered: 0, eligible: 0, processed: 0, skipped: 0, failed: 0, pruned: 0 },
};

const line = (level, stage, msg, extra) => {
  const e = extra && Object.keys(extra).length
    ? " " + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  console.log(`${ms()}ms ${level.padEnd(5)} ${stage.padEnd(12)} ${msg}${e}`);
};

export const log = {
  info: (stage, msg, extra) => line("info", stage, msg, extra),
  warn: (stage, msg, extra) => { line("WARN", stage, msg, extra); run.stages.push({ stage, level: "warn", msg }); },
  /** A failure is always attributed. `id` may be an episode id or a source id;
   *  an unattributed error is one nobody can act on. */
  fail: (stage, id, msg, extra) => {
    line("FAIL", stage, `${id}: ${msg}`, extra);
    run.errors.push({ stage, id, message: String(msg).slice(0, 400), at: new Date().toISOString() });
  },
  stage: (stage, msg, extra) => { line("STAGE", stage, msg, extra); run.stages.push({ stage, msg, at: new Date().toISOString() }); },
};

/** Token accounting. Estimates are fine — the number exists to catch a run that
 *  costs 40x what it should, not to reconcile an invoice. */
export function charge({ inTokens = 0, outTokens = 0, ttsChars = 0 } = {}) {
  run.cost.aiCalls += inTokens || outTokens ? 1 : 0;
  run.cost.inTokens += inTokens;
  run.cost.outTokens += outTokens;
  run.cost.ttsChars += ttsChars;
}

export function finishRun() {
  run.finished = new Date().toISOString();
  run.durationMs = Date.now() - t0;
  return run;
}
