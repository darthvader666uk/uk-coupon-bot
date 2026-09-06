/**
 * GG.deals voucher scraper (headful Playwright)
 *
 * Was a two-step affair: a Firecrawl pre-fetch wrote markdown into
 * cache/ggdeals/, and this file parsed those files. The Firecrawl key died,
 * the pre-fetch failed silently, and the scraper carried on serving the cache
 * — frozen since 2026-07-13 — while refreshing each code's lastSeen, so
 * long-dead codes kept looking current.
 *
 * Now scrapes the live pages directly. gg.deals is fine with a headful
 * browser (the same one Coupert needs), so there is no cache and no API key.
 */
import { launchHeadfulBrowser } from "../lib/playwright-base.js";

const BASE_URL = "https://gg.deals/vouchers/";
const TOTAL_PAGES = 5;

const GAMING_STORES = {
  "Driffle": "driffle.com",
  "Player.land": "player.land",
  "GamersGate": "gamersgate.com",
  "K4G.com": "k4g.com",
  "K4G": "k4g.com",
  "G2Play": "g2play.com",
  "Kinguin": "kinguin.net",
  "Planetplay": "planetplay.com",
  "Green Man Gaming": "greenmangaming.com",
  "G2A": "g2a.com",
  "G2A UK": "g2a.com",
  "Ubisoft Store": "store.ubisoft.com",
  "Yuplay": "yuplay.com",
  "Gamebillet": "gamebillet.com",
  "WinGameStore": "wingamestore.com",
  "Fanatical": "fanatical.com",
  "Gamesplanet UK": "gamesplanet.com",
  "Gamesplanet US": "gamesplanet.com",
  "Gamesplanet FR": "gamesplanet.com",
  "Gamesplanet DE": "gamesplanet.com",
  "Loaded": "loaded.com",
  "Loaded (formerly CDKeys)": "loaded.com",
  "GameBoost": "gameboost.com",
  "Difmark": "difmark.com",
  "HRKGame": "hrkgame.com",
  "LootBar": "lootbar.gg",
  "Eldorado.gg": "eldorado.gg",
  "GameSeal": "gameseal.com",
  "PremiumCDKeys": "premiumcdkeys.com",
  "Keycense": "keycense.com",
  "Playsum": "playsum.com",
  "JoyBuggy": "joybuggy.com",
  "Nuuvem": "nuuvem.com",
  "2Game": "2game.com",
  "Allyouplay": "allyouplay.com",
  "Epic Games Store": "epicgames.com",
  "GOG": "gog.com",
  "Humble Store": "humblebundle.com",
  "Steam": "store.steampowered.com",
  "EA.com Origin": "ea.com",
  "EA Origin": "ea.com",
  "Ubisoft": "store.ubisoft.com",
  "GAMIVO": "gamivo.com",
  "GameStop": "gamestop.com",
  "Play-Asia": "play-asia.com",
};

/**
 * Runs inside the page. Each voucher renders as a `.voucher-item` card:
 *   .voucher-image img[alt]      -> store name
 *   .voucher-code .code (leaf)   -> the code itself; the wrapper's text is
 *                                   "CODEcopy" because of the copy button, so
 *                                   take the childless element
 *   .title (first)               -> the offer description
 */
export function collectVouchers() {
  return Array.from(document.querySelectorAll(".voucher-item"))
    .map((card) => {
      const codeEl = Array.from(card.querySelectorAll(".code")).find((e) => e.children.length === 0);
      const code = codeEl?.textContent?.trim() || "";
      if (!code) return null;
      const img = card.querySelector(".voucher-image img");
      const storeName = (img?.getAttribute("alt") || img?.getAttribute("title") || "").trim();
      const title = card.querySelector(".title")?.textContent?.trim() || "";
      return { code, storeName, title };
    })
    .filter(Boolean);
}

export async function scrape() {
  const start = Date.now();
  const entries = [];
  const errors = [];

  let browser;
  try {
    browser = await launchHeadfulBrowser();
  } catch (err) {
    const msg = `could not launch browser: ${err.message}`;
    console.log(`[GGdeals] ${msg}`);
    return { entries, duration: Date.now() - start, errors: [msg] };
  }

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-GB",
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  console.log(`[GGdeals] Scraping ${TOTAL_PAGES} pages…`);

  for (let pageNum = 1; pageNum <= TOTAL_PAGES; pageNum++) {
    const url = pageNum === 1 ? BASE_URL : `${BASE_URL}?page=${pageNum}`;
    let page;
    try {
      page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector(".voucher-item", { timeout: 20000 });

      const vouchers = await page.evaluate(collectVouchers);
      for (const v of vouchers) {
        const domain = GAMING_STORES[v.storeName] || guessDomain(v.storeName);
        entries.push({
          code: v.code,
          storeName: v.storeName,
          storeDomain: domain,
          description: `${v.title} — ${v.storeName}`.substring(0, 200),
          type: guessType(v.title),
          source: "ggdeals",
          url,
        });
      }
      console.log(`[GGdeals] page ${pageNum}: ${vouchers.length} codes`);
    } catch (err) {
      const reason = err.message.split("\n")[0];
      errors.push(`page ${pageNum}: ${reason}`);
      console.log(`[GGdeals] page ${pageNum}: ${reason}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  // The same code can appear on more than one page as the list shifts.
  const seen = new Set();
  const unique = entries.filter((c) => {
    const key = `${c.code}::${c.storeDomain}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const duration = Date.now() - start;
  console.log(`[GGdeals] Found ${unique.length} unique codes (${errors.length} errors) in ${duration}ms`);
  return { entries: unique, duration, errors };
}

function guessDomain(storeName) {
  if (!storeName || storeName === "Unknown") return "unknown.com";
  const slug = storeName.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "").trim();
  return `${slug}.com`;
}

function guessType(desc) {
  const lower = (desc || "").toLowerCase();
  if (lower.match(/\d+%\s*off/)) return "percentage";
  if (lower.match(/£\d+/)) return "fixed";
  if (lower.match(/free\s+(delivery|shipping)/)) return "free_shipping";
  if (lower.match(/extra\s+discount/)) return "extra_discount";
  return "unknown";
}
