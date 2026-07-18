/**
 * LatestDeals.co.uk Scraper (Playwright)
 * Target: https://www.latestdeals.co.uk/vouchers
 */
import {
  launchBrowser, closeContext,
  isValidCode, guessType, delay,
} from "../lib/playwright-base.js";

const BASE_URL = "https://www.latestdeals.co.uk/vouchers";

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
};

const EXTRACT_CODES = () => {
  const results = [];
  // LatestDeals uses community-posted codes
  document.querySelectorAll("[class*='deal'], [class*='voucher'], [class*='code'], article").forEach((el) => {
    const text = el.textContent;
    const matches = text.match(/\b([A-Z0-9]{3,20})\b/g);
    if (matches) {
      for (const m of matches) {
        const hasLetter = /[A-Z]/i.test(m);
        const hasDigit = /\d/.test(m);
        const isLongCaps = m.length >= 6 && m === m.toUpperCase();
        if (hasLetter && (hasDigit || isLongCaps) && !/^(THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|CAN|GET|CODE|FREE|DEAL|OFFER|SAVE|VIEW|COPY|EXCLUSIVE|VERIFIED|TESTED|TODAY|VALID|SPONSORED|ARTICLES|POSTED|COMMENTS|LIKES)/.test(m) && !/^20\d{2}$/.test(m)) {
          const desc = el.querySelector("p, [class*='desc'], [class*='title'], h3")?.textContent?.trim() || "";
          results.push({ code: m, description: desc.substring(0, 200) });
          break;
        }
      }
    }
  });
  return results;
};

export async function scrape() {
  const start = Date.now();
  const entries = [];
  const errors = [];

  console.log(`[LatestDeals] Scraping vouchers page (Playwright)…`);
  const browser = await launchBrowser();
  let context;

  try {
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-GB",
    });
    const page = await context.newPage();
    await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3}", (r) => r.abort());

    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // Scroll to load more content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    const rawCodes = await page.evaluate(EXTRACT_CODES).catch(() => []);

    const seenCodes = new Set();
    for (const { code, description } of rawCodes) {
      if (isValidCode(code) && !seenCodes.has(code)) {
        seenCodes.add(code);
        // Try to extract store name from description
        const storeMatch = description.match(/(?:at|for|on)\s+(.+?)(?:\s*[-–]|$)/i);
        const storeName = storeMatch ? storeMatch[1].trim() : "Various";
        const domain = Object.entries(DOMAIN_MAP).find(([k]) => storeName.toLowerCase().includes(k))?.[1] || "unknown.co.uk";

        entries.push({
          code, storeName, storeDomain: domain,
          description, type: guessType(description),
          source: "latestdeals", url: BASE_URL,
        });
      }
    }

    console.log(`[LatestDeals] Found ${seenCodes.size} codes`);
  } catch (err) {
    errors.push(`page: ${err.message}`);
  } finally {
    if (context) await closeContext(context);
  }

  await browser.close();
  const duration = Date.now() - start;
  console.log(`[LatestDeals] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
