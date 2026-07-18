/**
 * Codes.co.uk Scraper (Playwright)
 * Target: https://codes.co.uk/{store}
 */
import {
  launchBrowser, closeContext,
  isValidCode, guessType, delay,
} from "../lib/playwright-base.js";

const BASE_URL = "https://codes.co.uk";

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

export async function scrape(stores = POPULAR_STORES) {
  const start = Date.now();
  const entries = [];
  const errors = [];

  console.log(`[CodesUK] Scraping ${stores.length} stores (Playwright)…`);
  const browser = await launchBrowser();

  for (const store of stores) {
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
      await page.waitForTimeout(3000);

      const title = await page.title();
      if (title.includes("Just a moment") || title.includes("Attention Required")) {
        errors.push(`${store}: Cloudflare`);
        continue;
      }

      const storeName = await page.$eval("h1", (el) => el.textContent.trim()).catch(() => cleanName(store));
      const rawCodes = await page.evaluate(EXTRACT_CODES).catch(() => []);

      const seenCodes = new Set();
      for (const { code, description } of rawCodes) {
        if (isValidCode(code) && !seenCodes.has(code)) {
          seenCodes.add(code);
          entries.push({
            code, storeName, storeDomain: extractDomain(store),
            description, type: guessType(description),
            source: "codesuk", url,
          });
        }
      }
      console.log(`[CodesUK] ${store}: ${seenCodes.size} codes`);
      await delay(1500);
    } catch (err) {
      errors.push(`${store}: ${err.message}`);
    } finally {
      if (context) await closeContext(context);
    }
  }

  await browser.close();
  const duration = Date.now() - start;
  console.log(`[CodesUK] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
