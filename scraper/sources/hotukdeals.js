/**
 * HotUKDeals Voucher Code RSS Scraper
 * Fetches from: https://www.hotukdeals.com/rss/vouchers
 * RSS contains deals posted to the vouchers section with code, merchant, description
 */
import { load as cheerio } from "cheerio";

const RSS_URL = "https://www.hotukdeals.com/rss/vouchers";
const BASE_URL = "https://www.hotukdeals.com";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

/**
 * Scrape HotUKDeals voucher codes from RSS feed
 * @returns {Array} Array of normalized code entries
 */
export async function scrape() {
  const start = Date.now();
  console.log("[HotUKDeals] Fetching RSS feed…");

  const res = await fetch(RSS_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`HotUKDeals RSS returned ${res.status}: ${res.statusText}`);
  }

  const xml = await res.text();
  const $ = cheerio(xml);
  const entries = [];

  // RSS items contain deal info
  $("item").each((_, item) => {
    const title = $(item).find("title").text().trim();
    const link = $(item).find("link").text().trim();
    const description = $(item).find("description").text().trim();
    const fullDescription = $(item).find("\\:description, description").text().trim() || description;

    // Try to extract code from title or description
    // HotUKDeals titles often look like: "CODE: 20% off at StoreName"
    // or descriptions contain the actual code
    const code = extractCode(title, fullDescription);
    if (!code) return;

    const storeName = extractStore(title, link);
    const storeDomain = guessDomain(storeName);

    entries.push({
      code,
      storeName: storeName || "Unknown",
      storeDomain,
      description: cleanDescription(title),
      type: guessType(title),
      source: "hotukdeals",
      url: link,
    });
  });

  const duration = Date.now() - start;
  console.log(`[HotUKDeals] Found ${entries.length} codes in ${duration}ms`);

  return { entries, duration };
}

/**
 * Extract promo code from title/description text
 */
function extractCode(title, description) {
  const combined = `${title} ${description}`;

  // Pattern 1: "CODE: XXXX" or "Code: XXXX" or "Voucher: XXXX"
  const codeMatch = combined.match(/(?:code|voucher|promo)[:\s]+([A-Z0-9]{3,30})/i);
  if (codeMatch && !isCommonWord(codeMatch[1])) return codeMatch[1];

  // Pattern 2: standalone alphanumeric code (5-20 chars, must have a digit OR be all-caps with 6+ chars)
  const standalone = combined.match(/\b([A-Z0-9]{5,20})\b/);
  if (standalone && !isCommonWord(standalone[1])) {
    const code = standalone[1];
    // Real promo codes usually have digits, or are short all-caps
    const hasDigit = /\d/.test(code);
    const isShortCaps = code.length >= 6 && code === code.toUpperCase();
    if (hasDigit || isShortCaps) return code;
  }

  // Pattern 3: quoted code
  const quoted = combined.match(/["']([A-Z0-9]{3,30})["']/i);
  if (quoted && !isCommonWord(quoted[1])) return quoted[1];

  return null;
}

function cleanStoreName(name) {
  let s = name.replace(/\]\]>/g, '').replace(/<!\[CDATA\[/gi, '').trim();

  const descMarkers = /\b(with|for|using|via|by|when|if|get|save|spend|from|code|voucher|discount|free|buy|selected|except|per|chance|win|register|expected|release|etc|minimum|exclusive|reward|your|new|coupon|fuel|galaxy|flip|fold|pixel|interest|worth|litre|exclusions|exceptions)\b/i;
  const match = s.match(descMarkers);
  if (match && match.index > 0) {
    s = s.substring(0, match.index).trim();
  }

  s = s.replace(/[,;:\s]+$/, '').trim();

  const words = s.split(/\s+/).filter(Boolean).slice(0, 3);
  const cleaned = words.map(w => w.replace(/^[,;:!?()]+|[,;:!?()]+$/g, '')).filter(Boolean);

  const genericWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'your', 'new', 'via', 'per', 'by', 'instore', 'online', 'checkout', 'all', 'our', 'get', 'save', 'up', 'no', 'etc']);
  const nonGeneric = cleaned.filter(w => !genericWords.has(w.toLowerCase()));

  if (nonGeneric.length === 0) return "Unknown";

  return cleaned.join(' ').trim();
}

function extractStore(title, link) {
  const urlMatch = link?.match(/\/vouchers\/([^\/\?]+)/);
  if (urlMatch) {
    const store = urlMatch[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const cleaned = cleanStoreName(store);
    if (cleaned !== "Unknown") return cleaned;
  }

  const titleMatch = title.match(/(?:at|for|on)\s+(.+?)(?:\s*[-–]|$)/i);
  if (titleMatch) {
    const store = titleMatch[1].trim();
    const cleaned = cleanStoreName(store);
    if (cleaned !== "Unknown") return cleaned;
  }

  return "Unknown";
}

function guessDomain(storeName) {
  if (!storeName || storeName === "Unknown") return "unknown.co.uk";

  const lower = storeName.toLowerCase().trim();

  const badPatterns = /\b(flip|fold|galaxy|pixel|iphone|expected|release|register|interest|chance|voucher|fuel|coupon|worth|litre|selected|exclusion|exception|day|week|month)\b/;
  if (badPatterns.test(lower)) return "unknown.co.uk";

  if (/^[£€$\d]/.test(lower)) return "unknown.co.uk";

  const words = lower.split(/\s+/).filter(Boolean);

  const genericFirstWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'your', 'new', 'via', 'per', 'by', 'instore', 'online', 'checkout', 'all', 'our', 'get', 'save', 'up', 'no']);
  if (words.length > 0 && genericFirstWords.has(words[0])) return "unknown.co.uk";

  const filtered = words.filter(w => !/^[£€$\d,.\-%]+$/.test(w) && w.length > 1);
  const slug = filtered.slice(0, 2).join('').replace(/[^a-z0-9]/g, '');

  if (!slug || slug.length < 2) return "unknown.co.uk";

  return `${slug.substring(0, 30)}.co.uk`;
}

function guessType(title) {
  const lower = title.toLowerCase();
  if (lower.match(/\d+%\s*off/)) return "percentage";
  if (lower.match(/£\d+/)) return "fixed";
  if (lower.match(/free\s+(delivery|shipping)/)) return "free_shipping";
  if (lower.match(/buy\s+\d+\s+get/)) return "bogo";
  return "unknown";
}

function cleanDescription(title) {
  return title
    .replace(/^(?:CODE|Voucher|Promo)[:\s]+/i, "")
    .replace(/\s*[-–|].*$/, "")
    .trim()
    .substring(0, 200);
}

const COMMON_WORDS = new Set([
  "THAT", "THIS", "WITH", "FROM", "HAVE", "WILL", "BEEN", "THEIR",
  "WOULD", "COULD", "SHOULD", "ABOUT", "WHICH", "WHEN", "WHAT",
  "WHERE", "YOUR", "THEM", "THEN", "THEY", "SOME", "MORE", "MOST",
  "VERY", "ALSO", "JUST", "EACH", "MUCH", "MUST", "EVEN", "WELL",
  "CODE", "FOLLOWED", "ORIGINATES", "CDATA", "VALID", "FOR", "AND",
  "THE", "VIA", "WHEN", "BEST", "BLUE", "BOOK", "COME", "DEALS",
  "EVERY", "EXTRA", "FREE", "GREAT", "GROUP", "HAPPY", "HEART",
  "INDEX", "LARGE", "LEVEL", "LIMIT", "LOCAL", "MAJOR", "MATCH",
  "MATTER", "OFFER", "OTHER", "OFTEN", "ORDER", "PLACE", "POINT",
  "POWER", "PRESS", "PRICE", "PRINT", "PROMO", "PUSH", "RANGE",
  "READY", "REAL", "RIGHT", "ROUND", "RULES", "SALES", "SCENE",
  "SCOPE", "SCORE", "SENSE", "SERVE", "SHOWN", "SINCE", "SPACE",
  "SPEED", "SPEND", "STAGE", "START", "STATE", "STEEL", "STEPS",
  "STOCK", "STORE", "STORY", "STYLE", "TABLE", "TAKEN", "TEAMS",
  "THEME", "THIRD", "THOSE", "THREE", "THROW", "TOTAL", "TOUGH",
  "TRADE", "TRAIL", "TREAT", "TRUST", "TRUTH", "UNDER", "UNION",
  "UNITY", "UNTIL", "UPPER", "USAGE", "USUAL", "VALID", "VALUE",
  "VIDEO", "VISIT", "WASTE", "WATCH", "WATER", "WHITE", "WHOLE",
  "WOMAN", "WORLD", "WORRY", "WRITE", "YOURS", "AGAIN", "BEING",
  "BELOW", "CARRY", "FOUND", "HOUSE", "MIGHT", "NEVER", "OUGHT",
  "RIGHT", "SHALL", "SMALL", "SOUND", "STILL", "THING", "THINK",
]);

function isCommonWord(code) {
  return COMMON_WORDS.has(code.toUpperCase());
}
