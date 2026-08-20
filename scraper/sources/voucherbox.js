/**
 * Voucherbox.co.uk Scraper (Playwright)
 * Target: https://www.voucherbox.co.uk/vouchers/{store}
 */
import {
  launchBrowser, closeContext,
  isValidCode, guessType,
} from "../lib/playwright-base.js";

const BASE_URL = "https://www.voucherbox.co.uk/vouchers";

// Kept as fallback when sitemap discovery fails
const POPULAR_STORES = [
  "amazon", "argos", "asos", "boohoo", "currys", "john-lewis",
  "next", "very", "tesco", "sainsburys", "morrisons", "marks-and-spencer",
  "new-look", "hm", "zara", "sports-direct", "nike", "adidas",
  "just-eat", "dominos-pizza", "uber-eats", "deliveroo",
  "ebay", "shein", "dunelm", "wayfair", "wickes", "b-and-q",
  "boots", "superdrug", "lookfantastic", "myprotein", "halfords",
  "tui", "debenhams", "samsung", "ao-com", "booking-com", "expedia",
];

const DOMAIN_MAP = {
  "amazon": "amazon.co.uk", "argos": "argos.co.uk", "asos": "asos.com",
  "boohoo": "boohoo.com", "currys": "currys.co.uk", "john-lewis": "johnlewis.com",
  "next": "next.co.uk", "very": "very.co.uk", "tesco": "tesco.com",
  "sainsburys": "sainsburys.co.uk", "morrisons": "morrisons.co.uk",
  "marks-and-spencer": "marksandspencer.com", "new-look": "newlook.com",
  "hm": "hm.com", "zara": "zara.com", "sports-direct": "sportsdirect.com",
  "nike": "nike.com", "adidas": "adidas.co.uk", "just-eat": "just-eat.co.uk",
  "dominos-pizza": "dominos.co.uk", "uber-eats": "ubereats.com",
  "deliveroo": "deliveroo.co.uk", "ebay": "ebay.co.uk", "shein": "shein.co.uk",
  "dunelm": "dunelm.com", "wayfair": "wayfair.co.uk", "wickes": "wickes.co.uk",
  "b-and-q": "diy.com", "boots": "boots.com", "superdrug": "superdrug.com",
  "lookfantastic": "lookfantastic.com", "myprotein": "myprotein.co.uk",
  "halfords": "halfords.com", "tui": "tui.co.uk", "debenhams": "debenhams.com",
  "samsung": "samsung.com", "ao-com": "ao.com",
  "booking-com": "booking.com", "expedia": "expedia.co.uk",
};

function extractDomain(slug) {
  return DOMAIN_MAP[slug] || `${slug}.co.uk`;
}

function cleanName(slug) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Process items concurrently with a fixed pool size.
 * @param {Array} items - Items to process
 * @param {number} concurrency - Max concurrent workers
 * @param {Function} fn - Async function(item, index) => result
 * @returns {Promise<Array>} Results in original order
 */
async function processInPool(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Dynamically discover all stores from Voucherbox sitemap.
 * Voucherbox has a flat sitemap listing all store voucher pages.
 * Falls back to POPULAR_STORES on failure.
 * @returns {Promise<string[]>}
 */
async function discoverStores() {
  try {
    const res = await fetch("https://www.voucherbox.co.uk/sitemap.xml", { headers: { Accept: "application/xml" } });
    if (!res.ok) throw new Error(`Sitemap HTTP ${res.status}`);
    const xml = await res.text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    const allStores = new Set();
    for (const u of urls) {
      // Store URLs are like https://www.voucherbox.co.uk/vouchers/{store-slug}
      const match = u.match(/voucherbox\.co\.uk\/vouchers\/([^/?#]+)$/);
      if (match) allStores.add(match[1]);
    }

    if (allStores.size > 0) {
      const stores = [...allStores];
      console.log(`[Voucherbox] Discovered ${stores.length} stores from sitemap`);
      return stores;
    }
  } catch (e) {
    console.log(`[Voucherbox] Sitemap discovery failed: ${e.message}`);
  }

  console.log(`[Voucherbox] Falling back to ${POPULAR_STORES.length} hardcoded stores`);
  return POPULAR_STORES;
}

const EXTRACT_CODES = () => {
  const results = [];
  document.querySelectorAll("[data-code], [data-voucher], [data-coupon]").forEach((el) => {
    const code = el.getAttribute("data-code") || el.getAttribute("data-voucher") || el.getAttribute("data-coupon");
    if (code) {
      const parent = el.closest("[class*='deal'], [class*='offer'], [class*='voucher'], article, li");
      const desc = parent?.querySelector("p, [class*='desc'], [class*='title']")?.textContent?.trim() || "";
      results.push({ code: code.trim(), description: desc.substring(0, 200) });
    }
  });
  document.querySelectorAll("[class*='deal'], [class*='offer'], [class*='voucher'], article").forEach((el) => {
    const text = el.textContent;
    const matches = text.match(/\b([A-Z0-9]{3,20})\b/g);
    if (matches) {
      for (const m of matches) {
        const hasLetter = /[A-Z]/i.test(m);
        const hasDigit = /\d/.test(m);
        const isLongCaps = m.length >= 6 && m === m.toUpperCase();
        if (hasLetter && (hasDigit || isLongCaps) && !/^(THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|CAN|GET|CODE|FREE|DEAL|OFFER|SAVE|VIEW|COPY|EXCLUSIVE|VERIFIED|TESTED|TODAY|VALID|SPONSORED|ARTICLES)/.test(m) && !/^20\d{2}$/.test(m)) {
          const desc = el.querySelector("p, [class*='desc'], [class*='title']")?.textContent?.trim() || "";
          results.push({ code: m, description: desc.substring(0, 200) });
          break;
        }
      }
    }
  });
  return results;
};

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];

  const storeList = stores || await discoverStores();
  console.log(`[Voucherbox] Scraping ${storeList.length} stores (Playwright)…`);

  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-GB",
  });

  let codesFound = 0;

  await processInPool(storeList, 5, async (store, idx) => {
    let page;
    try {
      const url = `${BASE_URL}/${store}`;
      page = await context.newPage();
      await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3}", (r) => r.abort());

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });

      const title = await page.title();
      if (title.includes("Just a moment") || title.includes("Attention Required")) {
        errors.push(`${store}: Cloudflare`);
        return;
      }

      const storeName = await page.$eval("h1", (el) => el.textContent.trim()).catch(() => cleanName(store));
      const rawCodes = await page.evaluate(EXTRACT_CODES);

      const seenCodes = new Set();
      for (const { code, description } of rawCodes) {
        if (isValidCode(code) && !seenCodes.has(code)) {
          seenCodes.add(code);
          entries.push({
            code, storeName, storeDomain: extractDomain(store),
            description, type: guessType(description),
            source: "voucherbox", url,
          });
        }
      }

      codesFound += seenCodes.size;
    } catch (err) {
      errors.push(`${store}: ${err.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }

    // Progress log every 50 stores
    if ((idx + 1) % 50 === 0) {
      console.log(`[Voucherbox] Progress: ${idx + 1}/${storeList.length} stores scraped (${codesFound} codes found so far)`);
    }
  });

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const duration = Date.now() - start;
  console.log(`[Voucherbox] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
