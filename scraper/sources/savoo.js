/**
 * Savoo.co.uk Scraper (Playwright)
 * Renders JavaScript to extract dynamically-loaded voucher codes.
 * Target: https://www.savoo.co.uk/brands/{store}-discount-codes
 */
import {
  launchBrowser, closeContext,
  isValidCode, guessType, delay,
} from "../lib/playwright-base.js";

const BASE_URL = "https://www.savoo.co.uk/brands";

const POPULAR_STORES = [
  "amazon-discount-codes", "argos-discount-codes", "asos-discount-codes",
  "boohoo-discount-codes", "currys-discount-codes", "john-lewis-discount-codes",
  "next-discount-codes", "very-discount-codes", "tesco-discount-codes",
  "sainsburys-discount-codes", "morrisons-discount-codes", "marks-and-spencer-discount-codes",
  "new-look-discount-codes", "hm-discount-codes", "zara-discount-codes",
  "sports-direct-discount-codes", "nike-discount-codes", "adidas-discount-codes",
  "just-eat-discount-codes", "dominos-pizza-discount-codes", "uber-eats-discount-codes",
  "deliveroo-discount-codes", "ebay-discount-codes", "shein-discount-codes",
  "dunelm-discount-codes", "wayfair-discount-codes", "wickes-discount-codes",
  "b-and-q-discount-codes", "boots-discount-codes", "superdrug-discount-codes",
  "lookfantastic-discount-codes", "myprotein-discount-codes", "halfords-discount-codes",
  "game-promo-codes", "tui-discount-codes", "debenhams-discount-codes",
  "samsung-discount-codes", "ao-com-discount-codes", "wowcher-discount-codes",
  "groupon-discount-codes", "booking-com-discount-codes", "expedia-discount-codes",
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
  "halfords": "halfords.com", "game": "game.co.uk", "tui": "tui.co.uk",
  "debenhams": "debenhams.com", "samsung": "samsung.com", "ao-com": "ao.com",
  "wowcher": "wowcher.com", "groupon": "groupon.co.uk",
  "booking-com": "booking.com", "expedia": "expedia.co.uk",
};

function extractDomain(slug) {
  const name = slug.replace(/-discount-codes$/, "").replace(/-promo-codes$/, "");
  return DOMAIN_MAP[name] || `${name}.co.uk`;
}

function cleanStoreName(slug) {
  return slug
    .replace(/-discount-codes$/, "")
    .replace(/-promo-codes$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function scrape(stores = POPULAR_STORES) {
  const start = Date.now();
  const entries = [];
  const errors = [];

  console.log(`[Savoo] Scraping ${stores.length} stores (Playwright)…`);

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

      const storeName = await page.$eval("h1", (el) => el.textContent.trim()).catch(() => cleanStoreName(store));

      const rawCodes = await page.evaluate(() => {
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
      });

      const seenCodes = new Set();
      for (const { code, description } of rawCodes) {
        if (isValidCode(code) && !seenCodes.has(code)) {
          seenCodes.add(code);
          entries.push({
            code,
            storeName,
            storeDomain: extractDomain(store),
            description,
            type: guessType(description),
            source: "savoo",
            url,
          });
        }
      }

      console.log(`[Savoo] ${store}: ${seenCodes.size} codes`);
      await delay(1500);
    } catch (err) {
      errors.push(`${store}: ${err.message}`);
    } finally {
      if (context) await closeContext(context);
    }
  }

  await browser.close();
  const duration = Date.now() - start;
  console.log(`[Savoo] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
