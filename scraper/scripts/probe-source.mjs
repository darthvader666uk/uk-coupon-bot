/**
 * Diagnostic: does a voucher site expose codes in the DOM, and does clicking
 * its reveal button add any?
 *
 * Usage: node scripts/probe-source.mjs <url> [buttonText]
 */
import { launchBrowser } from "../lib/playwright-base.js";

const [url, buttonText = "Get Code"] = process.argv.slice(2);
if (!url) { console.error("usage: probe-source.mjs <url> [buttonText]"); process.exit(1); }

const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{2,24}$/;
const snapshot = () => [...document.querySelectorAll("*")]
  .filter(e => e.children.length === 0)
  .map(e => ({ t: e.textContent.trim(), c: (e.className || "").toString().slice(0, 40) }))
  .filter(x => /^[A-Z0-9][A-Z0-9._-]{2,24}$/.test(x.t));

const browser = await launchBrowser();
const ctx = await browser.newContext({ locale: "en-GB", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("popup", p => p.close().catch(() => {}));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
await page.waitForTimeout(4000);

const before = await page.evaluate(snapshot);
console.log(`title: ${(await page.title()).slice(0, 70)}`);
console.log(`code-like elements before click: ${before.length}`);
for (const b of before.slice(0, 8)) console.log(`   ${b.t.padEnd(20)} [${b.c}]`);

const btn = page.getByText(buttonText, { exact: false }).first();
let clicked = false;
try { await btn.click({ timeout: 6000, noWaitAfter: true }); clicked = true; }
catch (e) { console.log("click failed:", e.message.split("\n")[0]); }

if (clicked) {
  await page.waitForTimeout(5000);
  const after = await page.evaluate(snapshot);
  const seen = new Set(before.map(b => b.t));
  const added = after.filter(a => !seen.has(a.t));
  console.log(`\nafter clicking "${buttonText}": ${after.length} code-like (${added.length} new)`);
  for (const a of added.slice(0, 8)) console.log(`   NEW ${a.t.padEnd(18)} [${a.c}]`);
  if (!added.length) console.log("   -> clicking reveals nothing in-page");
}
await browser.close();
