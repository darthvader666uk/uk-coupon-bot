/**
 * Coupert UK Scraper (headful Playwright)
 *
 * Coupert sits behind Cloudflare. Headless Chrome — old or new — is served
 * "Just a moment..." indefinitely, which is why the original Playwright
 * implementation silently returned nothing for months. A *headful* browser
 * loads the page normally, so the scrape runs under xvfb in CI.
 *
 * Firecrawl would also work, but the account's key is dead (HTTP 401 on every
 * request) and it costs a credit per page; a headful browser is free.
 *
 * Target: https://uk.coupert.com/promo-code/{slug}
 */
import { isValidCode, guessType, launchHeadfulBrowser } from "../lib/playwright-base.js";

const BASE_URL = "https://uk.coupert.com/promo-code";

/**
 * Stores to scrape, as Coupert URL slugs. Gaming key resellers first — they
 * rotate codes constantly and are the ones other sources cover worst.
 */
export const STORES = [
  // Verified live against uk.coupert.com. Plausible-looking slugs that simply
  // have no page there (g2a, gamivo, fanatical, boots, asos, samsung...) are
  // deliberately absent: each missing slug costs ~12s of page load per run.
  // Gaming key resellers first — they rotate codes fastest and are the ones
  // other sources cover worst.
  "driffle-com", "eneba-com", "k4g-com", "kinguin-net",
  "cdkeys-uk", "allkeyshop", "electronic-first",
  // UK retail
  "argos", "currys", "very", "next", "john-lewis",
  "nike", "dunelm", "wickes", "halfords",
  "just-eat", "deliveroo", "dominos-pizza", "tui",
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
  "just-eat": "just-eat.co.uk",
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
  "kinguin-net": "kinguin.net",
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
  if (slug.endsWith("-net")) return `${slug.slice(0, -4).replace(/-/g, "")}.net`;
  if (slug.endsWith("-gg")) return `${slug.slice(0, -3).replace(/-/g, "")}.gg`;
  if (slug.endsWith("-uk")) return `${slug.slice(0, -3).replace(/-/g, "")}.co.uk`;
  return `${slug.replace(/-/g, "")}.co.uk`;
}

function cleanStoreName(slug) {
  return slug
    .replace(/-(com|co-uk|uk|net|gg)$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}


/**
 * Extracted from each offer card in the page. Returned by the in-page
 * collector below and turned into database entries by normaliseOffers, which
 * is a pure function so it can be tested without a browser.
 *
 * @typedef {{code: string, title: string, percent: string|null, expired: boolean}} RawCard
 */

/**
 * Runs inside the page. Kept free of closures over Node scope so it can be
 * passed straight to page.evaluate().
 *
 * Cards under the "That You've Missed" heading are ones Coupert has marked
 * expired or invalid, so each card records which side of that heading it is
 * on. The "Alternatives" block at the foot of the page lists *other*
 * retailers' codes; those aren't .item-wrapper cards, so they never appear
 * here — worth knowing, because attributing them to this store would put
 * working codes on the wrong shop.
 */
export function collectCards() {
  const expiredHeading = Array.from(document.querySelectorAll("h2,h3"))
    .find((h) => /That You'?ve Missed/i.test(h.textContent || ""));

  return Array.from(document.querySelectorAll(".item-wrapper"))
    .map((card) => {
      const code = card.querySelector(".hiddenCode")?.textContent?.trim() || "";
      if (!code) return null; // a deal, not a code
      const title = card.querySelector(".coupon-title")?.textContent?.trim()
        || card.querySelector(".desc-text")?.textContent?.trim()
        || "";
      const percent = card.querySelector(".percent")?.textContent?.trim() || null;
      // DOCUMENT_POSITION_FOLLOWING (4) means the heading comes after the card,
      // i.e. the card is in the live section above it.
      const expired = expiredHeading
        ? !(card.compareDocumentPosition(expiredHeading) & 4)
        : false;
      return { code, title, percent, expired };
    })
    .filter(Boolean);
}

/**
 * Turn raw cards into database entries. Pure — no DOM, no network.
 *
 * @param {RawCard[]} cards
 * @param {{includeExpired?: boolean}} [options]
 */
export function normaliseOffers(cards, options = {}) {
  const { includeExpired = false } = options;
  const offers = [];
  const seen = new Set();

  for (const card of cards || []) {
    if (!card || !card.code) continue;
    if (card.expired && !includeExpired) continue;

    const code = String(card.code).trim();
    if (!isValidCode(code) || seen.has(code.toUpperCase())) continue;
    seen.add(code.toUpperCase());

    const description = (card.title || "").trim();
    let value = null;
    let type = "unknown";

    // The card's own discount badge, e.g. "10%".
    const badge = /^(\d{1,2}(?:\.\d+)?)\s*%$/.exec(card.percent || "");
    if (badge) {
      value = parseFloat(badge[1]);
      type = "percentage";
    } else {
      // No badge: fall back to the title. Coupert phrases these as "12%
      // Discount" or "10% Savings" as often as "10% off", and guessType only
      // recognises the last of those, so match the figure directly.
      const inline = /(\d{1,2}(?:\.\d+)?)\s*%/.exec(description);
      if (inline) {
        value = parseFloat(inline[1]);
        type = "percentage";
      } else {
        type = guessType(description);
      }
    }

    offers.push({ code, description, type, value, expired: !!card.expired });
  }

  return offers;
}

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];
  const storeList = stores || STORES;

  console.log(`[Coupert] Scraping ${storeList.length} stores (headful Playwright)…`);

  let browser;
  try {
    browser = await launchHeadfulBrowser();
  } catch (err) {
    const msg = `could not launch browser: ${err.message}`;
    console.log(`[Coupert] ${msg}`);
    return { entries, duration: Date.now() - start, errors: [msg] };
  }

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-GB",
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  /**
   * Cloudflare challenges the first request or two, then issues the context a
   * clearance cookie and lets the rest through. Failures are collected and
   * retried once at the end, by which point clearance is usually in hand.
   */
  const failed = [];

  async function scrapeStore(slug, isRetry) {
    const url = `${BASE_URL}/${slug}`;
    let page;
    try {
      page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

      // Wait for the offer list rather than a fixed delay: a Cloudflare
      // interstitial resolves into the real page after a few seconds.
      try {
        await page.waitForSelector(".item-wrapper", { timeout: 12000 });
      } catch {
        // No offer list. Either still challenged (retry is worth it) or the
        // slug simply has no codes / doesn't exist (retrying wastes 12s).
        const title = await page.title().catch(() => "");
        if (!/just a moment/i.test(title)) {
          console.log(`[Coupert] ${slug}: no offers on page — skipping`);
          return;
        }
        throw new Error("Cloudflare challenge");
      }

      const cards = await page.evaluate(collectCards);
      const offers = normaliseOffers(cards);
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
      const title = page ? await page.title().catch(() => "") : "";
      const reason = /just a moment/i.test(title) ? "Cloudflare challenge" : err.message.split("\n")[0];
      if (!isRetry) {
        failed.push(slug);
        console.log(`[Coupert] ${slug}: ${reason} — will retry`);
      } else {
        errors.push(`${slug}: ${reason}`);
        console.log(`[Coupert] ${slug}: ${reason} (retry failed)`);
      }
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  for (const slug of storeList) await scrapeStore(slug, false);

  if (failed.length) {
    console.log(`[Coupert] Retrying ${failed.length} store(s) now clearance is established…`);
    for (const slug of failed) await scrapeStore(slug, true);
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const duration = Date.now() - start;
  console.log(`[Coupert] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
