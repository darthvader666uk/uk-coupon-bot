/**
 * Drives the Tampermonkey script in a real browser against synthetic pages.
 *
 * Checks the three things the v1 script got wrong:
 *   - store matching (no substring false positives)
 *   - promo input detection (postcode/gift-card fields must not win)
 *   - fill-without-click (the Apply button must never be pressed)
 *
 * Run: node scripts/test-userscript.mjs
 */
import { chromium } from "playwright";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(
  join(__dirname, "..", "..", "tampermonkey", "UK Coupon Checker.user.js"),
  "utf8"
).replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");

const STORES = {
  "currys.co.uk": {
    domain: "currys.co.uk", name: "Currys",
    codes: [
      { code: "SAVE20", description: "20% off small appliances", type: "percentage", value: 20, minSpend: 50, expiry: "2027-01-31", lastSeen: "2026-09-01T00:00:00Z", sources: ["savoo", "myvouchercodes"] },
      { code: "TENOFF", description: "", type: "fixed", value: 10, minSpend: null, lastSeen: "2026-06-01T00:00:00Z", sources: ["savoo"] },
      { code: "GONEBY", description: "Past its end date", type: "fixed", value: 5, expiry: "2020-01-01", lastSeen: "2026-09-02T00:00:00Z", sources: ["savoo"] },
    ],
  },
  "asos.co.uk": {
    domain: "asos.co.uk", name: "ASOS",
    codes: [{ code: "ASOS15", description: "15% off", type: "percentage", value: 15, lastSeen: "2026-09-01T00:00:00Z", sources: ["savoo"] }],
  },
  "very.co.uk": {
    domain: "very.co.uk", name: "Very",
    codes: [{ code: "VERY5", description: "£5 off", type: "fixed", value: 5, lastSeen: "2026-09-01T00:00:00Z", sources: ["savoo"] }],
  },
};

const INDEX = {
  meta: { version: 2, totalStores: 3, totalCodes: 4 },
  // Aliases ship in the index now, not in a copy inside the userscript.
  aliases: { "asos.com": "asos.co.uk", "amazon.com": "amazon.co.uk" },
  stores: Object.fromEntries(Object.entries(STORES).map(([d, s]) => [d, s.codes.length])),
};

const GM_STUBS = `
  window.__ukcpStore = {};
  window.__ukcpStyles = [];
  window.__ukcpClicks = [];
  window.GM_getValue = (k, d) => (k in window.__ukcpStore ? window.__ukcpStore[k] : d);
  window.GM_setValue = (k, v) => { window.__ukcpStore[k] = v; };
  window.GM_addStyle = (css) => {
    window.__ukcpStyles.push(css);
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  };
  window.GM_openInTab = (url) => { window.__ukcpOpened = url; };
  window.__ukcpRequests = [];
  window.__ukcpIndex = ${JSON.stringify(INDEX)};
  window.__ukcpStores = ${JSON.stringify(STORES)};
  window.GM_xmlhttpRequest = (opts) => {
    window.__ukcpRequests.push(opts.url);
    setTimeout(() => {
      if (opts.url.endsWith("/index.json")) {
        opts.onload({ status: 200, responseText: JSON.stringify(window.__ukcpIndex) });
        return;
      }
      // Character classes, not backslash escapes: this lives in a template
      // literal, where \/ collapses to / and would comment out the line.
      const m = /[/]stores[/]([^/]+)[.]json$/.exec(opts.url);
      const store = m && window.__ukcpStores[decodeURIComponent(m[1])];
      if (store) opts.onload({ status: 200, responseText: JSON.stringify(store) });
      else opts.onload({ status: 404, responseText: "not found" });
    }, 0);
  };
`;

const CHECKOUT_HTML = `<!doctype html><html><body>
  <h1>Checkout</h1>
  <form id="delivery">
    <label for="pc">Postcode</label><input id="pc" name="postcode" type="text" style="width:200px;height:30px">
    <label for="em">Email</label><input id="em" name="email" type="text" style="width:200px;height:30px">
  </form>
  <form id="promoform">
    <label for="promo">Discount code</label>
    <input id="promo" name="promoCode" type="text" placeholder="Enter promo code" style="width:200px;height:30px">
    <button type="button" id="applybtn" onclick="window.__ukcpClicks.push('apply')">Apply</button>
  </form>
  <input type="hidden" name="couponHidden" value="">
  <button type="button" id="placeorder" onclick="window.__ukcpClicks.push('placeorder')">Place order</button>
</body></html>`;

const BARE_HTML = `<!doctype html><html><body><h1>No promo box here</h1></body></html>`;

let passed = 0;
let failed = 0;
const pageErrors = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function makePage(browser, host, html) {
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.includes("google.com/s2/favicons")) return route.fulfill({ status: 200, body: "" });
    return route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  const page = await context.newPage();
  // Surface uncaught script errors. A stale variable reference otherwise
  // fails silently and only shows up as "the badge didn't appear".
  page.on("pageerror", (e) => pageErrors.push(`${host}: ${e.message}`));
  await page.goto(`https://${host}/checkout`);
  await page.addScriptTag({ content: GM_STUBS });
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForTimeout(300);
  return { page, context };
}

/**
 * Playwright expects a browser build matching its own version. When only an
 * older cached build is present (common after a playwright bump without a
 * re-download), fall back to whatever chromium is actually on disk.
 */
async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH
      || join(process.env.LOCALAPPDATA || process.env.HOME || "", "ms-playwright");
    const candidates = readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse()
      .flatMap((d) => [
        join(root, d, "chrome-win64", "chrome.exe"),
        join(root, d, "chrome-win", "chrome.exe"),
        join(root, d, "chrome-linux", "chrome"),
      ]);
    const executablePath = candidates.find((p) => existsSync(p));
    if (!executablePath) throw err;
    console.log(`(using cached chromium: ${executablePath})`);
    return chromium.launch({ executablePath });
  }
}

const browser = await launchChromium();

console.log("\nStore matching");
{
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML);
  check("exact domain matches", await page.locator("#ukcp-badge").count() === 1);
  check("badge shows code count", (await page.locator("#ukcp-badge").textContent()) === "3");
  await context.close();
}
{
  const { page, context } = await makePage(browser, "checkout.currys.co.uk", CHECKOUT_HTML);
  check("subdomain resolves to parent store", await page.locator("#ukcp-badge").count() === 1);
  await context.close();
}
{
  const { page, context } = await makePage(browser, "www.asos.com", CHECKOUT_HTML);
  check("alias asos.com -> asos.co.uk", await page.locator("#ukcp-badge").count() === 1);
  await context.close();
}
{
  // v1 regression: store key "very.co.uk" substring-matched delivery.com.
  const { page, context } = await makePage(browser, "www.delivery.com", CHECKOUT_HTML);
  check("no substring false positive on delivery.com", await page.locator("#ukcp-badge").count() === 0);
  check("no styles injected on unmatched site", (await page.evaluate(() => window.__ukcpStyles.length)) === 0);
  await context.close();
}

console.log("\nSharded fetching");
{
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML);
  const reqs = await page.evaluate(() => window.__ukcpRequests);
  check("fetches the index", reqs.some((u) => u.endsWith("/index.json")));
  check("fetches only the matched store", reqs.filter((u) => u.includes("/stores/")).length === 1,
    `requested: ${JSON.stringify(reqs)}`);
  check("never fetches the aggregate file", !reqs.some((u) => u.endsWith("uk-coupons.json")));
  await context.close();
}
{
  const { page, context } = await makePage(browser, "www.delivery.com", CHECKOUT_HTML);
  const reqs = await page.evaluate(() => window.__ukcpRequests);
  check("unmatched site fetches no store file", !reqs.some((u) => u.includes("/stores/")),
    `requested: ${JSON.stringify(reqs)}`);
  await context.close();
}
{
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML);
  await page.click("#ukcp-badge");
  await page.waitForTimeout(100);
  const stale = await page.locator(".ukcp-tag.ukcp-stale").count();
  check("code unseen for weeks is flagged stale", stale === 1, `found ${stale} stale tags`);
  const expiry = await page.locator(".ukcp-tag", { hasText: "expires" }).count();
  check("future expiry date is shown", expiry === 1, `found ${expiry} expiry tags`);
  const expired = await page.locator(".ukcp-tag.ukcp-expired").count();
  check("expired code is flagged, not hidden", expired === 1, `found ${expired} expired tags`);
  const codes = await page.locator(".ukcp-code").allTextContents();
  check("expired code is ranked last", codes[codes.length - 1] === "GONEBY", `order: ${codes.join(",")}`);
  await context.close();
}

console.log("\nPromo input detection");
{
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML);
  await page.click("#ukcp-badge");
  await page.waitForTimeout(100);
  await page.locator(".ukcp-item").first().locator(".ukcp-item-main").click();
  await page.waitForTimeout(200);

  check("promo input filled", (await page.inputValue("#promo")) === "SAVE20", `got "${await page.inputValue("#promo")}"`);
  check("postcode left alone", (await page.inputValue("#pc")) === "");
  check("email left alone", (await page.inputValue("#em")) === "");
  check("no button clicked", (await page.evaluate(() => window.__ukcpClicks.length)) === 0,
    `clicked: ${JSON.stringify(await page.evaluate(() => window.__ukcpClicks))}`);
  check("status reports the fill", (await page.locator(".ukcp-status").textContent()).includes("copied and filled"));
  await context.close();
}
{
  const { page, context } = await makePage(browser, "www.currys.co.uk", BARE_HTML);
  await page.click("#ukcp-badge");
  await page.waitForTimeout(100);
  const status = await page.locator(".ukcp-status").textContent();
  check("no promo box is reported honestly", status.includes("No promo box detected"), `got "${status}"`);
  await context.close();
}

console.log("\nVoting and hiding");
{
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML);
  await page.click("#ukcp-badge");
  await page.locator('.ukcp-item .ukcp-vote[data-vote="down"]').first().click();
  await page.waitForTimeout(100);
  check("thumbs-down decrements badge", (await page.locator("#ukcp-badge").textContent()) === "2");
  check("report link offered", await page.locator(".ukcp-report-slot .ukcp-link").count() === 1);

  await page.click(".ukcp-hide-site");
  await page.waitForTimeout(100);
  check("hide-on-site removes UI", await page.locator("#ukcp-badge").count() === 0);

  // Re-run the script in the same context: the preference must persist.
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForTimeout(300);
  check("hide-on-site persists across reloads", await page.locator("#ukcp-badge").count() === 0);
  await context.close();
}

await browser.close();

console.log("\nPage errors");
check("no uncaught script errors", pageErrors.length === 0, pageErrors.join("; "));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
