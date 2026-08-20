/**
 * MyVoucherCodes.co.uk Scraper (Playwright)
 * Renders JavaScript to extract dynamically-loaded voucher codes.
 * Target: https://www.myvouchercodes.co.uk/{store-slug}
 */
import {
  launchBrowser, newPage, gotoAndWait, closeContext,
  isValidCode, guessType, delay,
} from "../lib/playwright-base.js";

const BASE_URL = "https://www.myvouchercodes.co.uk";

// Kept as fallback when sitemap discovery fails
const POPULAR_STORES = [
  "amazon", "asos", "boohoo", "currys", "john-lewis",
  "next", "argos", "very", "tesco", "sainsburys",
  "ocado", "morrisons", "marks-and-spencer", "new-look",
  "hm", "zara", "sports-direct", "nike", "adidas",
  "booking-com", "expedia", "just-eat", "dominos-pizza",
  "uber-eats", "deliveroo", "ebay", "shein",
  "dunelm", "wayfair", "wickes", "b-and-q",
  "boots", "superdrug", "lookfantastic", "myprotein",
  "halfords", "game-co-uk", "tui", "jet2holidays",
  "lastminute-com", "premier-inn", "travelodge",
  "ryanair", "easyjet", "samsung", "ao-com",
];

/**
 * Dynamically discover all stores from MyVoucherCodes sitemaps.
 * Fetches the sitemap index, then each merchant sub-sitemap to extract store slugs.
 * Falls back to POPULAR_STORES on failure.
 * @returns {Promise<string[]>}
 */
async function discoverStores() {
  try {
    const indexRes = await fetch(`${BASE_URL}/sitemap.xml`, { headers: { Accept: "application/xml" } });
    if (!indexRes.ok) throw new Error(`Sitemap index HTTP ${indexRes.status}`);
    const indexXml = await indexRes.text();

    // Extract merchant sub-sitemap URLs (e.g., /sitemaps/merchants/1.xml)
    const subSitemapUrls = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(m => m[1])
      .filter(u => u.includes("merchants"));

    if (subSitemapUrls.length === 0) throw new Error("No merchant sub-sitemaps found");

    const allStores = new Set();

    for (const url of subSitemapUrls) {
      try {
        const res = await fetch(url, { headers: { Accept: "application/xml" } });
        if (!res.ok) continue;
        const xml = await res.text();
        const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        for (const u of urls) {
          // Store URLs are like https://www.myvouchercodes.co.uk/{store-slug}
          const match = u.match(/myvouchercodes\.co\.uk\/([^/?#]+)$/);
          if (match) allStores.add(match[1]);
        }
      } catch (_) { /* skip failed sub-sitemap */ }
    }

    if (allStores.size > 0) {
      const stores = [...allStores];
      console.log(`[MyVoucherCodes] Discovered ${stores.length} stores from sitemaps`);
      return stores;
    }
  } catch (e) {
    console.log(`[MyVoucherCodes] Sitemap discovery failed: ${e.message}`);
  }

  console.log(`[MyVoucherCodes] Falling back to ${POPULAR_STORES.length} hardcoded stores`);
  return POPULAR_STORES;
}

/**
 * Scrape MyVoucherCodes using Playwright to render JS.
 * Dynamically discovers all stores from sitemaps before scraping.
 * @param {string[]} stores - Optional override store list (skips discovery)
 */
export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];

  const storeList = stores || await discoverStores();
  console.log(`[MyVoucherCodes] Scraping ${storeList.length} stores (Playwright)…`);

  const browser = await launchBrowser();

  for (const store of storeList) {
    let context;
    try {
      const url = `${BASE_URL}/${store}`;
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale: "en-GB",
      });
      const page = await context.newPage();
      await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3}", (r) => r.abort());

      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000); // Extra settle time for AJAX

      const storeName = await page.$eval("h1", (el) => el.textContent.trim()).catch(() => store.replace(/-/g, " "));
      const cleanName = storeName.replace(/discount codes?$/i, "").replace(/voucher codes?$/i, "").trim();

      // Extract codes from "Get Code" button containers
      // MyVoucherCodes reveals codes in data attributes or popup text
      const rawCodes = await page.evaluate(() => {
        const results = [];
        // Look for elements with data-code or similar attributes
        document.querySelectorAll("[data-code], [data-voucher-code], [data-coupon]").forEach((el) => {
          const code = el.getAttribute("data-code") || el.getAttribute("data-voucher-code") || el.getAttribute("data-coupon");
          if (code) {
            const parent = el.closest("[class*='deal'], [class*='offer'], [class*='voucher'], article, li");
            const desc = parent?.querySelector("p, [class*='desc'], [class*='title']")?.textContent?.trim() || "";
            results.push({ code: code.trim(), description: desc.substring(0, 200) });
          }
        });

        // Also look for code text inside deal cards
        document.querySelectorAll("[class*='deal'], [class*='offer'], [class*='voucher'], article").forEach((el) => {
          const text = el.textContent;
          const matches = text.match(/\b([A-Z0-9]{3,20})\b/g);
          if (matches) {
            for (const m of matches) {
              const hasLetter = /[A-Z]/i.test(m);
              const hasDigit = /\d/.test(m);
              const isLongCaps = m.length >= 6 && m === m.toUpperCase();
              if (hasLetter && (hasDigit || isLongCaps) && !/^(THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|CAN|GET|CODE|FREE|DEAL|OFFER|SAVE|VIEW|COPY|EXCLUSIVE|VERIFIED|TESTED|TODAY|VALID|SPONSORED|ARTICLES|MORE|LESS)/.test(m) && !/^20\d{2}$/.test(m)) {
                const desc = el.querySelector("p, [class*='desc'], [class*='title']")?.textContent?.trim() || "";
                results.push({ code: m, description: desc.substring(0, 200) });
                break; // One per container
              }
            }
          }
        });

        return results;
      });

      const seenCodes = new Set();
      for (const { code, description } of rawCodes) {
        if (isValidCode(code) && !seenCodes.has(code)) {
          seenCodes.add(code);
          entries.push({
            code,
            storeName: cleanName,
            storeDomain: `${store}.co.uk`,
            description,
            type: guessType(description),
            source: "myvouchercodes",
            url,
          });
        }
      }

      console.log(`[MyVoucherCodes] ${store}: ${seenCodes.size} codes`);
      await delay(1500);
    } catch (err) {
      errors.push(`${store}: ${err.message}`);
    } finally {
      if (context) await closeContext(context);
    }
  }

  await browser.close();
  const duration = Date.now() - start;
  console.log(`[MyVoucherCodes] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
