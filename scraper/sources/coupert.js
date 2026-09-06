/**
 * Coupert UK Scraper (Firecrawl)
 *
 * Coupert sits behind Cloudflare. The previous Playwright implementation was
 * challenged on every request ("driffle-com: Cloudflare challenge") and had
 * been silently returning nothing, so none of these codes ever reached the
 * database. Firecrawl renders the page and gets through, same as the GG.deals
 * pre-fetch already does.
 *
 * Because each page costs a Firecrawl credit, this scrapes an explicit list of
 * stores rather than the whole sitemap — Coupert lists thousands.
 *
 * Target: https://uk.coupert.com/promo-code/{slug}
 */
import { isValidCode, guessType } from "../lib/playwright-base.js";

const BASE_URL = "https://uk.coupert.com/promo-code";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

/**
 * Stores to scrape, as Coupert URL slugs. One Firecrawl credit each per run.
 * Gaming key resellers first — they rotate codes constantly and are the ones
 * other sources cover worst.
 */
export const STORES = [
  // Gaming key resellers
  "driffle-com", "eneba-com", "k4g-com", "g2a-com", "kinguin",
  "gamivo", "instant-gaming", "cdkeys-uk", "allkeyshop", "electronic-first",
  "green-man-gaming", "fanatical", "gamesplanet", "gamersgate", "hrk-game",
  "2game", "wingamestore", "nuuvem", "yuplay", "gameseal",
  // UK high street / general
  "amazon-co-uk", "argos", "currys", "very", "next",
  "john-lewis", "boots", "superdrug", "asos", "boohoo",
  "new-look", "sports-direct", "nike", "adidas", "dunelm",
  "wayfair", "wickes", "b-and-q", "halfords", "ao-com",
  "samsung", "debenhams", "lookfantastic", "myprotein", "shein",
  "just-eat", "deliveroo", "dominos-pizza", "tui", "expedia",
];

/**
 * Slugs whose domain can't be derived mechanically.
 * Everything else goes through slugToDomain() below.
 */
const DOMAIN_MAP = {
  "amazon-co-uk": "amazon.co.uk",
  "ebay-co-uk": "ebay.co.uk",
  "cdkeys-uk": "cdkeys.com",
  "apple-uk": "apple.com",
  "b-and-q": "b-and-q.co.uk",
  "john-lewis": "john-lewis.co.uk",
  "sports-direct": "sports-direct.co.uk",
  "dominos-pizza": "dominos.co.uk",
  "ao-com": "ao.com",
  "instant-gaming": "instant-gaming.com",
  "green-man-gaming": "greenmangaming.com",
  "hrk-game": "hrkgame.com",
  "allkeyshop": "allkeyshop.com",
  "electronic-first": "electronicfirst.com",
  "gamesplanet": "gamesplanet.com",
  "gamersgate": "gamersgate.com",
  "wingamestore": "wingamestore.com",
  "gameseal": "gameseal.com",
  "fanatical": "fanatical.com",
  "kinguin": "kinguin.net",
  "gamivo": "gamivo.com",
  "nuuvem": "nuuvem.com",
  "yuplay": "yuplay.com",
  "2game": "2game.com",
  "nike": "nike.com",
  "samsung": "samsung.co.uk",
  "asos": "asos.co.uk",
  "boohoo": "boohoo.co.uk",
  "shein": "shein.co.uk",
  "debenhams": "debenhams.com",
  "wayfair": "wayfair.co.uk",
};

/**
 * Derive a domain from a Coupert slug.
 *
 * The old version did `slug.replace(/-/g, "") + ".co.uk"`, which turned
 * "driffle-com" into "drifflecom.co.uk" — a store that doesn't exist and can
 * never match a real hostname. Trailing "-com" / "-co-uk" are TLD markers.
 */
export function slugToDomain(slug) {
  if (DOMAIN_MAP[slug]) return DOMAIN_MAP[slug];
  if (slug.includes(".")) return slug.toLowerCase(); // already a domain
  if (slug.endsWith("-co-uk")) return `${slug.slice(0, -6).replace(/-/g, "")}.co.uk`;
  if (slug.endsWith("-com")) return `${slug.slice(0, -4).replace(/-/g, "")}.com`;
  if (slug.endsWith("-uk")) return `${slug.slice(0, -3).replace(/-/g, "")}.co.uk`;
  return `${slug.replace(/-/g, "")}.co.uk`;
}

function cleanStoreName(slug) {
  return slug
    .replace(/-(com|co-uk|uk)$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/*
 * Sections after the live offers list. Everything from the first of these
 * onwards is dropped:
 *
 *  - "That You've Missed" holds codes Coupert has marked expired or invalid.
 *  - "Alternatives" lists OTHER retailers' codes (Eneba, K4G...). Attributing
 *    those to the current store would put working codes on the wrong shop —
 *    the old button-scraping approach did exactly that.
 */
const CUTOFF_PATTERNS = [
  /^#+\s*.*That You've Missed/im,
  /^#+\s*.*Alternatives/im,
  /^#+\s*How to use/im,
  /^#+\s*When does/im,
  /^#+\s*Submit /im,
  /^#+\s*Frequently Asked/im,
  /^#+\s*How We /im,
];

/** Trim the markdown to just the live offer list. */
export function trimToOffers(markdown) {
  let end = markdown.length;
  for (const re of CUTOFF_PATTERNS) {
    const m = re.exec(markdown);
    if (m && m.index < end) end = m.index;
  }
  return markdown.slice(0, end);
}

/**
 * Parse codes out of a Coupert page's markdown.
 *
 * Each offer renders as a discount block, an `### description` heading, then
 * "Get Code" followed by the code on its own line. Deals use "Get Deal" and
 * carry no code, so they're skipped.
 */
export function parseCoupertMarkdown(markdown) {
  const body = trimToOffers(markdown);
  const lines = body.split("\n").map((l) => l.trim());
  const offers = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (!/^Get Code$/i.test(lines[i])) continue;

    // The code is the next non-empty, non-image line.
    let code = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const line = lines[j];
      if (!line || line.startsWith("![") || /^!\[/.test(line)) continue;
      code = line.replace(/\\/g, "").trim(); // markdown escapes e.g. Eagle\_15
      break;
    }
    if (!code || !isValidCode(code) || seen.has(code.toUpperCase())) continue;

    // Offers run together in the markdown, so a backward scan must stop at the
    // previous offer's "Get Code"/"Get Deal" or it picks up that offer's
    // heading and discount.
    let blockStart = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (/^Get (Code|Deal)\b/i.test(lines[j])) { blockStart = j + 1; break; }
    }

    // Nearest preceding "### ..." heading is the offer description.
    let description = "";
    for (let j = i - 1; j >= blockStart; j--) {
      const m = /^#{2,4}\s+(.*)$/.exec(lines[j]);
      if (m) {
        description = m[1].trim();
        break;
      }
    }

    // Discount sits a few lines above as "15%" then "OFF", with blank lines
    // between them, so look at the next non-empty line rather than j+1.
    let value = null;
    let type = "unknown";
    for (let j = i - 1; j >= blockStart; j--) {
      const pct = /^(\d{1,2}(?:\.\d)?)%$/.exec(lines[j]);
      if (!pct) continue;
      let next = "";
      for (let k = j + 1; k < lines.length && k <= j + 3; k++) {
        if (lines[k]) { next = lines[k]; break; }
      }
      if (/^OFF$/i.test(next)) {
        value = parseFloat(pct[1]);
        type = "percentage";
        break;
      }
    }

    if (type === "unknown") {
      type = guessType(description);
      // "Enjoy a Special 5% Discount..." — the normalizer's extractValue only
      // matches "N% off", so pull the number here while we have the context.
      const inline = /(\d{1,2}(?:\.\d)?)\s*%/.exec(description);
      if (inline && type === "percentage") value = parseFloat(inline[1]);
    }

    seen.add(code.toUpperCase());
    offers.push({ code, description, type, value });
  }

  return offers;
}

async function fetchPage(url, apiKey) {
  const res = await fetch(FIRECRAWL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, waitFor: 2500 }),
  });
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const json = await res.json();
  const markdown = json?.data?.markdown;
  if (!markdown) throw new Error("Firecrawl returned no markdown");
  return markdown;
}

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    // Not fatal: the other ten sources should still run.
    const msg = "FIRECRAWL_API_KEY not set — skipping (Coupert needs it to get past Cloudflare)";
    console.log(`[Coupert] ${msg}`);
    return { entries, duration: Date.now() - start, errors: [msg] };
  }

  const storeList = stores || STORES;
  console.log(`[Coupert] Scraping ${storeList.length} stores via Firecrawl…`);

  for (const slug of storeList) {
    const url = `${BASE_URL}/${slug}`;
    try {
      const markdown = await fetchPage(url, apiKey);
      const offers = parseCoupertMarkdown(markdown);
      const storeDomain = slugToDomain(slug);
      const storeName = cleanStoreName(slug);

      for (const offer of offers) {
        entries.push({
          code: offer.code,
          storeName,
          storeDomain,
          description: offer.description,
          type: offer.type,
          value: offer.value,
          source: "coupert",
          url,
        });
      }
      console.log(`[Coupert] ${slug}: ${offers.length} codes -> ${storeDomain}`);
    } catch (err) {
      errors.push(`${slug}: ${err.message}`);
      console.log(`[Coupert] ${slug}: ${err.message}`);
    }

    // Be polite to the API.
    await new Promise((r) => setTimeout(r, 1200));
  }

  const duration = Date.now() - start;
  console.log(`[Coupert] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
