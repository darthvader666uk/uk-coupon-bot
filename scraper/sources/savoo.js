/**
 * Savoo.co.uk scraper (Playwright)
 *
 * Savoo shows ~18 offers per brand page but only puts two or three codes in
 * the HTML; the rest are revealed on the retailer's own site after an
 * affiliate redirect, which there is no honest way to capture. Clicking "Get
 * Code" changes nothing — a 16-minute test clicking every card returned zero
 * codes, while reading what is already there returns them in two seconds.
 *
 * The previous implementation regex-matched uppercase words out of anything
 * whose class contained "deal"/"offer"/"voucher". It never captured a real
 * code, harvesting navigation links and related-store cards instead: 7122
 * database entries of which none were genuine, with "PBDPMR" filed against
 * 2750 different stores.
 *
 * Target: https://www.savoo.co.uk/brands/{slug}
 */
import { launchBrowser, isValidCode, guessType } from "../lib/playwright-base.js";
import { belongsToStore } from "../lib/attribution.js";

const BASE_URL = "https://www.savoo.co.uk/brands";

export const POPULAR_STORES = [
  "amazon-discount-codes", "argos-discount-codes", "asos-discount-codes",
  "boohoo-discount-codes", "currys-discount-codes", "john-lewis-discount-codes",
  "next-discount-codes", "very-discount-codes", "tesco-discount-codes",
  "sainsburys-discount-codes", "morrisons-discount-codes", "marks-and-spencer-discount-codes",
  "new-look-discount-codes", "hm-discount-codes", "zara-discount-codes",
  "sports-direct-discount-codes", "nike-discount-codes", "adidas-discount-codes",
  "just-eat-discount-codes", "dominos-pizza-discount-codes",
  "deliveroo-discount-codes", "ebay-discount-codes", "shein-discount-codes",
  "dunelm-discount-codes", "wayfair-discount-codes", "wickes-discount-codes",
  "b-and-q-discount-codes", "boots-discount-codes", "superdrug-discount-codes",
  "lookfantastic-discount-codes", "myprotein-discount-codes", "halfords-discount-codes",
  "game-promo-codes", "tui-discount-codes", "debenhams-discount-codes",
  "samsung-discount-codes", "ao-com-discount-codes", "wowcher-discount-codes",
  "groupon-discount-codes", "expedia-discount-codes",
];

const DOMAIN_MAP = {
  "amazon": "amazon.co.uk", "argos": "argos.co.uk", "asos": "asos.co.uk",
  "boohoo": "boohoo.co.uk", "currys": "currys.co.uk", "john-lewis": "john-lewis.co.uk",
  "next": "next.co.uk", "very": "very.co.uk", "tesco": "tesco.co.uk",
  "sainsburys": "sainsburys.co.uk", "morrisons": "morrisons.co.uk",
  "marks-and-spencer": "marks-and-spencer.co.uk", "new-look": "new-look.co.uk",
  "hm": "hm.com", "zara": "zara.co.uk", "sports-direct": "sports-direct.co.uk",
  "nike": "nike.com", "adidas": "adidas.co.uk", "just-eat": "just-eat.co.uk",
  "dominos-pizza": "dominos.co.uk",
  "deliveroo": "deliveroo.co.uk", "ebay": "ebay.co.uk", "shein": "shein.co.uk",
  "dunelm": "dunelm.co.uk", "wayfair": "wayfair.co.uk", "wickes": "wickes.co.uk",
  "b-and-q": "diy.com", "boots": "boots.co.uk", "superdrug": "superdrug.co.uk",
  "lookfantastic": "lookfantastic.co.uk", "myprotein": "myprotein.co.uk",
  "halfords": "halfords.co.uk", "game": "game.co.uk", "tui": "tui.co.uk",
  "debenhams": "debenhams.com", "samsung": "samsung.co.uk", "ao-com": "ao.com",
  "wowcher": "wowcher.com", "groupon": "groupon.co.uk", "expedia": "expedia.co.uk",
};

function slugName(slug) {
  // Savoo uses all three suffixes. Missing -voucher-codes invented four
  // phantom stores that shadow real ones, e.g. a whole separate
  // "direct-fireplaces-voucher-codes.co.uk" alongside Direct Fireplaces.
  return slug.replace(/-(discount|promo|voucher)-codes$/, "");
}

export function extractDomain(slug) {
  const name = slugName(slug);
  if (DOMAIN_MAP[name]) return DOMAIN_MAP[name];
  // Some slugs already carry their TLD ("box.co.uk-discount-codes"), which
  // naively became "box.co.uk.co.uk".
  if (/\.(co\.uk|com|net|org|io|gg)$/.test(name)) return name;
  return `${name}.co.uk`;
}

export function cleanStoreName(slug) {
  return slugName(slug).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Offer cards whose code is actually present in the page.
 *
 * Savoo shows "Get Code" on ~18 offers per page but only puts two or three
 * codes in the HTML; the rest are revealed on the retailer's own site after
 * the affiliate redirect, which there is no honest way to capture. Clicking
 * changes nothing — the codes that are readable are readable before any click.
 */
export function collectCodeCards() {
  return Array.from(document.querySelectorAll(".module-deal"))
    .map((card) => {
      const code = card.querySelector(".code")?.textContent?.trim() || "";
      if (!code) return null;
      return {
        code,
        title: card.querySelector(".deal-title, h3, h2, [class*='title']")?.textContent?.trim() || "",
      };
    })
    .filter(Boolean);
}

const SITEMAP = "https://www.savoo.co.uk/sitemap_merchants_1.xml";

/**
 * How many brand pages to scrape per run. Savoo lists ~2720 and each takes
 * under a second, but the whole set would dominate the nightly job, so take a
 * rotating slice: the offset advances by day so every store is visited within
 * a few days rather than only ever the first N alphabetically.
 */
export const STORES_PER_RUN = 600;

/** Pull every brand slug from Savoo's merchant sitemap. */
export async function discoverStores() {
  try {
    const res = await fetch(SITEMAP, {
      headers: { Accept: "application/xml", "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const slugs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => /\/brands\/([^/?#]+)\/?$/.exec(m[1])?.[1])
      .filter((s) => s && s.length > 3 && /-(discount|promo|voucher)-codes?$/.test(s));
    if (!slugs.length) throw new Error("no brand slugs in sitemap");
    console.log(`[Savoo] Discovered ${slugs.length} brand pages`);
    return slugs;
  } catch (err) {
    console.log(`[Savoo] Sitemap discovery failed (${err.message}) — using ${POPULAR_STORES.length} known stores`);
    return POPULAR_STORES;
  }
}

/** Rotating slice so every store is covered over successive days. */
export function selectSlice(all, perRun = STORES_PER_RUN, day = Math.floor(Date.now() / 86400000)) {
  if (all.length <= perRun) return all;
  const start = (day * perRun) % all.length;
  const slice = all.slice(start, start + perRun);
  return slice.length < perRun ? slice.concat(all.slice(0, perRun - slice.length)) : slice;
}

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];
  const storeList = stores || selectSlice(await discoverStores());

  console.log(`[Savoo] Scraping ${storeList.length} stores…`);

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    const msg = `could not launch browser: ${err.message}`;
    console.log(`[Savoo] ${msg}`);
    return { entries, duration: Date.now() - start, errors: [msg] };
  }

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-GB",
    viewport: { width: 1280, height: 900 },
  });

  for (const slug of storeList) {
    const url = `${BASE_URL}/${slug}`;
    let page;
    try {
      page = await context.newPage();
      // Revealing a code opens the retailer in a new tab. Close popups as they
      // appear, or a 40-store run ends with hundreds of tabs. This must be
      // page.on("popup") rather than context.on("page"): the latter also fires
      // for newPage() and would close the page we are about to use.
      page.on("popup", (p) => p.close().catch(() => {}));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector(".module-deal", { timeout: 15000 });

      const cards = await page.evaluate(collectCodeCards);
      const storeDomain = extractDomain(slug);
      const storeName = cleanStoreName(slug);
      let found = 0;
      for (const card of cards) {
        if (!belongsToStore(card.title, slugName(slug), extractDomain(slug), storeName)) continue;
        if (!isValidCode(card.code)) continue;
        entries.push({
          code: card.code,
          storeName,
          storeDomain,
          description: card.title,
          type: guessType(card.title),
          source: "savoo",
          url,
        });
        found++;
      }

      console.log(`[Savoo] ${slug}: ${found} codes -> ${storeDomain}`);
    } catch (err) {
      const reason = err.message.split("\n")[0];
      errors.push(`${slug}: ${reason}`);
      console.log(`[Savoo] ${slug}: ${reason}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const duration = Date.now() - start;
  console.log(`[Savoo] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
