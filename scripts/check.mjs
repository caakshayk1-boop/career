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
async function checkPage(path, label, extra) {
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
  ok(`${label}: content rendered`, (await page.locator("body").innerText()).length > 2000);

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
    };
  });

  ok("podcasts: the feed parses and declares a retention window", shape.retention > 0, shape.retention);
  ok("podcasts: a card for every published episode", shape.cards === shape.episodes, `${shape.cards} cards / ${shape.episodes} episodes`);
  ok("podcasts: no episode without a date", shape.undated === 0, shape.undated);
  ok("podcasts: no day heading without episodes", shape.orphanDays === 0, shape.orphanDays);

  if (shape.episodes === 0) {
    /* The seed state. It must SAY it is empty, not render a blank page. */
    ok("podcasts: an empty feed explains itself", shape.empty);
    return;
  }

  ok("podcasts: episodes are grouped into days", shape.days > 0, shape.days);
  ok("podcasts: the newest group is Today or Yesterday",
    /^(Today|Yesterday)$/.test(shape.dayHeadings[0] || ""), shape.dayHeadings[0]);

  /* THE DETAIL VIEW IS THE PRODUCT. Everything above it is navigation. */
  await page.locator(".ep").first().click();
  await page.waitForTimeout(400);

  const detail = await page.evaluate(() => ({
    visible: !document.getElementById("viewDetail").hidden,
    learnings: document.querySelectorAll(".ln").length,
    /* Every learning must carry its attribution label. This is the mechanism
     * that keeps the page honest — a card without one presents a model's
     * opinion in the guest's voice. */
    labelled: document.querySelectorAll(".ln .kind").length,
    why: document.querySelectorAll(".ln .lbl").length,
    lazyAudio: document.querySelectorAll('audio:not([preload="none"])').length,
    provenance: (document.querySelector(".note") || {}).textContent || "",
  }));

  ok("podcasts: a card opens its detail view", detail.visible);
  ok("podcasts: the detail view renders learnings", detail.learnings > 0, detail.learnings);
  ok("podcasts: every learning is labelled said/interpretation/recommendation",
    detail.labelled === detail.learnings, `${detail.labelled} of ${detail.learnings}`);
  ok("podcasts: every learning says why it matters", detail.why >= detail.learnings, `${detail.why} labels`);
  ok("podcasts: no audio preloads", detail.lazyAudio === 0, detail.lazyAudio);
  ok("podcasts: the page explains how it was made", /interpretation/.test(detail.provenance));

  /* The regression that shipped once: opening a second episode without a page
   * load left two live click handlers, so every quotation toggled twice and
   * appeared not to work. */
  const toggles = await page.evaluate(async () => {
    const one = document.querySelector(".quote-btn");
    if (!one) return "no quotations on this episode";
    one.click();
    const opened = !document.querySelector("#viewDetail blockquote").hidden;
    document.getElementById("back").click();
    await new Promise((r) => setTimeout(r, 200));
    const second = document.querySelectorAll(".ep")[1];
    if (!second) return opened ? "ok" : "first toggle failed";
    second.click();
    await new Promise((r) => setTimeout(r, 300));
    const b = document.querySelector(".quote-btn");
    if (!b) return opened ? "ok" : "first toggle failed";
    b.click();
    return opened && !document.querySelector("#viewDetail blockquote").hidden ? "ok" : "double-toggle regression";
  });
  ok("podcasts: quotations toggle once, on every episode", /^(ok|no quotations)/.test(toggles), toggles);

  await page.evaluate(() => { location.hash = ""; });
  await page.waitForTimeout(300);
});

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
