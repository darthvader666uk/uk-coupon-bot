/**
 * Wethrift scraper (headful Playwright)
 *
 * Wethrift collects codes from influencer posts and store ads (Instagram,
 * TikTok, Facebook ad library) and scores each one with a "chance" of working,
 * built from shopper checkout results. That makes it the only source here
 * with codes like Fireaway's MINNA101, which no coupon site proper lists.
 *
 * Plain requests get a 403 on every page, so this needs the same headful
 * browser as Coupert and runs on the self-hosted runner. robots.txt allows the
 * store pages (it only disallows /api/ and the /link redirects).
 *
 * Each page embeds its data as JSON in <script id="__D">: props.coupons is the
 * live list, props.expiredCoupons the dead one (ignored). Codes below
 * MIN_CHANCE, or with no chance at all (nobody has tried them), are skipped:
 * those are mostly year-old ad codes.
 *
 * Target: https://www.wethrift.com/codes/{domain}
 */
import { isValidCode, guessType, launchHeadfulBrowser, delay } from "../lib/playwright-base.js";
import { canonicalDomain, displayName } from "../lib/stores.js";
import { loadStoreDomains, queryDomains } from "./caramel.js";
import { selectSlice } from "./savoo.js";

const STORE_URL = "https://www.wethrift.com/codes";
export const STORES_PER_RUN = 600;
/** Stop starting new stores after this, so a slow night still gets committed. */
const RUN_DEADLINE_MS = 55 * 60 * 1000;
const REQUEST_GAP_MS = 2000;
export const MIN_CHANCE = 0.1;
const ABORT_AFTER_CONSECUTIVE_FAILURES = 4;

/** Runs inside the page: the embedded data blob, or null. */
export function collectData() {
  const el = document.getElementById("__D");
  if (!el) return null;
  try { return JSON.parse(el.textContent).props || null; } catch { return null; }
}

function typeFor(headline) {
  const pct = /(\d{1,2}(?:\.\d+)?)\s*%/.exec(headline);
  if (pct) return { type: "percentage", value: parseFloat(pct[1]) };
  const gbp = /£\s*(\d+(?:\.\d+)?)\s*off/i.exec(headline);
  if (gbp) return { type: "fixed", value: parseFloat(gbp[1]) };
  return { type: guessType(headline), value: null };
}

/** Database entries from one page's data. Pure, so it can run without a browser. */
export function extractEntries(props, storeDomain, url) {
  const entries = [];
  const seen = new Set();
  for (const c of props?.coupons || []) {
    const code = String(c.code || "").trim();
    if (!isValidCode(code) || seen.has(code.toUpperCase())) continue;
    if (typeof c.chance !== "number" || c.chance < MIN_CHANCE) continue;
    seen.add(code.toUpperCase());
    const headline = c.headline || "";
    entries.push({
      code,
      storeName: displayName(storeDomain, props.store?.name),
      storeDomain,
      description: c.description || headline,
      ...typeFor(headline),
      source: "wethrift",
      url,
    });
  }
  return entries;
}

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];
  const storeList = stores || selectSlice(loadStoreDomains().sort(), STORES_PER_RUN);

  let browser;
  try {
    browser = await launchHeadfulBrowser();
  } catch (err) {
    const msg = `could not launch browser: ${err.message}`;
    console.log(`[Wethrift] ${msg}`);
    return { entries, duration: Date.now() - start, errors: [msg] };
  }
  const context = await browser.newContext({ locale: "en-GB", viewport: { width: 1280, height: 800 } });
  // One page reused for every store, as in coupert.js: a tab per store crashed
  // the browser partway through long runs.
  let page = await context.newPage();

  /** Props for one site, null when Wethrift has no page for it. Throws when blocked. */
  async function load(site) {
    if (page.isClosed()) page = await context.newPage();
    const res = await page.goto(`${STORE_URL}/${site}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = res?.status() ?? 0;
    if (status === 404 || status === 410) return null;
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const props = await page.evaluate(collectData);
    if (!props) throw new Error(`no data on page ("${await page.title().catch(() => "")}")`);
    return props;
  }

  console.log(`[Wethrift] Scraping ${storeList.length} stores (headful Playwright)…`);
  let hits = 0;
  let anySuccess = false;
  let consecutiveFailures = 0;

  for (const domain of storeList) {
    if (Date.now() - start > RUN_DEADLINE_MS) {
      console.log(`[Wethrift] Deadline reached — stopping with ${storeList.length - storeList.indexOf(domain)} stores unvisited`);
      break;
    }
    // Every spelling, not just the first that answers: Wethrift can file one
    // shop under two domains (Fireaway is both fireaway.co.uk and its
    // fireaway.app4food.co.uk ordering site).
    for (const site of queryDomains(domain)) {
      try {
        const props = await load(site);
        anySuccess = true;
        consecutiveFailures = 0;
        if (!props) continue;
        // A page for some other shop, reached by redirect, must not lend it codes.
        const primary = canonicalDomain(props.store?.primary_domain || site);
        if (primary !== domain) {
          console.log(`[Wethrift] ${site}: page is for ${primary}, not ${domain} — skipping`);
          continue;
        }
        const found = extractEntries(props, domain, `${STORE_URL}/${site}`);
        if (found.length) {
          entries.push(...found);
          hits++;
          console.log(`[Wethrift] ${site}: ${found.length} codes (of ${props.coupons?.length || 0} listed)`);
        }
      } catch (err) {
        consecutiveFailures++;
        const reason = err.message.split("\n")[0];
        errors.push(`${site}: ${reason}`);
        console.log(`[Wethrift] ${site}: ${reason}`);
      } finally {
        await delay(REQUEST_GAP_MS);
      }
    }
    if (!anySuccess && consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
      const msg = `blocked after ${consecutiveFailures} consecutive failures`;
      console.log(`[Wethrift] ${msg}`);
      errors.push(msg);
      break;
    }
  }

  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const duration = Date.now() - start;
  console.log(`[Wethrift] Found ${entries.length} codes across ${hits} pages (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
