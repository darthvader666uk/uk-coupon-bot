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
  // Shopify basket-test fixture: GOOD15 and GOOD5 apply, the rest don't.
  "shopmock.co.uk": {
    domain: "shopmock.co.uk", name: "Shop Mock",
    codes: ["DEAD1", "GOOD15", "GOOD5", "DEAD2", "EXTRA"].map((c) => ({ code: c, description: "", type: "unknown", lastSeen: "2026-09-15T00:00:00Z", sources: ["caramel"] })),
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
  window.__ukcpMenu = [];
  window.GM_registerMenuCommand = (name, fn) => { window.__ukcpMenu.push({ name, fn }); };
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

async function makePage(browser, host, html, seed) {
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
  // Pre-seed GM storage so a test can present the script with a cache that is
  // already stale, which is the state a real browser is in after store keys
  // change in the repo.
  if (seed) await page.addScriptTag({ content: seed });
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForTimeout(300);
  return { page, context };
}

/**
 * A store whose /cart.js and /cart/update.js behave like Shopify's. `state`
 * is mutated by the apply rule so the test can inspect what the basket was
 * left holding. `onUpdate(code, state)` returns 429 to simulate the limiter.
 */
async function makeShopifyPage(browser, host, state, onUpdate) {
  const context = await browser.newContext();
  const calls = [];
  const cart = () => ({
    token: "abc", items: state.items, item_count: state.items.length, currency: "GBP",
    total_price: state.total, items_subtotal_price: state.subtotal, total_discount: state.subtotal - state.total,
    cart_level_discount_applications: state.auto || [], discount_codes: state.codes || [],
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/cart.js") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cart()) });
    if (url.pathname === "/cart/update.js") {
      const body = JSON.parse(route.request().postData() || "{}");
      calls.push(body.discount);
      if (onUpdate(body.discount, state) === 429) return route.fulfill({ status: 429, contentType: "text/html", body: "<html>" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cart()) });
    }
    if (url.hostname.includes("google.com")) return route.fulfill({ status: 200, body: "" });
    return route.fulfill({ status: 200, contentType: "text/html", body: BARE_HTML });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${host}: ${e.message}`));
  await page.goto(`https://${host}/cart`);
  await page.addScriptTag({ content: GM_STUBS });
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForSelector("#ukcp-badge");
  await page.$eval("#ukcp-badge", (b) => b.click());
  return { page, context, calls };
}

/** Mock Shopify apply rule: GOOD15 = 15% off, GOOD5 = £5 off, "" clears. */
function shopifyApply(code, st) {
  if (code === "") { st.codes = []; st.total = st.subtotal; return; }
  const ok = code === "GOOD15" || code === "GOOD5";
  st.codes = [{ code, applicable: ok }];
  st.total = code === "GOOD15" ? Math.round(st.subtotal * 0.85) : code === "GOOD5" ? st.subtotal - 500 : st.subtotal;
}

/** Runs the basket test and waits for its closing status line. */
async function runBasketTest(page) {
  await page.waitForSelector(".ukcp-test:not([hidden])", { timeout: 5000 });
  await page.$eval(".ukcp-test", (b) => b.click());
  await page.waitForFunction(() => /tested|limiting|already|first|doesn't|Every code/.test(document.querySelector(".ukcp-status").textContent), null, { timeout: 30000 });
  return page.textContent(".ukcp-status");
}

/** The shell Shopify's checkout app renders, with its back-links to the store. */
const HOSTED_CHECKOUT_HTML = `<!doctype html><html><head><title>Checkout - Currys</title></head><body>
  <header><a href="https://www.currys.co.uk"><img alt="Currys"></a>
    <a aria-label="Basket" id="cart-link" href="https://www.currys.co.uk/cart">Basket</a></header>
  <form><label for="dc">Discount code or gift card</label><input id="dc" name="reductions" type="text" style="width:200px;height:30px"></form>
</body></html>`;

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

  // A code you marked as broken must sink, not sit at the top greyed out.
  const order = await page.locator(".ukcp-code").allTextContents();
  check("thumbs-down code moves to the bottom", order[order.length - 1] === "SAVE20",
    `order: ${order.join(",")}`);

  await page.locator('.ukcp-item .ukcp-vote[data-vote="up"]').first().click();
  await page.waitForTimeout(100);
  const upOrder = await page.locator(".ukcp-code").allTextContents();
  check("thumbs-up code rises to the top", upOrder[0] !== "SAVE20", `order: ${upOrder.join(",")}`);

  await page.click(".ukcp-hide-site");
  await page.waitForTimeout(100);
  check("hide-on-site removes UI", await page.locator("#ukcp-badge").count() === 0);

  // Re-run the script in the same context: the preference must persist.
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForTimeout(300);
  check("hide-on-site persists across reloads", await page.locator("#ukcp-badge").count() === 0);
  await context.close();
}

console.log("\nIndex cache freshness");
{
  // The index holds the store keys. A stale one hides any store whose key has
  // changed, and hides it completely: an unresolved host renders no panel, so
  // there is no refresh button to recover with. This is why the TTL is an hour.
  const STALE_INDEX = JSON.stringify({
    meta: { version: 2 },
    aliases: {},
    stores: { "some-old-key.co.uk": 2 },
  });
  const seed = `
    window.__ukcpStore["ukcp_index"] = ${JSON.stringify(STALE_INDEX)};
    window.__ukcpStore["ukcp_index_time"] = Date.now() - (2 * 60 * 60 * 1000);
  `;
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML, seed);
  const fetchedIndex = await page.evaluate(() =>
    window.__ukcpRequests.some((u) => u.endsWith("/index.json")));
  check("index older than the TTL is refetched", fetchedIndex);
  check("store found again once the index is fresh",
    await page.locator("#ukcp-badge").count() === 1);
  await context.close();
}
{
  // The other half: a fresh cache must not be re-fetched on every page load.
  const seed = `
    window.__ukcpStore["ukcp_index"] = ${JSON.stringify(JSON.stringify(INDEX))};
    window.__ukcpStore["ukcp_index_time"] = Date.now();
  `;
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML, seed);
  const fetchedIndex = await page.evaluate(() =>
    window.__ukcpRequests.filter((u) => u.endsWith("/index.json")).length);
  check("fresh index is served from cache", fetchedIndex === 0, `${fetchedIndex} requests`);
  check("store still resolves from the cached index",
    await page.locator("#ukcp-badge").count() === 1);
  await context.close();
}
{
  // Refreshing only the store would re-read whatever key the cached index
  // already had, so a renamed store could never be recovered from the panel.
  const { page, context } = await makePage(browser, "www.currys.co.uk", CHECKOUT_HTML);
  await page.click("#ukcp-badge");
  const before = await page.evaluate(() =>
    window.__ukcpRequests.filter((u) => u.endsWith("/index.json")).length);
  await page.locator(".ukcp-refresh").click();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() =>
    window.__ukcpRequests.filter((u) => u.endsWith("/index.json")).length);
  check("refresh button refetches the index", after > before, `${before} -> ${after}`);
  await context.close();
}

console.log("\nHosted Shopify checkout");
{
  const { page, context } = await makePage(browser, "shop.app", HOSTED_CHECKOUT_HTML);
  check("shop.app checkout resolves the store from its cart link", await page.locator("#ukcp-badge").count() === 1);
  check("promo box found on the checkout", (await page.evaluate(() => { document.querySelector("#ukcp-badge").click(); return document.querySelector(".ukcp-status").textContent; })).includes("Promo box found"));
  check("no basket test button off the store's own domain", await page.locator(".ukcp-test:not([hidden])").count() === 0);
  await context.close();
}
{
  const { page, context } = await makePage(browser, "checkout.shopify.com", HOSTED_CHECKOUT_HTML);
  check("checkout.shopify.com resolves the store too", await page.locator("#ukcp-badge").count() === 1);
  await context.close();
}
{
  // Only the two hosted-checkout hosts read anchors; a random site linking to
  // a known store must stay silent.
  const { page, context } = await makePage(browser, "www.example.com", HOSTED_CHECKOUT_HTML);
  check("cart-link on an unrelated host is ignored", await page.locator("#ukcp-badge").count() === 0);
  await context.close();
}
{
  const unknown = HOSTED_CHECKOUT_HTML.replace(/currys\.co\.uk/g, "unknownshop.com");
  const { page, context } = await makePage(browser, "shop.app", unknown);
  const menu = await page.evaluate(() => window.__ukcpMenu.map((m) => m.name));
  check("unknown store on shop.app offers the request menu", menu.includes("Request codes for this store"));
  await page.evaluate(() => window.__ukcpMenu[0].fn());
  const opened = await page.evaluate(() => window.__ukcpOpened || "");
  check("request names the store, not shop.app", decodeURIComponent(opened).includes("Store request: unknownshop.com"), opened);
  await context.close();
}

console.log("\nShopify basket test");
{
  const state = { items: [{}], subtotal: 4000, total: 4000 };
  const { page, context, calls } = await makeShopifyPage(browser, "www.shopmock.co.uk", state, shopifyApply);
  const status = await runBasketTest(page);
  check("tests four codes then clears", JSON.stringify(calls) === JSON.stringify(["DEAD1", "GOOD15", "GOOD5", "DEAD2", ""]), JSON.stringify(calls));
  check("reports the best saving", status.includes("Best: GOOD15 saves £6.00"), status);
  check("says how many are left", status.includes("1 left"), status);
  const votes = await page.evaluate(() => window.__ukcpStore.ukcp_votes);
  check("working codes get a thumbs up", votes?.["shopmock.co.uk::GOOD15"] === "up" && votes?.["shopmock.co.uk::GOOD5"] === "up");
  check("failed codes are not thumbed down", !votes?.["shopmock.co.uk::DEAD1"]);
  const order = await page.$$eval(".ukcp-item .ukcp-code", (els) => els.map((e) => e.textContent));
  check("working codes rise, failed sink", order[0] === "GOOD15" && order[order.length - 1] === "DEAD2", order.join(","));
  check("basket restored", state.total === 4000 && state.codes.length === 0);
  check("nothing clicked on the page", (await page.evaluate(() => window.__ukcpClicks.length)) === 0);
  await context.close();
}
{
  const state = { items: [{}], subtotal: 4000, total: 3400, codes: [{ code: "MINE", applicable: true }] };
  const { page, context, calls } = await makeShopifyPage(browser, "www.shopmock.co.uk", state, shopifyApply);
  const status = await runBasketTest(page);
  check("existing discount: refused", status.includes("already has MINE applied"), status);
  check("existing discount: no cart calls at all", calls.length === 0);
  check("existing discount: still applied", state.codes[0]?.code === "MINE" && state.total === 3400);
  await context.close();
}
{
  const state = { items: [], subtotal: 0, total: 0 };
  const { page, context, calls } = await makeShopifyPage(browser, "www.shopmock.co.uk", state, shopifyApply);
  const status = await runBasketTest(page);
  check("empty basket: refused", status.includes("Add something to your basket"), status);
  check("empty basket: no cart calls", calls.length === 0);
  await context.close();
}
{
  const state = { items: [{}], subtotal: 4000, total: 4000 };
  const { page, context, calls } = await makeShopifyPage(browser, "www.shopmock.co.uk", state, (code, st) => (code === "GOOD5" ? 429 : shopifyApply(code, st)));
  const status = await runBasketTest(page);
  check("429: stops at once", status.includes("limiting code attempts"), status);
  check("429: still clears the basket", calls[calls.length - 1] === "" && state.codes.length === 0);
  check("429: keeps what it learned before the limit", (await page.evaluate(() => window.__ukcpStore.ukcp_votes))?.["shopmock.co.uk::GOOD15"] === "up");
  await context.close();
}

await browser.close();

console.log("\nPage errors");
check("no uncaught script errors", pageErrors.length === 0, pageErrors.join("; "));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
