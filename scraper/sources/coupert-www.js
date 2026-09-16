/**
 * Coupert store pages on www.coupert.com (plain HTTP, no browser)
 *
 * uk.coupert.com sits behind Cloudflare and needs the headful self-hosted
 * runner (sources/coupert.js, 20 hand-picked slugs). www.coupert.com/store/
 * {domain} does not: it answers plain fetch, is allowed by robots.txt, sits in
 * their public sitemap and is keyed by real domain, so it can be asked about
 * every store in the index from GitHub's runners.
 *
 * The page embeds its data as `storeInfoEnc` in __NEXT_DATA__: JSON with every
 * printable character shifted by two, wrapping within ASCII 0x20..0x7E, behind
 * a one-character marker. Inside, three blocks matter:
 *
 *   coupon_info                 the listed offers; `code` is blank for deals
 *                               and for some merchants entirely
 *   page_data.save_amount       codes Coupert tested, with the date and the
 *                               amount saved — yesterday's date, typically
 *   page_data.outflow_save_amount  codes people last saved with, dated
 *
 * The dated blocks are the point: they map onto lastWorkedAt, the "seen
 * working" field the panel trusts most, and here they are populated where
 * Caramel's were nearly empty. Big UK names (Argos, Very, Halfords, Amazon)
 * are 410 on www and stay with the headful scraper; the two are complementary.
 *
 * Target: https://www.coupert.com/store/{domain}
 */
import { isValidCode, guessType, delay } from "../lib/playwright-base.js";
import { displayName, canonicalDomain } from "../lib/stores.js";
import { loadStoreDomains, queryDomains } from "./caramel.js";

const STORE_URL = "https://www.coupert.com/store";
const SITEMAP_URL = "https://www.coupert.com/sitemap/stores.xml";
const REQUEST_GAP_MS = 400;
const FETCH_TIMEOUT_MS = 30000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Undo the printable-ASCII shift. Anything outside the range passes through. */
export function decodeStoreInfo(enc) {
  const text = [...enc.slice(1)].map((c) => {
    const n = c.charCodeAt(0);
    return n >= 0x20 && n <= 0x7e ? String.fromCharCode(0x20 + (n - 0x20 + 2) % 95) : c;
  }).join("");
  return JSON.parse(text);
}

/** "2026-09-1500:00:00" → "2026-09-15T00:00:00Z". Their dates have no separator. */
function isoDate(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(\d{2}:\d{2}:\d{2})?/.exec(s || "");
  return m ? `${m[1]}T${m[2] || "00:00:00"}Z` : null;
}

function typeFor(detail, off, title) {
  if (detail === "percent") return "percentage";
  if (detail === "money") return "fixed";
  if (detail === "free_shipping") return "free_shipping";
  return guessType(title);
}

/**
 * Entries for one store from its decoded blob. A code can appear in more than
 * one block; the listed offer supplies the description, the dated blocks the
 * most recent lastWorkedAt.
 */
export function extractEntries(info, storeDomain) {
  const byCode = new Map();
  const upsert = (code, fields) => {
    if (!isValidCode(code)) return;
    const key = code.trim().toUpperCase();
    const cur = byCode.get(key) || { code: code.trim(), storeName: displayName(storeDomain), storeDomain, description: "", type: "unknown", value: null, source: "coupert", url: `${STORE_URL}/${storeDomain}` };
    if (fields.description && !cur.description) cur.description = fields.description;
    if (fields.type && fields.type !== "unknown" && cur.type === "unknown") { cur.type = fields.type; cur.value = fields.value ?? null; }
    if (fields.lastWorkedAt && (!cur.lastWorkedAt || fields.lastWorkedAt > cur.lastWorkedAt)) { cur.lastWorkedAt = fields.lastWorkedAt; cur.verified = true; }
    if (fields.verified) cur.verified = true;
    byCode.set(key, cur);
  };

  for (const c of info.coupon_info || []) {
    if (!c.code) continue;
    const off = parseFloat(String(c.promotion_off || "").replace(/[^\d.]/g, ""));
    upsert(c.code, {
      description: c.title || c.description || "",
      type: typeFor(c.promotion_detail, c.promotion_off, c.title),
      value: Number.isFinite(off) && off > 0 ? off : null,
      lastWorkedAt: isoDate(c.last_saving_time),
      verified: c.verified_code === 1,
    });
  }
  const pd = info.store_info?.page_data || {};
  for (const t of pd.save_amount || []) {
    upsert(t.code, { description: t.savings_amount ? `Recently saved ${t.savings_amount}` : "", lastWorkedAt: isoDate(t.testing_time) });
  }
  for (const s of [...(pd.outflow_save_amount?.list || []), ...(pd.outflow_save_amount?.coupon_list || [])]) {
    upsert(s.code, { description: s.saving_amount ? `Recently saved ${s.saving_amount}` : "", lastWorkedAt: isoDate(s.saving_date) });
  }
  return [...byCode.values()];
}

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctl.signal });
    return { status: res.status, text: res.ok ? await res.text() : "" };
  } finally {
    clearTimeout(timer);
  }
}

/** The blob for one store page, or null when Coupert has no page for it. */
async function fetchStoreInfo(site) {
  const { status, text } = await fetchText(`${STORE_URL}/${site}`);
  if (status === 404 || status === 410) return null;
  if (status === 429) throw Object.assign(new Error("rate limited"), { rateLimited: true });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(text);
  const enc = m && JSON.parse(m[1])?.props?.pageProps?.storeInfoEnc;
  return enc ? decodeStoreInfo(enc) : null;
}

/** UK stores in Coupert's own sitemap: free discovery, one request. */
export async function sitemapUkStores() {
  try {
    const { status, text } = await fetchText(SITEMAP_URL);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return [...text.matchAll(/<loc>https:\/\/www\.coupert\.com\/store\/([^<]+\.co\.uk)<\/loc>/g)].map((m) => m[1]);
  } catch (err) {
    console.log(`[Coupert-www] sitemap unavailable (${err.message}) — index stores only`);
    return [];
  }
}

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];
  let storeList = stores;
  if (!storeList) {
    const known = loadStoreDomains();
    const fromSitemap = (await sitemapUkStores()).map(canonicalDomain).filter((d) => !known.includes(d));
    if (fromSitemap.length) console.log(`[Coupert-www] ${fromSitemap.length} UK store(s) from the sitemap not yet in the index`);
    storeList = [...new Set([...known, ...fromSitemap])];
  }

  console.log(`[Coupert-www] Querying ${storeList.length} stores…`);
  let hits = 0;
  for (const domain of storeList) {
    try {
      let info = null;
      for (const site of queryDomains(domain)) {
        info = await fetchStoreInfo(site);
        await delay(REQUEST_GAP_MS);
        if (info) break;
      }
      if (!info) continue;
      const found = extractEntries(info, domain);
      entries.push(...found);
      hits++;
      console.log(`[Coupert-www] ${domain}: ${found.length} codes (${found.filter((e) => e.lastWorkedAt).length} dated)`);
    } catch (err) {
      const reason = err.message.split("\n")[0];
      errors.push(`${domain}: ${reason}`);
      console.log(`[Coupert-www] ${domain}: ${reason}`);
      if (err.rateLimited) await delay(60000);
    }
  }

  const duration = Date.now() - start;
  console.log(`[Coupert-www] Found ${entries.length} codes across ${hits} stores (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
