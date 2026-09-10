/**
 * notebooklm.mjs — the adapter, and an honest account of why it is empty.
 *
 * WHAT EXISTS TODAY. Google ships an Audio Overview API for NotebookLM
 * ENTERPRISE, reached through a Google Cloud project with Agentspace / Discovery
 * Engine provisioned. It is a real API and this adapter is shaped for it. The
 * consumer NotebookLM product at notebooklm.google.com has no equivalent public
 * API.
 *
 * WHY THERE IS NO CODE HERE. Writing an unexercised implementation against an
 * API this deployment has no credentials for produces something worse than
 * nothing: a plausible-looking integration that has never returned a byte, that
 * nobody can tell is broken, and that a future reader will assume works. If the
 * account gains Enterprise access, implement generate() against the live API
 * and delete this paragraph.
 *
 * WHY BROWSER AUTOMATION IS NOT HERE EITHER. Driving the consumer web UI with a
 * headless browser every morning means a logged-in Google session living in CI,
 * a login flow that breaks on any challenge, and DOM selectors that Google has
 * no obligation to keep. It would work until it didn't, and it would fail
 * silently at 6am. If it is ever wanted it belongs behind this same interface,
 * as a third provider — never inline in the pipeline.
 *
 * THE POINT OF THE SEAM. The pipeline calls nothing in this file today. The
 * direct transcript -> analysis -> TTS path is the backbone precisely so that
 * NotebookLM can be added, changed or removed without any of it mattering.
 */

export const notebookLM = {
  name: "notebooklm",

  /** Enterprise API access required. */
  available() { return false; },

  /**
   * Intended shape, for whoever implements it:
   *   generate({ sourceUrl, title, focus }) -> { audioUrl, durationSec, notebookId }
   */
  async generate() {
    throw new Error(
      "NotebookLM is not wired up. It requires NotebookLM Enterprise (Google Cloud " +
      "Agentspace); the consumer product has no public API. The direct AI pipeline " +
      "produces the briefing instead — see pipeline/lib/notebooklm.mjs.");
  },
};
