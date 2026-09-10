/**
 * Knoji scraper (headful Playwright)
 *
 * The densest source found: 30 codes for Currys against Savoo's 3, and unlike
 * every other aggregator surveyed it puts the code straight into a `data-code`
 * attribute rather than hiding it behind an affiliate redirect. Each card is
 * also marked "Verified", which is stored so the browser side can rank on it.
 *
 * Store pages are subdomains (currys.knoji.com). Knoji's sitemaps look like
 * the obvious index but are not trustworthy: they omit live pages (currys is
 * absent yet serves 30 codes) and list dead ones (argos is present but 410s),
 * so this derives the subdomain from each store we already track and probes
 * it, caching the misses.
 *
 * Target: https://{store}.knoji.com/
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { launchHeadfulBrowser, isValidCode, guessType } from "../lib/playwright-base.js";
import { belongsToStore } from "../lib/attribution.js";
import { DISPLAY_NAMES } from "../lib/stores.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/*
 * Committed, not in scraper/.cache/, which is gitignored. The matrix job that
 * scrapes Knoji is a different machine from the merge job that commits, so an
 * ignored cache never survived a CI run at all: every night started with an
 * empty cache, every store therefore counted as undiscovered, and discovery is
 * capped at a third of the run. Knoji had reached 52 stores out of 753 and was
 * never going to reach more.
 */
const CACHE_FILE = join(__dirname, "..", "..", "data", "knoji-probes.json");
/** How long to trust a "this store isn't on Knoji" result before retrying. */
const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Cap per run so this can't dominate the nightly job. */
export const STORES_PER_RUN = 120;

/**
 * Canonical domain -> Knoji subdomain, for the stores where stripping the
 * domain doesn't produce it. B&Q trades as diy.com but Knoji files it under
 * `bq`, so the derived `diy` 410s and the store looks absent from Knoji when
 * it in fact has more codes than any other source carries for it.
 */
export const SUBDOMAIN_OVERRIDES = {
  "diy.com": "bq",
};

/** Strip a store domain down to the bare name Knoji uses as a subdomain. */
export function storeKey(domain) {
  const override = SUBDOMAIN_OVERRIDES[(domain || "").toLowerCase().replace(/^www\./, "")];
  if (override) return override;
  return (domain || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.(co\.uk|com|net|org|io|gg|land)$/, "")
    .replace(/[^a-z0-9]/g, "");
}

/*
 * Knoji's sitemaps are not a reliable index: they omit live pages (currys is
 * absent yet currys.knoji.com serves 30 codes) and list dead ones (argos is
 * present but 410s). Probing the derived subdomain for each store we already
 * track is both more accurate and far cheaper than downloading 215,000 URLs.
 *
 * Results are cached so a store known not to be on Knoji isn't re-probed
 * every night.
 */
function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Store domains worth probing this run.
 *
 * The budget is split rather than filled first-come. Stores already known to
 * carry codes need refreshing, but if they took the whole run they would
 * eventually crowd out every store that has never been probed — with a ~45%
 * hit rate the known set grows until nothing new is ever tried. Reserving a
 * third for unprobed stores keeps discovery going.
 */
export function selectTargets(knownDomains, cache, perRun = STORES_PER_RUN, now = Date.now()) {
  const refresh = [];
  const discover = [];

  // A store only gets an override because someone confirmed its Knoji page by
  // hand, so probe it even when no source has filed a code against it yet.
  // Otherwise a store no other source covers can never be discovered here:
  // it isn't in the index, so it is never probed, so it never enters the index.
  const candidates = new Set([...knownDomains, ...Object.keys(SUBDOMAIN_OVERRIDES)]);
  const pinned = [];

  for (const domain of candidates) {
    const sub = storeKey(domain);
    // `bq` is a legitimate subdomain, so only guess-derived keys need the
    // minimum length that guards against junk like `hm` matching everything.
    if (!sub || (sub.length < 3 && !SUBDOMAIN_OVERRIDES[domain])) continue;
    const seen = cache[sub];
    // A store known not to be on Knoji costs one request a month, not one a night.
    if (seen?.miss && now - new Date(seen.at).getTime() < MISS_TTL_MS) continue;
    const target = { subdomain: sub, storeDomain: domain };
    // An override exists because someone confirmed the page by hand, so it
    // takes a slot rather than queueing behind 900 guesses for a third of the
    // run. B&Q sat unprobed for exactly that reason.
    if (SUBDOMAIN_OVERRIDES[domain]) pinned.push(target);
    else if (seen && !seen.miss) refresh.push(target);
    else discover.push(target);
  }

  const budget = Math.max(0, perRun - pinned.length);
  const discoverBudget = Math.max(1, Math.floor(budget / 3));
  const taken = discover.slice(0, discoverBudget);
  return [...pinned, ...refresh.slice(0, budget - taken.length), ...taken];
}

/**
 * Runs in the page. Codes live in `data-code`; the surrounding card says
 * whether Knoji has verified it and carries the offer description.
 */
export function collectCodes() {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("[data-code]")) {
    const code = el.getAttribute("data-code");
    // Some elements use data-code as a boolean flag rather than a value.
    if (!code || code === "true" || code === "false" || seen.has(code)) continue;
    seen.add(code);
    const card = el.closest("li,article,tr,div[class*='coupon'],div[class*='offer']");
    const text = (card?.innerText || "").replace(/\s+/g, " ");
    out.push({
      code,
      verified: /\bverified\b/i.test(text),
      description: (card?.querySelector("h2,h3,[class*='title']")?.textContent || "")
        .replace(/\s+/g, " ").trim().slice(0, 160),
      cardText: text.slice(0, 160),
    });
  }
  return out;
}

/** Pull a percentage or pound figure out of the card when there's no title. */
function describe(entry) {
  if (entry.description) return entry.description;
  const m = /(\d{1,2}(?:\.\d+)?)\s*%\s*off|£\s?(\d+(?:\.\d{2})?)\s*off/i.exec(entry.cardText);
  return m ? m[0] : "";
}

export async function scrape(stores = null) {
  const start = Date.now();
  const entries = [];
  const errors = [];

  let browser;
  try {
    browser = await launchHeadfulBrowser();
  } catch (err) {
    const msg = `could not launch browser: ${err.message}`;
    console.log(`[Knoji] ${msg}`);
    return { entries, duration: Date.now() - start, errors: [msg] };
  }

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-GB",
    viewport: { width: 1280, height: 1000 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const cache = loadCache();
  let targets = stores;
  if (!targets) {
    // Only visit Knoji pages for stores a UK source already found — Knoji is
    // mostly US retailers, and this project exists for UK ones.
    const indexPath = join(__dirname, "..", "..", "data", "index.json");
    let known = [];
    try {
      known = Object.keys(JSON.parse(readFileSync(indexPath, "utf8")).stores || {});
    } catch {
      console.log("[Knoji] No store index yet — nothing to enrich");
    }
    targets = selectTargets(known, cache);
    console.log(`[Knoji] ${known.length} known stores -> probing ${targets.length}`);
  }

  for (const { subdomain, storeDomain } of targets) {
    const url = `https://${subdomain}.knoji.com/`;
    let page;
    try {
      page = await context.newPage();
      page.on("popup", (p) => p.close().catch(() => {}));
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if ((res?.status() ?? 0) >= 400) {
        // 410 Gone is Knoji's answer for "no page for this store". Remember it
        // so the next month's runs don't spend a request rediscovering that.
        cache[subdomain] = { miss: true, at: new Date().toISOString(), status: res.status() };
        console.log(`[Knoji] ${subdomain}: HTTP ${res.status()} — not on Knoji`);
        continue;
      }
      await page.waitForTimeout(2500);

      const found = await page.evaluate(collectCodes);
      let kept = 0;
      for (const item of found) {
        if (!isValidCode(item.code)) continue;
        const description = describe(item);
        // Knoji shows a "similar coupons" block of other retailers' codes,
        // titled "... at Macy's". Filing those here is how a Kohl's code ended
        // up under Anastasia Beverly Hills.
        // The display name matters here: Knoji's subdomain can be too short
        // to match on (`bq`) and the domain can share no letters with the
        // retailer (`diy.com` vs "B&Q"), which would reject its own offers.
        if (!belongsToStore(description, subdomain, storeDomain, DISPLAY_NAMES[storeDomain])) continue;
        entries.push({
          code: item.code,
          storeName: storeDomain,
          storeDomain,
          description,
          type: guessType(description),
          source: "knoji",
          url,
          verified: item.verified,
        });
        kept++;
      }
      cache[subdomain] = { miss: kept === 0, at: new Date().toISOString(), codes: kept };
      console.log(`[Knoji] ${subdomain}: ${kept} codes -> ${storeDomain}`);
    } catch (err) {
      errors.push(`${subdomain}: ${err.message.split("\n")[0]}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  saveCache(cache);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const duration = Date.now() - start;
  console.log(`[Knoji] Found ${entries.length} codes (${errors.length} errors) in ${duration}ms`);
  return { entries, duration, errors };
}
