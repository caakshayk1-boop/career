#!/usr/bin/env node
/**
 * check.mjs — assert the page a browser actually renders.
 *
 * package.json has referenced this file since the repo was created and it did
 * not exist, so `npm run check` failed with MODULE_NOT_FOUND and nobody found
 * out, because nothing ran it.
 *
 * WHAT IT CHECKS AND WHY THOSE THINGS. This site is one 109KB single-file
 * document with every style and script inline. That shape has exactly one
 * catastrophic failure — a syntax error anywhere in the inline script kills
 * every interactive thing on the page at once — and a deploy check that only
 * fetched the HTML would pass while the page sat there inert. So this loads it
 * in a real browser and asserts behaviour, not bytes.
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
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

console.log(`\ncareer — checking ${SITE}\n`);
const res = await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 45000 });
ok("the page responds 200", res && res.status() === 200, res && res.status());
await page.waitForTimeout(3500);

/* A single inline script means one syntax error takes out everything. This is
 * the assertion that matters most on this site. */
ok("no script errors", errors.length === 0, errors.slice(0, 2).join(" | "));

ok("the page has a title", (await page.title()).length > 3, await page.title());
ok("content rendered", (await page.locator("body").innerText()).length > 2000);

/* The progress bar is 0% at the top of any page, so its existence proves
 * nothing. Scroll, then read it. */
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.5));
await page.waitForTimeout(400);
const pct = await page.evaluate(() => {
  const b = document.getElementById("prog");
  return b ? parseFloat(b.style.width) || 0 : -1;
});
ok("the scroll progress bar tracks the page", pct > 5, `${pct}%`);

/* Wide content on a phone is the failure this layout is most prone to, and it
 * is invisible on a desktop run. */
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(600);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("no sideways scroll at 320px", overflow <= 0, overflow);

await browser.close();
console.log(failed ? `\nFAILED — ${failed} check(s)\n` : "\nALL CHECKS PASSED\n");
process.exit(failed ? 1 : 0);
