/**
 * Canonical store registry — the single source of truth for which domain a
 * code belongs to and what that store is called.
 *
 * Two problems this solves:
 *  1. Sources spell the same retailer differently, so codes end up split
 *     across `asos.co.uk` and `asos.com` and the browser side only ever finds
 *     half of them. ALIASES folds every spelling onto one canonical domain.
 *  2. Store names were being taken from scraped page titles, so the database
 *     ended up with names like "Sorry, that page doesn't exist". DISPLAY_NAMES
 *     pins a real name per canonical domain.
 *
 * JUNK_DOMAINS holds the domains that `guessDomain()` invented out of offer
 * text ("any train journey" -> anytrain.co.uk). Codes landing on these are
 * dropped rather than shown against a store that doesn't exist.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Domains repaired by probing, and the ones no probe could place.
 *
 * Savoo derives a store domain by appending .co.uk to its slug, so `alo-yoga`
 * became `alo-yoga.co.uk` when the shop is aloyoga.com. That silently broke
 * 41% of the database: the userscript looks up the hostname it is actually on
 * and never finds those keys, so the codes may as well not exist.
 *
 * Regenerate with scripts/verify-domains.mjs when a source starts inventing
 * new ones. Corrections fold into ALIASES, unreachable ones into JUNK_DOMAINS.
 */
const CORRECTIONS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "domain-corrections.json"), "utf8")
);

/**
 * Scrapers that still exist. A code whose every source has been retired can no
 * longer be re-confirmed by anything, so it is dropped rather than left to age
 * quietly in the database claiming a provenance the project no longer has.
 */
export const ACTIVE_SOURCES = new Set(["coupert", "ggdeals", "knoji", "savoo"]);

/** Alias domain -> canonical domain. */
export const ALIASES = {
  "asos.com": "asos.co.uk",
  "boohoo.com": "boohoo.co.uk",
  "boots.com": "boots.co.uk",
  // B&Q trades as diy.com and b-and-q.co.uk does not resolve at all, so
  // the canonical domain has to be the one a shopper is actually on.
  "b-and-q.co.uk": "diy.com",
  "dominos-pizza.co.uk": "dominos.co.uk",
  "dunelm.com": "dunelm.co.uk",
  "halfords.com": "halfords.co.uk",
  "johnlewis.com": "john-lewis.co.uk",
  "lookfantastic.com": "lookfantastic.co.uk",
  "marksandspencer.com": "marks-and-spencer.co.uk",
  "newlook.com": "new-look.co.uk",
  "ocado.com": "ocado.co.uk",
  "samsung.com": "samsung.co.uk",
  "superdrug.com": "superdrug.co.uk",
  "tesco.com": "tesco.co.uk",
  "zara.com": "zara.co.uk",
  ...CORRECTIONS.corrections,
};

/**
 * Extra hostnames that should resolve to a canonical store in the browser but
 * are never produced by the scrapers — checkout subdomains, regional variants
 * and the .com/.co.uk twin of a store we key on the other TLD.
 */
export const HOSTNAME_ALIASES = {
  "amazon.com": "amazon.co.uk",
  "adidas.com": "adidas.co.uk",
  "argos.ie": "argos.co.uk",
  "checkout.asos.com": "asos.co.uk",
  "deliveroo.com": "deliveroo.co.uk",
  "ebay.com": "ebay.co.uk",
  "expedia.com": "expedia.co.uk",
  "groupon.com": "groupon.co.uk",
  "just-eat.com": "just-eat.co.uk",
  "justeat.co.uk": "just-eat.co.uk",
  "morrisons.com": "morrisons.co.uk",
  "myprotein.com": "myprotein.co.uk",
  "nike.co.uk": "nike.com",
  "sainsburys.com": "sainsburys.co.uk",
  "shein.com": "shein.co.uk",
  "sportsdirect.com": "sports-direct.co.uk",
  "wayfair.com": "wayfair.co.uk",
  "wickes.com": "wickes.co.uk",
  "store.playstation.com": "store.playstation.com",
};

/**
 * Stores that price globally, so a dollar or euro figure is genuine rather
 * than a US page scraped in error.
 *
 * Game-key resellers are the whole of this list: they sell the same regionless
 * key worldwide and quote USD or EUR to a UK buyer as a matter of course. A
 * TLD test cannot stand in for this, because B&Q trades on diy.com and
 * Debenhams on debenhams.com while being unambiguously UK retailers.
 */
export const GLOBAL_STORES = new Set([
  "2game.com", "allkeyshop.com", "allyouplay.com", "cdkeys.com",
  "difmark.com", "discovergames.com", "dreamgame.com", "driffle.com",
  "ea.com", "eldorado.gg", "electronicfirst.com", "eneba.com",
  "epicgames.com", "fanatical.com", "g2a.com", "g2play.com",
  "gamebillet.com", "gameboost.com", "gamersgate.com", "gamerthor.com",
  "gameseal.com", "gamesplanet.com", "gamestop.com", "gamivo.com",
  "gog.com", "greenmangaming.com", "hrkgame.com", "humblebundle.com",
  "instant-gaming.com", "joybuggy.com", "k4g.com", "keycense.com",
  "kinguin.net", "loaded.com", "lootbar.gg", "nuuvem.com",
  "planetplay.com", "player.land", "playsum.com", "premiumcdkeys.com",
  "store.steampowered.com", "store.ubisoft.com", "wingamestore.com",
  "yuplay.com",
]);

/** Canonical domain -> human-readable store name. */
export const DISPLAY_NAMES = {
  "adidas.co.uk": "Adidas",
  "allyouplay.com": "AllYouPlay",
  "amazon.co.uk": "Amazon",
  "ao.com": "AO.com",
  "argos.co.uk": "Argos",
  "asos.co.uk": "ASOS",
  "boohoo.co.uk": "boohoo",
  "boots.co.uk": "Boots",
  "bulk.com": "Bulk",
  "currys.co.uk": "Currys",
  "debenhams.com": "Debenhams",
  "deliveroo.co.uk": "Deliveroo",
  "difmark.com": "Difmark",
  "diy.com": "B&Q",
  "dominos.co.uk": "Domino's Pizza",
  "dreamgame.com": "Dreamgame",
  "driffle.com": "Driffle",
  "dunelm.co.uk": "Dunelm",
  "easyjet.co.uk": "easyJet",
  "ebay.co.uk": "eBay",
  "electronicfirst.com": "Electronic First",
  "eneba.com": "Eneba",
  "expedia.co.uk": "Expedia",
  "fanatical.com": "Fanatical",
  "g2a.com": "G2A",
  "g2play.com": "G2Play",
  "game.co.uk": "GAME",
  "gameboost.com": "GameBoost",
  "gamersgate.com": "GamersGate",
  "gamerthor.com": "Gamerthor",
  "gameseal.com": "GameSeal",
  "gamesplanet.com": "Gamesplanet",
  "gamivo.com": "GAMIVO",
  "greenmangaming.com": "Green Man Gaming",
  "groupon.co.uk": "Groupon",
  "halfords.co.uk": "Halfords",
  "hrkgame.com": "HRK Game",
  "jet2holidays.co.uk": "Jet2holidays",
  "john-lewis.co.uk": "John Lewis",
  "just-eat.co.uk": "Just Eat",
  "k4g.com": "K4G",
  "keycense.com": "Keycense",
  "kinguin.net": "Kinguin",
  "ldshop.com": "LDShop",
  "lookfantastic.co.uk": "LOOKFANTASTIC",
  "lootbar.gg": "LootBar",
  "marks-and-spencer.co.uk": "Marks & Spencer",
  "morrisons.co.uk": "Morrisons",
  "myprotein.co.uk": "Myprotein",
  "new-look.co.uk": "New Look",
  "next.co.uk": "Next",
  "nike.com": "Nike",
  "ocado.co.uk": "Ocado",
  "planetplay.com": "PlanetPlay",
  "play-asia.com": "Play-Asia",
  "player.land": "Player.land",
  "playsum.com": "Playsum",
  "premier-inn.co.uk": "Premier Inn",
  "premiumcdkeys.com": "PremiumCDKeys",
  "primevideo.co.uk": "Prime Video",
  "ryanair.co.uk": "Ryanair",
  "sainsburys.co.uk": "Sainsbury's",
  "samsung.co.uk": "Samsung",
  "shein.co.uk": "SHEIN",
  "sports-direct.co.uk": "Sports Direct",
  "store.ubisoft.com": "Ubisoft Store",
  "superdrug.co.uk": "Superdrug",
  "tesco.co.uk": "Tesco",
  "travelodge.co.uk": "Travelodge",
  "tui.co.uk": "TUI",
  "very.co.uk": "Very",
  "wayfair.co.uk": "Wayfair",
  "wickes.co.uk": "Wickes",
  "wingamestore.com": "WinGameStore",
  "wowcher.com": "Wowcher",
  "yuplay.com": "Yuplay",
  "zara.co.uk": "Zara",
};

/**
 * Domains fabricated from offer text rather than a real store name. Codes on
 * these are unattributable, so they get dropped instead of displayed.
 */
export const JUNK_DOMAINS = new Set([
  "unknown.co.uk",
  "unknown.com",
  "unknown",
  "anytrain.co.uk",
  "etcwith.co.uk",
  "grocerieshealth.co.uk",
  "non.co.uk",
  "northwesternrailway.co.uk",
  "sainsburysasda.co.uk",
  "todayavailable.co.uk",
  // Invented by the retired HotUKDeals scraper out of offer text:
  // "Airport", "full price items", "Google Local Guides", "Lenses 65% Off".
  "airport.co.uk",
  "fullprice.co.uk",
  "fullprice.com",
  "googlelocal.co.uk",
  "lensesoff.co.uk",
  // Keys that fail DNS and that no candidate domain could be verified for.
  ...CORRECTIONS.unreachable,
]);

/** Strip `www.` and lowercase. */
export function normalizeHostname(hostname) {
  if (!hostname || typeof hostname !== "string") return "";
  return hostname.trim().toLowerCase().replace(/^www\./, "");
}

/**
 * Fold a domain onto its canonical form. Unknown domains are returned as-is
 * (normalized) so new stores still work before anyone adds them here.
 */
export function canonicalDomain(domain) {
  const d = normalizeHostname(domain);
  return ALIASES[d] || d;
}

/**
 * Resolve a live browser hostname to a canonical store domain, walking up the
 * subdomain chain so `checkout.currys.co.uk` finds `currys.co.uk`.
 * Returns null when nothing matches — there is deliberately no fuzzy fallback.
 */
export function resolveHostname(hostname, knownDomains) {
  const host = normalizeHostname(hostname);
  if (!host) return null;
  const known = knownDomains instanceof Set ? knownDomains : new Set(knownDomains || []);

  const candidates = [];
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    candidates.push(parts.slice(i).join("."));
  }

  for (const candidate of candidates) {
    const mapped = HOSTNAME_ALIASES[candidate] || ALIASES[candidate];
    if (mapped && known.has(mapped)) return mapped;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Best available display name for a canonical domain. */
export function displayName(domain, fallback) {
  const d = canonicalDomain(domain);
  return DISPLAY_NAMES[d] || fallback || d;
}

/**
 * True when a domain is fabricated junk and its codes should be discarded.
 *
 * Also catches malformed domains that `guessDomain()` builds out of offer text
 * — "instant-print..co.uk", "furn..co.uk". These can never match a real
 * hostname, and a domain with a stray dot or slash has no business being used
 * as a filename either.
 */
export function isJunkDomain(domain) {
  const d = normalizeHostname(domain);
  if (!d) return true;
  if (JUNK_DOMAINS.has(d)) return true;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(d)) return true;
  if (d.includes("..") || d.startsWith(".") || d.endsWith(".")) return true;
  if (!d.includes(".")) return true;
  return false;
}
