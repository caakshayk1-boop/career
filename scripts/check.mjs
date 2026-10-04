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
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { cfg } from "../pipeline/config.mjs";

const SITE = (process.argv[2] || "https://career.askakshay.com").replace(/\/$/, "");
let failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  PASS  ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${detail !== undefined ? `  -> ${detail}` : ""}`);
};

/* The container ships a pinned Chromium that may not match the build this
 * Playwright expects (it looked for …_headless_shell-1234 against an installed
 * 1194). That is an environment mismatch, not a site failure, and downloading a
 * second browser to paper over it is both slow and unnecessary — the installed
 * one renders these three static pages identically. Try the default first so
 * CI, where the versions do agree, is unaffected. */
const browser = await chromium.launch().catch(async (err) => {
  const fallback = "/opt/pw-browsers/chromium";
  if (!existsSync(fallback)) throw err;
  console.log(`  note  using ${fallback} (bundled build not present)`);
  return chromium.launch({ executablePath: fallback });
});

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
  /* A SCRIPT ERROR AND AN UNREACHABLE HOST ARE DIFFERENT FAILURES.
     The campaign page fetches news.askakshay.com. Run against the live site
     that succeeds; run against a local copy from a sandbox with no egress it
     fails, Chromium logs "Failed to load resource", and a check that counts
     that as a script error reports a broken page every local run — which is
     how a suite stops being read. Cross-origin network failures are collected
     and printed; SAME-ORIGIN ones still fail, because a missing
     /guide/01.json is this repo's bug. */
  const netFails = [];
  const sameOrigin = (u) => { try { return new URL(u).origin === new URL(SITE).origin; } catch { return true; } };
  page.on("requestfailed", (r) => netFails.push({ url: r.url(), same: sameOrigin(r.url()) }));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource: net::ERR_/.test(t)) return;   // asserted below, by origin
    errors.push(t.slice(0, 200));
  });

  const url = SITE + path;
  console.log(`\ncareer — checking ${url}  (${label})\n`);
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  ok(`${label}: responds 200`, res && res.status() === 200, res && res.status());
  await page.waitForTimeout(3500);

  /* A single inline script means one syntax error takes out everything. This is
   * the assertion that matters most on this site. */
  ok(`${label}: no script errors`, errors.length === 0, errors.slice(0, 2).join(" | "));

  const own = netFails.filter((f) => f.same);
  ok(`${label}: every file the page asks this origin for exists`,
    own.length === 0, own.slice(0, 3).map((f) => f.url).join(" | "));
  const ext = netFails.filter((f) => !f.same);
  if (ext.length) {
    console.log(`  note  ${label}: ${ext.length} cross-origin request(s) unreachable from here`
      + ` — ${[...new Set(ext.map((f) => new URL(f.url).host))].join(", ")}`);
  }

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

  const shape = await page.evaluate(async (floor) => {
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
      /* THE FLOOR COMES FROM config.mjs, NOT A LITERAL. This said `< 5` while
       * the pipeline published at 4, so every deploy from 23 Sep failed this
       * check over episodes the pipeline had correctly admitted. */
      thin: (doc.episodes || []).filter((e) => (e.learnings || []).length < floor).length,
      builtHoursAgo: Math.round((Date.now() - Date.parse(doc.generatedAt || 0)) / 3600000),
      /* THE SAME ARITHMETIC RETENTION USES, not a re-derivation of it.
       * This measured wall-clock milliseconds and rounded, while buildPublic
       * counts whole calendar days in MYT between the episode's date and the
       * artifact's own `today`. The two agree until the clock passes midday and
       * then differ by one, which failed a deploy over an episode that
       * retention had correctly kept. A check that reimplements the rule it is
       * checking eventually disagrees with it; use the rule's own inputs. */
      oldestAgeDays: (doc.episodes || []).reduce((max, e) => Math.max(max,
        Math.round((Date.parse(doc.today + "T00:00:00Z") - Date.parse(e.date + "T00:00:00Z")) / 86400000)), 0),
    };
  }, cfg.minLearnings);

  ok("podcasts: the feed parses and declares a retention window", shape.retention > 0, shape.retention);
  ok("podcasts: a card for every published episode", shape.cards === shape.episodes, `${shape.cards} cards / ${shape.episodes} episodes`);
  ok("podcasts: every episode carries at least the floor of points",
    shape.thin === 0, `${shape.thin} episode(s) below the floor of ${cfg.minLearnings}`);
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
       * detail, in order. Stripping is allowed; rewriting is not.
       *
       * A SUBSEQUENCE, NOT A CONTIGUOUS TAIL. This compared the headline's last
       * 40 characters against the detail with includes(), which any mid-string
       * strip breaks — and stripping is the thing the rule explicitly permits.
       * "pretty late in Tokyo now uh Ethan Hunt" becomes "Pretty late in Tokyo
       * now Ethan Hunt": one filler word dropped and the first letter
       * capitalised, both allowed, both fatal to a contiguous match.
       *
       * 26 points failed it and ZERO were genuine rewrites — every one was a
       * strict subsequence of its own detail. The check was wrong, not the
       * generator, and it took the career deploy gate red with it.
       *
       * Word-by-word and in order is the exact formalisation of "strips but
       * never rewrites": a dropped word passes, an invented or altered one
       * cannot. Case-insensitive, because capitalising the first letter of a
       * sentence is presentation and not a change of words. */
      pillRewritten: (doc.episodes || []).filter((e) => e.extractor === "local")
        .flatMap((e) => e.learnings || [])
        .filter((l) => {
          if (!l.detail) return false;
          const w = (t) => String(t).toLowerCase().match(/[a-z0-9']+/g) || [];
          const head = w(String(l.headline).replace(/…$/, ""));
          if (head.length < 3) return false;
          const body = w(l.detail);
          let i = 0;
          for (const word of head) {
            while (i < body.length && body[i] !== word) i++;
            if (i >= body.length) return true;   // a word the detail never says
            i++;
          }
          return false;
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

await checkPage("/reads", "the weekly read", async (page) => {
  /* Before the first Monday run the feed is {reads: []}. An empty state that
     reads as a failure trains you to ignore the page, so assert it reads as
     "not yet" and names the shelf — and assert the live case separately. */
  const st = await page.evaluate(async () => {
    const d = await (await fetch("/reads.json", { cache: "no-store" })).json();
    const body = document.body.innerText;
    return { n: (d.reads || []).length, shelf: d.shelfSize,
             body, cards: document.querySelectorAll(".bk").length,
             ideas: document.querySelectorAll(".idea").length };
  });
  if (st.n === 0) {
    ok("the weekly read: an empty archive reads as 'not yet', not as an error",
      !/error|failed|could not/i.test(st.body), st.body.slice(0, 120));
    ok("the weekly read: the empty state names the shelf size",
      st.body.includes(String(st.shelf)), st.shelf);
  } else {
    ok("the weekly read: a card for every edition", st.cards === st.n, `${st.cards} / ${st.n}`);
    ok("the weekly read: the newest edition renders its ideas", st.ideas > 0, st.ideas);
  }
}, 400);

/* ── THE LEARNING BOOK ─────────────────────────────────────────────────────
   654 entries served as an index plus 34 section files. The checks that matter
   are not "does it render" — it is a list — but whether the scope label
   survives to the page. An entry whose advice is a Chinese regulation, shown
   without that label to a reader in Malaysia, is the one way this page can do
   harm, and it is invisible to every other assertion here. */
await checkPage("/guide", "learning book", async (page) => {
  const idx = await page.evaluate(async () => {
    const d = await (await fetch("/guide/index.json", { cache: "no-store" })).json();
    return { entries: d.totals.entries, sections: d.totals.sections,
             cn: d.totals.scope.cn, lev: d.totals.highLeverage,
             secs: document.querySelectorAll(".sec").length,
             body: document.body.innerText };
  });
  ok("learning book: the index declares all 34 sections", idx.sections === 34, idx.sections);
  ok("learning book: a card for every section", idx.secs === idx.sections, `${idx.secs} / ${idx.sections}`);
  ok("learning book: the entry count is on the page",
    idx.body.includes(String(idx.entries)), idx.entries);
  ok("learning book: the China-scope warning is on the page before any entry",
    /China/.test(idx.body) && idx.body.includes(String(idx.cn)), idx.cn);
  ok("learning book: the licence and the original are credited",
    /CC BY 4\.0/.test(idx.body) && /eternity4719/.test(idx.body));
  ok("learning book: it says the scope label is derived, not hand-checked",
    /pattern-match|will get some wrong/i.test(idx.body));

  /* Opening a section fetches its file. If that request or the render throws,
     the page sits on "Loading section" and looks like a slow network. */
  const sec = await page.evaluate(async () => {
    document.querySelector(".sec").click();
    await new Promise((r) => setTimeout(r, 2500));
    const ents = [...document.querySelectorAll(".ent")];
    const cn = ents.filter((e) => e.querySelector(".p.cn")).length;
    const grades = ents.filter((e) => e.querySelector(".p.gA,.p.gB,.p.gC")).length;
    const open = ents.filter((e) => e.open).length;
    return { n: ents.length, cn, grades, open,
             loading: /Loading section/.test(document.body.innerText),
             back: !!document.getElementById("bk") };
  });
  ok("learning book: a section opens its entries", sec.n > 0 && !sec.loading, `${sec.n} entries`);
  ok("learning book: every entry carries an evidence grade", sec.grades === sec.n, `${sec.grades} / ${sec.n}`);
  ok("learning book: entries start collapsed", sec.open === 0, sec.open);
  ok("learning book: a section can be left again", sec.back);
  ok("learning book: China-rule entries are marked as such in the list", sec.cn > 0, sec.cn);

  /* The scope note must survive INTO the opened entry, not only sit in the
     section list — a reader who expands straight from a search never saw it. */
  const body = await page.evaluate(async () => {
    const t = [...document.querySelectorAll(".ent")].find((e) => e.querySelector(".p.cn"));
    t.querySelector("summary").click();
    await new Promise((r) => setTimeout(r, 200));
    const d = t.querySelector(".bod");
    return { text: d ? d.innerText : "", dts: d ? d.querySelectorAll("dt").length : 0,
             links: d ? d.querySelectorAll("a[href^='http']").length : 0 };
  });
  ok("learning book: an opened China-rule entry explains that it does not apply here",
    /does NOT apply|Malaysia/i.test(body.text), body.text.slice(0, 120));
  ok("learning book: an opened entry shows cost, plain terms and the evidence",
    body.dts >= 4, body.dts);
  ok("learning book: cited sources are real links", body.links > 0, body.links);

  /* The filter chips are the only way to drop 149 inapplicable entries, so a
     chip that silently does nothing is worse than no chip. */
  const filt = await page.evaluate(async () => {
    document.getElementById("bk").click();
    await new Promise((r) => setTimeout(r, 200));
    const before = document.querySelectorAll(".sec").length;
    document.querySelector('[data-f="lev"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const after = document.querySelectorAll(".sec").length;
    const txt = document.body.innerText;
    document.querySelector('[data-f="lev"]').click();
    await new Promise((r) => setTimeout(r, 200));
    return { before, after, restored: document.querySelectorAll(".sec").length,
             counted: /\d+ of \d+ entries match/.test(txt) };
  });
  ok("learning book: a filter actually narrows the list",
    filt.after < filt.before && filt.after > 0, `${filt.before} → ${filt.after}`);
  ok("learning book: a filter says how many entries matched", filt.counted);
  ok("learning book: clearing a filter restores the list",
    filt.restored === filt.before, `${filt.restored} / ${filt.before}`);

  const srch = await page.evaluate(async () => {
    const q = document.getElementById("q");
    q.value = "seat belt"; q.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 450));
    const n = document.querySelectorAll(".sec").length;
    q.value = ""; q.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 450));
    return { n, restored: document.querySelectorAll(".sec").length };
  });
  ok("learning book: search narrows to the sections that contain the match",
    srch.n > 0 && srch.n < 34, srch.n);
  ok("learning book: clearing search restores every section", srch.restored === 34, srch.restored);
}, 1200);

await browser.close();
console.log(failed ? `\nFAILED — ${failed} check(s)\n` : "\nALL CHECKS PASSED\n");
process.exit(failed ? 1 : 0);
