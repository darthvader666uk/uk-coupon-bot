import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache", "ggdeals");
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
 * Scrape GG.deals vouchers page via cache files.
 * Pre-fetch pages with: node scripts/fetch-ggdeals.js
 */
export async function scrape() {
  const start = Date.now();
  const entries = [];
  const errors = [];

  if (!existsSync(CACHE_DIR)) {
    errors.push("No cache directory. Run: node scripts/fetch-ggdeals.js");
    console.log("[GGdeals] No cache directory. Run fetch-ggdeals.js first.");
    return { entries, duration: Date.now() - start, errors };
  }

  console.log("[GGdeals] Reading cached pages…");

  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith(".md")).sort();
  for (const file of files) {
    const content = readFileSync(join(CACHE_DIR, file), "utf8");
    const pageCodes = parseMarkdown(content, `cache/ggdeals/${file}`);
    if (pageCodes.length > 0) {
      console.log(`[GGdeals] ${file}: ${pageCodes.length} codes`);
      entries.push(...pageCodes);
    }
  }

  const seen = new Set();
  const unique = entries.filter(c => {
    const key = `${c.code}::${c.storeDomain}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const duration = Date.now() - start;
  console.log(`[GGdeals] Found ${unique.length} unique codes (${unique.length !== entries.length ? entries.length + " raw, " : ""}${errors.length} err) in ${duration}ms`);
  return { entries: unique, duration, errors };
}

function parseMarkdown(markdown, source) {
  const entries = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const imgMatch = lines[i].match(/\[!\[(.+?)\]/);
    if (!imgMatch) continue;

    const storeName = imgMatch[1];

    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const codeMatch = lines[j].match(/^([A-Z0-9]{3,25})copy$/);
      if (!codeMatch) continue;

      const code = codeMatch[1];
      let description = "";

      for (let k = j - 1; k >= i; k--) {
        const cand = lines[k].trim();
        if (cand && !cand.startsWith("[") && !cand.startsWith("![")) {
          description = cand;
          break;
        }
      }

      const domain = GAMING_STORES[storeName] || guessDomain(storeName);
      entries.push({
        code,
        storeName,
        storeDomain: domain,
        description: `${description} — ${storeName}`.substring(0, 200),
        type: guessType(description),
        source: "ggdeals",
        url: source,
      });
      break;
    }
  }

  return entries;
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
