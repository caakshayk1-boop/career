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
 * BOTH PAGES ARE CHECKED. `/home` was added on 2026-09-04 and is a second,
 * larger inline script. Checking only `/` would have left it in precisely the
 * blind spot this file exists to close: a green build over a page whose script
 * died on load and which still looks finished.
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
  const linked = await page.evaluate(() =>
    !!document.querySelector('.rail a[href="/home"]') &&
    !!document.querySelector('#life a[href="/home"]'));
  ok("campaign: links to /home from the rail and from §12 Life", linked);
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
