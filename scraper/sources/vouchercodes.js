/**
 * VoucherCodes.co.uk Scraper
 * Scrapes popular UK stores for voucher codes
 * Target: https://www.vouchercodes.co.uk/{store-slug}
 */
import { load as cheerio } from "cheerio";

const BASE_URL = "https://www.vouchercodes.co.uk";

// Top UK stores to scrape (high-traffic, frequently updated)
const POPULAR_STORES = [
  "amazon", "asos", "boohoo", "currys", "john-lewis",
  "next", "argos", "very", "tesco", "sainsburys",
  "ocado", "morrisons", "marks-and-spencer", "new-look",
  "hm", "zara", "primark", "sports-direct", "nike",
  "adidas", "booking-com", "expedia", "just-eat",
  "dominos-pizza", "uber-eats", "deliveroo",
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

/**
 * Scrape voucher codes from VoucherCodes for a list of stores
 * @param {string[]} stores - Optional override store list
 * @returns {{ entries: Array, duration: number, errors: string[] }}
 */
export async function scrape(stores = POPULAR_STORES) {
  const start = Date.now();
  const entries = [];
  const errors = [];

  console.log(`[VoucherCodes] Scraping ${stores.length} stores…`);

  for (const store of stores) {
    try {
      const url = `${BASE_URL}/${store}`;
      const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
      if (!res.ok) {
        errors.push(`${store}: HTTP ${res.status}`);
        continue;
      }

      const html = await res.text();
      const $ = cheerio(html);
      const storeName = $('h1, [class*="merchantName"], [class*="store-name"]').first().text().trim() || store.replace(/-/g, " ");

      // Find voucher code elements using DOM selectors
      // VoucherCodes stores codes in <span> elements that are siblings of .code-btn divs
      // Structure: <button> <div.code-btn>Get Code</div> <span>CODE</span> </button>
      $("[class*=code-btn]").each((_, el) => {
        const parent = $(el).parent();
        const codeSpan = parent.find("span").last();
        const code = codeSpan.text().trim();
        if (!code || code.length < 2 || code.length > 25) return;

        // Skip button text and common words
        if (code.toLowerCase().includes("get code") || code.toLowerCase().includes("view")) return;

        // Real promo codes almost always contain at least one digit
        if (!/\d/.test(code)) return;

        // Find description from nearby elements
        const grandparent = parent.parent();
        const descEl = grandparent.find("p, [class*=desc], [class*=title]").first();
        const description = descEl.text().trim().substring(0, 200);

        entries.push({
          code,
          storeName,
          storeDomain: `${store}.co.uk`,
          description,
          type: guessType(description),
          source: "vouchercodes",
          url,
        });
      });

      // Rate limiting: 1.5s between requests
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      errors.push(`${store}: ${err.message}`);
    }
  }

  const duration = Date.now() - start;
  console.log(`[VoucherCodes] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}

function guessType(desc) {
  const lower = (desc || "").toLowerCase();
  if (lower.match(/\d+%\s*off/)) return "percentage";
  if (lower.match(/£\d+/)) return "fixed";
  if (lower.match(/free\s+(delivery|shipping)/)) return "free_shipping";
  if (lower.match(/buy\s+\d+\s+get/)) return "bogo";
  return "unknown";
}

const COMMON_WORDS = new Set([
  "ABOUT", "ALSO", "BACK", "BEEN", "BEST", "BLUE", "BOOK", "BRAND",
  "CARRY", "CHASE", "CHECK", "CLAIM", "CODE", "COME", "COULD", "DEALS",
  "DELTA", "EVERY", "EXTRA", "FAMILY", "FINAL", "FIRST", "FOUND", "FREE",
  "FRONT", "FULL", "GIANT", "GREAT", "GROUP", "GUARANTEE", "GUARANTEED",
  "HAPPY", "HEART", "HEAVY", "HELLO", "HONEY", "HOUSE", "IMAGE", "INDEX",
  "JAMES", "JOHNS", "LARGE", "LEVEL", "LIMIT", "LIVES", "LOCAL", "LOGAN",
  "LONDON", "MAJOR", "MAKER", "MATCH", "MATTER", "MUCH", "NORTH", "OFFER",
  "ORIGINATES", "OTHER", "OFTEN", "ORDER", "PLACE", "POINT", "POWER",
  "PRESS", "PRICE", "PRINT", "PROMO", "PUBS", "PULSE", "PUSH", "QUEST",
  "QUOTE", "RANGE", "READY", "REAL", "RECORD", "RELEASE", "RESULT",
  "RIGHT", "ROUND", "ROUTE", "RULES", "RUSH", "SALES", "SCALE", "SCENE",
  "SCOPE", "SCORE", "SENSE", "SERVE", "SHOWN", "SINCE", "SIXTY", "SOUTH",
  "SPACE", "SPEED", "SPEND", "STAGE", "START", "STATE", "STEEL", "STEPS",
  "STOCK", "STONE", "STORE", "STORY", "STUDY", "STYLE", "SUGAR", "SUPER",
  "TABLE", "TAKEN", "TEACH", "TEAMS", "THEME", "THIRD", "THOSE", "THREE",
  "THROW", "TOTAL", "TOUGH", "TRADE", "TRAIL", "TREAT", "TRUST", "TRUTH",
  "TWICE", "UNDER", "UNION", "UNITY", "UNTIL", "UPPER", "UPSET", "URBAN",
  "USAGE", "USUAL", "VALID", "VALUE", "VIDEO", "VIRAL", "VISIT", "VITAL",
  "VOCAL", "VOICE", "WASTE", "WATCH", "WATER", "WAVES", "WHEAT", "WHEEL",
  "WHERE", "WHICH", "WHILE", "WHITE", "WHOLE", "WHOSE", "WIDER", "WOMAN",
  "WORLD", "WORRY", "WORSE", "WORST", "WOULD", "WRITE", "YIELD", "YOUNG",
  "YOURS", "ABOUT", "AFTER", "AGAIN", "BEING", "BELOW", "BETWEEN", "CARRY",
  "COULD", "EVERY", "FOUND", "GREAT", "HOUSE", "LARGE", "MIGHT", "NEVER",
  "OTHER", "OUGHT", "PLACE", "POINT", "RIGHT", "SHALL", "SINCE", "SMALL",
  "SOUND", "STILL", "THESE", "THING", "THINK", "THREE", "WATER", "WHENE",
  "WHERE", "WHICH", "WORLD", "WOULD", "WRITE", "YOURS",
]);

function isCommonWord(code) {
  return COMMON_WORDS.has(code.toUpperCase());
}
