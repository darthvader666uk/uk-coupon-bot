/**
 * Caramel coupon API (plain HTTP, no browser)
 *
 * Caramel (github.com/DevinoSolutions/caramel) is the maintained open-source
 * Honey alternative. Its catalogue is served by an unauthenticated JSON
 * endpoint keyed on registrable domain, with a 60s edge cache and a page cap
 * that exists so "scrapers can't walk the catalog indefinitely". Per-store
 * queries at a polite rate are the intended use, so that is all this does:
 * one query per store already in data/index.json, never a catalogue walk.
 *
 * Runs scraper-side rather than from the userscript so no store visit is ever
 * reported to a third party.
 *
 * Target: https://grabcaramel.com/api/coupons?site={domain}&limit=50&page=N
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { isValidCode, guessType, delay } from "../lib/playwright-base.js";
import { ALIASES, HOSTNAME_ALIASES, displayName } from "../lib/stores.js";

const API_URL = "https://grabcaramel.com/api/coupons";
const PAGE_SIZE = 50;
/** Argos has 66 codes; nothing seen needs more than two pages. */
const MAX_PAGES = 4;
const REQUEST_GAP_MS = 1000;
const INDEX_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "index.json");

/**
 * Caramel keys on the real domain, but several canonical keys here are
 * project-internal ("john-lewis.co.uk", "marks-and-spencer.co.uk") and the
 * real one lives in the alias tables. Try the canonical first and fall back
 * to every alias that folds onto it.
 */
export function queryDomains(domain) {
  const out = [domain];
  for (const table of [ALIASES, HOSTNAME_ALIASES]) {
    for (const [alias, canonical] of Object.entries(table)) {
      if (canonical === domain && alias !== domain && !out.includes(alias)) out.push(alias);
    }
  }
  return out;
}

/** Map one Caramel record onto the entry shape mergeCodes expects. */
export function normaliseCoupon(coupon, storeDomain) {
  const description = coupon.description || coupon.title || "";
  const kind = String(coupon.discount_type || "").toUpperCase();
  const amount = typeof coupon.discount_amount === "number" && coupon.discount_amount > 0
    ? coupon.discount_amount
    : null;
  let type = guessType(description);
  if (kind === "PERCENTAGE" || kind === "PERCENT") type = "percentage";
  else if (kind === "CASH" || kind === "FIXED") type = "fixed";
  // Caramel's own expiry is "-" or an ambiguous m/d vs d/m string, so it is
  // ignored and the normaliser's conservative text extraction is left to it.
  const entry = {
    code: coupon.code,
    storeName: displayName(storeDomain),
    storeDomain,
    description,
    type,
    value: (type === "percentage" || type === "fixed") ? amount : null,
    source: "caramel",
    url: `https://grabcaramel.com/coupons/${coupon.site || storeDomain}`,
  };
  // lastWorkedAt comes from Caramel's verification pipeline and extension
  // reports: the strongest "this code works" signal any source provides.
  // Only asserted when present so it never overwrites another source's tick.
  if (coupon.lastWorkedAt) {
    entry.lastWorkedAt = coupon.lastWorkedAt;
    entry.verified = true;
  }
  return entry;
}

async function fetchPage(site, page) {
  const url = `${API_URL}?site=${encodeURIComponent(site)}&limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "uk-coupon-bot (github.com/darthvader666uk/uk-coupon-bot)" },
  });
  if (res.status === 429) {
    const wait = Math.max(parseInt(res.headers.get("retry-after") || "30", 10), 5) * 1000;
    throw Object.assign(new Error(`rate limited, wait ${wait / 1000}s`), { wait });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Every coupon Caramel holds for one site, across pages. */
async function fetchSite(site) {
  const coupons = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await fetchPage(site, page);
    coupons.push(...(body.coupons || []));
    if (!body.hasMore) break;
    await delay(REQUEST_GAP_MS);
  }
  return coupons;
}

export function loadStoreDomains() {
  const index = JSON.parse(readFileSync(INDEX_JSON, "utf8"));
  return Object.keys(index.stores || {});
}

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];
  const storeList = stores || loadStoreDomains();

  console.log(`[Caramel] Querying ${storeList.length} stores…`);

  for (const domain of storeList) {
    try {
      let coupons = [];
      for (const site of queryDomains(domain)) {
        coupons = await fetchSite(site);
        await delay(REQUEST_GAP_MS);
        if (coupons.length) break;
      }
      if (!coupons.length) continue;

      const seen = new Set();
      let found = 0;
      for (const coupon of coupons) {
        if (coupon.expired || !isValidCode(coupon.code) || seen.has(coupon.code)) continue;
        seen.add(coupon.code);
        entries.push(normaliseCoupon(coupon, domain));
        found++;
      }
      console.log(`[Caramel] ${domain}: ${found} codes`);
    } catch (err) {
      const reason = err.message.split("\n")[0];
      errors.push(`${domain}: ${reason}`);
      console.log(`[Caramel] ${domain}: ${reason}`);
      if (err.wait) await delay(err.wait);
    }
  }

  const duration = Date.now() - start;
  console.log(`[Caramel] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
