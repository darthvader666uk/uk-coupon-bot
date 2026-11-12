/**
 * HotUKDeals voucher pages (plain HTTP, no browser)
 *
 * hotukdeals.com/vouchers/<shop> shows codes behind "See Code", but the page
 * is server-rendered Next.js and its flight data already carries every offer
 * in full: the code, its end time, and a verification history (users and
 * HUKD's own extension marking it working, with timestamps). The 2026-09
 * survey only looked for codes in visible HTML, which is why it missed this.
 *
 * One request per shop, ~260 KB gzipped. The shop list is the voucher
 * sitemap (~2,200 pages), which robots.txt allows, rotated a slice a run.
 *
 * Target: https://www.hotukdeals.com/vouchers/{slug}
 */
import { isValidCode, guessType, delay } from "../lib/playwright-base.js";
import { canonicalDomain, displayName } from "../lib/stores.js";
import { selectSlice } from "./savoo.js";

const BASE_URL = "https://www.hotukdeals.com/vouchers";
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
export const STORES_PER_RUN = 750;
const REQUEST_GAP_MS = 1500;
const RUN_DEADLINE_MS = 38 * 60 * 1000;
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5;

/**
 * Slugs that are not a domain. Only the ones whose shop is certain; the rest
 * of the twenty are guides, campaigns or shops with no obvious UK domain.
 */
const SLUG_DOMAINS = {
  "aa-breakdown-cover": "theaa.com",
  "amazon-uk": "amazon.co.uk",
  "argos": "argos.co.uk",
  "bt-british-telecom": "bt.com",
  "george-asda": "george.com",
  "reolink": "reolink.com",
  "sky-digital": "sky.com",
  "ugreen": "ugreen.com",
  "vodafone-broadband": "vodafone.co.uk",
};

/** The shop domain for a voucher-page slug, or null when it isn't a shop. */
export function slugDomain(slug) {
  if (SLUG_DOMAINS[slug]) return SLUG_DOMAINS[slug];
  return slug.includes(".") && !slug.includes("/") ? canonicalDomain(slug) : null;
}

/**
 * The JSON object starting at `start` (a "{"), honouring strings so a brace
 * inside a title doesn't end it early. null when it never closes.
 */
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Every live voucher on the page that belongs to this shop. The listing sits
 * in the flight data as "RlpListing2Offers", ahead of the expired list and
 * the sidebars (other shops' offers), so only that block is read, and each
 * offer's own retailer must point back at this slug.
 */
export function extractVouchers(html, slug) {
  // Flight data is a JS string: its quotes arrive escaped.
  const text = html.replace(/\\"/g, '"');
  const from = text.indexOf('"RlpListing2Offers"');
  if (from < 0) return [];
  const next = text.indexOf('"Rlp', from + 20);
  const block = text.slice(from, next > 0 ? next : undefined);

  const out = [];
  const seen = new Set();
  const marker = '"voucher":{';
  for (let at = block.indexOf(marker); at >= 0; at = block.indexOf(marker, at + 1)) {
    const raw = objectAt(block, at + marker.length - 1);
    if (!raw) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!v.code || seen.has(v.idPool)) continue;
    if (v.retailer?.landingPage?.url && v.retailer.landingPage.url !== slug) continue;
    seen.add(v.idPool);
    out.push(v);
  }
  return out;
}

/** Map one HUKD voucher onto the entry shape mergeCodes expects. */
export function toEntry(v, storeDomain, slug, now = Date.now()) {
  if (!isValidCode(v.code)) return null;
  if (v.endTime && Date.parse(v.endTime) < now) return null;
  const description = String(v.title || "").trim();
  const entry = {
    code: v.code.trim(),
    storeName: displayName(storeDomain, v.retailer?.name),
    storeDomain,
    description,
    type: guessType(`${description} ${v.caption1 || ""} ${v.caption2 || ""}`),
    value: null,
    expiry: v.endTime || null,
    source: "hukd",
    url: `${BASE_URL}/${slug}`,
  };
  // Marked working by a user or HUKD's extension: the same signal as
  // Caramel's lastWorkedAt, so it gets the same treatment.
  const check = v.voucherVerificationLiveHistory;
  if (check?.status === "verified" && check.verifiedAt) {
    entry.verified = true;
    entry.lastWorkedAt = check.verifiedAt;
  }
  return entry;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-GB" } });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Shop slugs from the voucher sitemap, leaving out campaigns and guides. */
async function discoverSlugs() {
  const xml = await fetchText(SITEMAP_URL);
  if (!xml) throw new Error("no voucher sitemap");
  const slugs = [...xml.matchAll(/<loc>https:\/\/www\.hotukdeals\.com\/vouchers\/([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((s) => slugDomain(s));
  return [...new Set(slugs)].sort();
}

export async function scrape(slugs = null) {
  const start = Date.now();
  const entries = [];
  // Stores whose page loaded, codes or not (see markListed).
  const checked = [];
  const errors = [];

  let storeList = slugs;
  if (!storeList) {
    try {
      const all = await discoverSlugs();
      console.log(`[HUKD] Sitemap lists ${all.length} shops`);
      storeList = selectSlice(all, STORES_PER_RUN);
    } catch (err) {
      const msg = `sitemap unavailable: ${err.message}`;
      console.log(`[HUKD] ${msg}`);
      return { entries, checked, duration: Date.now() - start, errors: [msg] };
    }
  }

  console.log(`[HUKD] Fetching ${storeList.length} shops…`);
  let anySuccess = false;
  let consecutiveFailures = 0;
  for (const [i, slug] of storeList.entries()) {
    if (Date.now() - start > RUN_DEADLINE_MS) {
      console.log(`[HUKD] Deadline reached — stopping with ${storeList.length - i} shops unvisited`);
      break;
    }
    const domain = slugDomain(slug);
    try {
      const html = await fetchText(`${BASE_URL}/${slug}`);
      anySuccess = true;
      consecutiveFailures = 0;
      if (!html) continue;
      checked.push(domain);
      const found = extractVouchers(html, slug).map((v) => toEntry(v, domain, slug)).filter(Boolean);
      entries.push(...found);
      if (found.length) console.log(`[HUKD] ${slug}: ${found.length} codes -> ${domain}`);
    } catch (err) {
      consecutiveFailures++;
      const reason = err.message.split("\n")[0];
      errors.push(`${slug}: ${reason}`);
      console.log(`[HUKD] ${slug}: ${reason}`);
      if (!anySuccess && consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        const msg = `blocked after ${consecutiveFailures} consecutive failures`;
        console.log(`[HUKD] ${msg}`);
        errors.push(msg);
        break;
      }
    } finally {
      await delay(REQUEST_GAP_MS);
    }
  }

  const duration = Date.now() - start;
  console.log(`[HUKD] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, checked, duration, errors };
}
