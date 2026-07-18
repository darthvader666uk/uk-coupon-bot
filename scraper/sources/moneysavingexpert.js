/**
 * MoneySavingExpert.com Scraper (Playwright)
 * Target: https://www.moneysavingexpert.com/deals/discount-voucher-codes/
 */
import {
  launchBrowser, closeContext,
  isValidCode, guessType, delay,
} from "../lib/playwright-base.js";

const URL = "https://www.moneysavingexpert.com/deals/discount-voucher-codes/";

const DOMAIN_MAP = {
  "amazon": "amazon.co.uk", "argos": "argos.co.uk", "asos": "asos.com",
  "boohoo": "boohoo.com", "currys": "currys.co.uk", "john lewis": "johnlewis.com",
  "next": "next.co.uk", "very": "very.co.uk", "tesco": "tesco.com",
  "sainsburys": "sainsburys.co.uk", "morrisons": "morrisons.co.uk",
  "marks and spencer": "marksandspencer.com", "new look": "newlook.com",
  "hm": "hm.com", "zara": "zara.com", "sports direct": "sportsdirect.com",
  "nike": "nike.com", "adidas": "adidas.co.uk", "just eat": "just-eat.co.uk",
  "dominos": "dominos.co.uk", "uber eats": "ubereats.com",
  "deliveroo": "deliveroo.co.uk", "ebay": "ebay.co.uk", "shein": "shein.co.uk",
  "dunelm": "dunelm.com", "wayfair": "wayfair.co.uk", "wickes": "wickes.co.uk",
  "b&q": "diy.com", "boots": "boots.com", "superdrug": "superdrug.com",
  "lookfantastic": "lookfantastic.com", "myprotein": "myprotein.co.uk",
  "halfords": "halfords.com", "tui": "tui.co.uk", "debenhams": "debenhams.com",
  "samsung": "samsung.com", "ao": "ao.com",
  "booking.com": "booking.com", "expedia": "expedia.co.uk",
};

const EXTRACT_CODES = () => {
  const results = [];
  // MSE curates codes in article format
  document.querySelectorAll("[class*='deal'], [class*='offer'], [class*='voucher'], article, li, tr").forEach((el) => {
    const text = el.textContent;
    const matches = text.match(/\b([A-Z0-9]{3,20})\b/g);
    if (matches) {
      for (const m of matches) {
        const hasLetter = /[A-Z]/i.test(m);
        const hasDigit = /\d/.test(m);
        const isLongCaps = m.length >= 6 && m === m.toUpperCase();
        if (hasLetter && (hasDigit || isLongCaps) && !/^(THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|CAN|GET|CODE|FREE|DEAL|OFFER|SAVE|VIEW|COPY|EXCLUSIVE|VERIFIED|TESTED|TODAY|VALID|SPONSORED|ARTICLES|MSE|TIPS|DEALS|NEWSLETTER|RECOMMENDED|LINKS|DISCLOSURE|AFFILIATE)/.test(m) && !/^20\d{2}$/.test(m)) {
          const desc = el.querySelector("p, [class*='desc'], [class*='title'], h3, h4")?.textContent?.trim() || "";
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

  console.log(`[MSE] Scraping voucher codes page (Playwright)…`);
  const browser = await launchBrowser();
  let context;

  try {
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-GB",
    });
    const page = await context.newPage();
    await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3}", (r) => r.abort());

    await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // Scroll to load more
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    const rawCodes = await page.evaluate(EXTRACT_CODES).catch(() => []);

    const seenCodes = new Set();
    for (const { code, description } of rawCodes) {
      if (isValidCode(code) && !seenCodes.has(code)) {
        seenCodes.add(code);
        // Try to extract store name
        const lower = description.toLowerCase();
        let storeName = "Various";
        let domain = "unknown.co.uk";
        for (const [name, d] of Object.entries(DOMAIN_MAP)) {
          if (lower.includes(name)) {
            storeName = name.replace(/\b\w/g, (c) => c.toUpperCase());
            domain = d;
            break;
          }
        }

        entries.push({
          code, storeName, storeDomain: domain,
          description, type: guessType(description),
          source: "moneysavingexpert", url: URL,
        });
      }
    }

    console.log(`[MSE] Found ${seenCodes.size} codes`);
  } catch (err) {
    errors.push(`page: ${err.message}`);
  } finally {
    if (context) await closeContext(context);
  }

  await browser.close();
  const duration = Date.now() - start;
  console.log(`[MSE] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
