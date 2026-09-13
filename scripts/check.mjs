#!/usr/bin/env node
/**
 * check.mjs — assert the pages a browser actually renders.
 *
 * package.json has referenced this file since the repo was created and it did
 * not exist, so `npm run check` failed with MODULE_NOT_FOUND and nobody found
 * out, because nothing ran it.
 *
 * WHAT IT CHECKS AND WHY THOSE THINGS. This site is made of single-file
 * documents with every style and script inline. That shape has exactly one
 * catastrophic failure — a syntax error anywhere in the inline script kills
 * every interactive thing on the page at once — and a deploy check that only
 * fetched the HTML would pass while the page sat there inert. So this loads
 * them in a real browser and asserts behaviour, not bytes.
 *
 * ALL THREE PAGES ARE CHECKED. `/home` was added on 2026-09-04 and `/podcasts`
 * on 2026-09-10; each is a second and third inline script. Checking only `/`
 * would leave them in precisely the blind spot this file exists to close: a
 * green build over a page whose script died on load and which still looks
 * finished.
 *
 * `/podcasts` renders entirely from /podcasts.json. When the morning job has
 * not run, that file is the committed seed with no episodes — so the checks
 * below assert the EMPTY state is correct too, rather than skipping. A page
 * that only works once it has content is a page that is broken on day one.
 *
 *   node scripts/check.mjs https://career.askakshay.com
 */
import { chromium } from "playwright";

const SITE = (process.argv[2] || "https://career.askakshay.com").replace(/\/$/, "");
let failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  PASS  ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${detail !== undefined ? `  -> ${detail}` : ""}`);
};

const browser = await chromium.launch();

/* One fresh page per document: `errors` must not carry over between them, or a
 * failure on the first page is reported again against the second. */
/**
 * @param {number} [minText] characters of rendered text below which the page is
 *   considered blank. Per-page, because "blank" is not one number: the campaign
 *   and the home book are large documents, while /podcasts in its empty state is
 *   deliberately about 800 characters — a good empty state is short, and a
 *   generic 2000-character floor fails it for being correct.
 */
async function checkPage(path, label, extra, minText = 2000) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

  const url = SITE + path;
  console.log(`\ncareer — checking ${url}  (${label})\n`);
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  ok(`${label}: responds 200`, res && res.status() === 200, res && res.status());
  await page.waitForTimeout(3500);

  /* A single inline script means one syntax error takes out everything. This is
   * the assertion that matters most on this site. */
  ok(`${label}: no script errors`, errors.length === 0, errors.slice(0, 2).join(" | "));

  ok(`${label}: has a title`, (await page.title()).length > 3, await page.title());
  const textLen = (await page.locator("body").innerText()).length;
  ok(`${label}: content rendered`, textLen > minText, `${textLen} chars, floor ${minText}`);

  /* The progress bar is 0% at the top of any page, so its existence proves
   * nothing. Scroll, then read it. */
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.5));
  await page.waitForTimeout(400);
  const pct = await page.evaluate(() => {
    const b = document.getElementById("scrollprog");
    return b ? parseFloat(b.style.width) || 0 : -1;
  });
  ok(`${label}: scroll progress bar tracks the page`, pct > 5, `${pct}%`);

  if (extra) await extra(page);

  /* Wide content on a phone is the failure this layout is most prone to, and it
   * is invisible on a desktop run. */
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`${label}: no sideways scroll at 320px`, overflow <= 0, overflow);

  await page.close();
}

await checkPage("/", "campaign", async (page) => {
  /* The rail link into the second page. If this silently disappears, /home is
   * still live but unreachable, which is the same as gone. */
  const linked = await page.evaluate(() => ({
    home: !!document.querySelector('.rail a[href="/home"]') && !!document.querySelector('#life a[href="/home"]'),
    pods: !!document.querySelector('.rail a[href="/podcasts"]') && !!document.querySelector('#life a[href="/podcasts"]'),
  }));
  ok("campaign: links to /home from the rail and from §12 Life", linked.home);
  ok("campaign: links to /podcasts from the rail and from §12 Life", linked.pods);

  /* §12 renders podcasts from /podcasts.json when the morning job has produced
   * anything, and falls back to the desk feed's bare titles when it has not.
   * Either is correct; a pane stuck on "Loading…" is not. */
  await page.waitForTimeout(1500);
  const life = await page.evaluate(() => (document.getElementById("lifeLearn") || {}).textContent || "");
  ok("campaign: §12 Life resolves rather than hanging on Loading", !/Loading…/.test(life), life.slice(0, 80));
});

/* 400, not 2000: with no episodes published this page is one paragraph saying
 * so, and that is the correct output rather than a failure. The assertions that
 * actually matter for this page — that the feed parses, that the empty state
 * explains itself, that a card exists per episode — are below and are not
 * satisfied by a wall of text. */
await checkPage("/podcasts", "podcasts", async (page) => {
  /* The feed is fetched, so the page is empty for a moment on any run. Wait for
   * the render rather than racing it — the 3.5s in checkPage is for scripts, not
   * for the network. */
  await page.waitForFunction(() => {
    const f = document.getElementById("feed");
    return f && !/Loading/.test(f.textContent);
  }, { timeout: 15000 }).catch(() => {});

  const shape = await page.evaluate(async () => {
    const doc = await (await fetch("/podcasts.json", { cache: "no-store" })).json();
    return {
      episodes: (doc.episodes || []).length,
      cards: document.querySelectorAll(".ep").length,
      days: document.querySelectorAll(".day").length,
      dayHeadings: [...document.querySelectorAll(".day-h b")].map((b) => b.textContent),
      empty: !!document.querySelector("#feed .empty"),
      retention: doc.retentionDays,
      /* Every day heading must have episodes under it, and every episode a day.
       * A mismatch renders an empty heading, which reads as a bug in the feed. */
      orphanDays: (doc.days || []).filter((d) => !(d.episodeIds || []).length).length,
      undated: (doc.episodes || []).filter((e) => !e.date).length,
      thin: (doc.episodes || []).filter((e) => (e.learnings || []).length < 5).length,
      builtHoursAgo: Math.round((Date.now() - Date.parse(doc.generatedAt || 0)) / 3600000),
      oldestAgeDays: (doc.episodes || []).reduce((max, e) => Math.max(max,
        Math.round((Date.now() - Date.parse(e.date + "T00:00:00Z")) / 86400000)), 0),
    };
  });

  ok("podcasts: the feed parses and declares a retention window", shape.retention > 0, shape.retention);
  ok("podcasts: a card for every published episode", shape.cards === shape.episodes, `${shape.cards} cards / ${shape.episodes} episodes`);
  ok("podcasts: every episode carries at least the floor of points",
    shape.thin === 0, `${shape.thin} episode(s) below the floor`);
  ok("podcasts: no episode without a date", shape.undated === 0, shape.undated);
  ok("podcasts: no day heading without episodes", shape.orphanDays === 0, shape.orphanDays);

  if (shape.episodes === 0) {
    /* The seed state. It must SAY it is empty, not render a blank page. */
    ok("podcasts: an empty feed explains itself", shape.empty);
    return;
  }

  ok("podcasts: episodes are grouped into days", shape.days > 0, shape.days);
  /* NOT "the newest group is Today". Shows do not publish daily — Diary of a
   * CEO went two days between episodes and this failed a deploy for the feed
   * behaving normally. What matters is that the label is well-formed and the
   * content is inside the retention window, both of which are real invariants. */
  ok("podcasts: the newest group carries a real day label",
    /^(Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/
      .test(shape.dayHeadings[0] || ""), shape.dayHeadings[0]);
  ok("podcasts: nothing on the page is older than the retention window",
    shape.oldestAgeDays < shape.retention, `${shape.oldestAgeDays}d, window ${shape.retention}d`);
  /* The assertion that actually catches a dead pipeline: the artifact is being
   * rebuilt. 72h rather than 24h because a quiet weekend is not a failure and a
   * check that cries wolf gets ignored. */
  ok("podcasts: the morning job is still running",
    shape.builtHoursAgo < 72, `last built ${shape.builtHoursAgo}h ago — check the podcasts workflow`);

  /* THE DETAIL VIEW IS THE PRODUCT. Everything above it is navigation. */
  await page.locator(".ep").first().click();
  await page.waitForTimeout(400);

  const detail = await page.evaluate(async () => {
    const doc = await (await fetch("/podcasts.json", { cache: "no-store" })).json();
    const ep = doc.episodes.find((e) => !document.getElementById("viewDetail").hidden) || doc.episodes[0];
    return {
      visible: !document.getElementById("viewDetail").hidden,
      points: document.querySelectorAll(".ln").length,
      expandable: document.querySelectorAll(".ln [data-open]").length,
      openByDefault: [...document.querySelectorAll(".ln-d")].filter((d) => !d.hidden).length,
      lazyAudio: document.querySelectorAll('audio:not([preload="none"])').length,
      provenance: (document.querySelector(".note") || {}).textContent || "",
      extractor: ep.extractor || "",
      /* THE GUARANTEE, asserted against the artifact rather than the markup.
       *
       * The invariant is `detail` inside `passage`: the passage is assembled
       * verbatim from transcript segments, so a detail found inside it is
       * verbatim too. That is the whole claim this page makes.
       *
       * It is deliberately NOT asserted against `headline`. The headline is the
       * scannable pill, which strips leading discourse markers ("So, you know,
       * …") and is therefore correctly not a substring of the source. An
       * earlier version of this check compared the two and failed 8 of 20
       * points for behaving exactly as designed. */
      notVerbatim: (doc.episodes || []).filter((e) => e.extractor === "local")
        .flatMap((e) => e.learnings || [])
        .filter((l) => !l.detail || !l.passage || !l.passage.includes(l.detail)).length,
      /* And the pill must still be honest: whatever it kept must appear in the
       * detail, in order. Stripping is allowed; rewriting is not. */
      pillRewritten: (doc.episodes || []).filter((e) => e.extractor === "local")
        .flatMap((e) => e.learnings || [])
        .filter((l) => {
          const tail = String(l.headline).replace(/…$/, "").trim().slice(-40);
          return tail.length > 12 && l.detail && !l.detail.includes(tail);
        }).length,
      untimed: (doc.episodes || []).flatMap((e) => e.timestamped ? (e.learnings || []) : [])
        .filter((l) => l.t == null).length,
    };
  });

  ok("podcasts: a card opens its detail view", detail.visible);
  ok("podcasts: the detail view renders points", detail.points > 0, detail.points);
  ok("podcasts: every point can be expanded", detail.expandable === detail.points,
    `${detail.expandable} of ${detail.points}`);
  /* The closed state IS the product — twenty points that read in three minutes.
   * A card that starts open defeats the entire page. */
  ok("podcasts: points start collapsed", detail.openByDefault === 0, detail.openByDefault);
  ok("podcasts: no audio preloads", detail.lazyAudio === 0, detail.lazyAudio);
  ok("podcasts: the page explains how the points were chosen",
    /verbatim|interpretation/.test(detail.provenance));
  ok("podcasts: every point is verbatim from its source", detail.notVerbatim === 0, detail.notVerbatim);
  ok("podcasts: the scannable line strips but never rewrites", detail.pillRewritten === 0, detail.pillRewritten);
  ok("podcasts: a timestamped episode timestamps every point", detail.untimed === 0, detail.untimed);

  /* The regression that shipped once: opening a second episode without a page
   * load left two live click handlers, so every quotation toggled twice and
   * appeared not to work. */
  const toggles = await page.evaluate(async () => {
    const open = () => {
      const h = document.querySelector(".ln [data-open]");
      if (!h) return null;
      h.click();
      return !document.getElementById("d" + h.dataset.open).hidden;
    };
    const first = open();
    if (first === null) return "no expandable points";
    document.getElementById("back").click();
    await new Promise((r) => setTimeout(r, 200));
    const second = document.querySelectorAll(".ep")[1];
    if (!second) return first ? "ok" : "first expand failed";
    second.click();
    await new Promise((r) => setTimeout(r, 300));
    const again = open();
    return first && again ? "ok" : "double-toggle regression";
  });
  ok("podcasts: points expand once, on every episode", /^(ok|no expandable)/.test(toggles), toggles);

  /* Twenty taps to read everything is not a feature. */
  const all = await page.evaluate(async () => {
    const b = document.getElementById("expandAll");
    if (!b) return "no control";
    b.click();
    await new Promise((r) => setTimeout(r, 150));
    const opened = [...document.querySelectorAll(".ln-d")].every((d) => !d.hidden);
    b.click();
    await new Promise((r) => setTimeout(r, 150));
    const closed = [...document.querySelectorAll(".ln-d")].every((d) => d.hidden);
    return opened && closed ? "ok" : `opened=${opened} closed=${closed}`;
  });
  ok("podcasts: expand-all opens and closes every point", /^(ok|no control)/.test(all), all);

  await page.evaluate(() => { location.hash = ""; });
  await page.waitForTimeout(300);
}, 400);

await checkPage("/home", "home book", async (page) => {
  /* Every date on this page is derived at run time from one BORN constant. If
   * that block throws, the tiles keep their "—" placeholder and the page still
   * looks finished — so assert the derived values, not the elements. */
  const stats = await page.evaluate(() => {
    const t = (id) => (document.getElementById(id) || {}).textContent || "";
    return { age: t("stAge"), days: t("stDays"), bday: t("stBday"),
             sections: document.querySelectorAll("section.sec").length };
  });
  ok("home book: age is derived, not a placeholder", /^\d+m \d+d$/.test(stats.age.trim()), stats.age);
  ok("home book: days-old is a number", Number(stats.days) > 0, stats.days);
  ok("home book: days-to-birthday is a number", Number(stats.bday) >= 0, stats.bday);
  ok("home book: all 14 sections present", stats.sections === 14, stats.sections);

  /* Wide tables must scroll inside .tw, not push the document sideways. The
   * 320px assertion below catches the document; this catches the cause. */
  const escaped = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll("*")].filter((el) =>
      el.getBoundingClientRect().right > w + 1 &&
      !el.closest(".rail") && !el.closest(".tw")).length;
  });
  ok("home book: nothing escapes its scroll container", escaped === 0, escaped);
});

await browser.close();
console.log(failed ? `\nFAILED — ${failed} check(s)\n` : "\nALL CHECKS PASSED\n");
process.exit(failed ? 1 : 0);
