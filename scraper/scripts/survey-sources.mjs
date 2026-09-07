/**
 * Survey candidate voucher sites for scrapability.
 *
 * The lesson from the first eleven sources: most UK voucher sites never put
 * codes in their HTML — they are click-to-reveal so the affiliate link fires,
 * and the code only appears on the retailer's own site. Scraping those with a
 * text matcher harvests navigation links and brand names instead of codes,
 * which is how 67% of the database ended up fake.
 *
 * So every candidate gets probed before anyone writes a scraper. The signal
 * that matters is not "are there code-shaped strings on the page" (brand names
 * in a nav bar are code-shaped) but "are there code-shaped strings inside an
 * element that calls itself a code".
 *
 * Usage: node scripts/survey-sources.mjs [name-filter]
 */
import { launchHeadfulBrowser } from "../lib/playwright-base.js";

/**
 * Candidates, each pointed at the same well-known retailer where possible so
 * the results are comparable. A 404 is reported separately from "loaded but no
 * codes" — a guessed slug being wrong is not evidence about the site.
 */
/**
 * Listing/homepage URLs rather than a single store page. A site can behave
 * differently on the two, so anything rejected on a store page is retested
 * here before being written off.
 */
const LISTING_PAGES = [
  ["hukd-vouchers",   "https://www.hotukdeals.com/vouchers"],
  ["vouchercodes",    "https://www.vouchercodes.co.uk/"],
  ["myvouchercodes",  "https://www.myvouchercodes.co.uk/"],
  ["codeuk",          "https://exclusive.codeuk.net/"],
  ["moneysavingexpert","https://www.moneysavingexpert.com/deals/discount-voucher-codes/"],
  ["latestdeals",     "https://www.latestdeals.co.uk/vouchers"],
  ["groupon",         "https://www.groupon.co.uk/discount-codes"],
  ["codesuk",         "https://www.codes.co.uk/"],
  ["lovediscount",    "https://www.lovediscountvouchers.co.uk/"],
  ["wowcher",         "https://www.wowcher.co.uk/discountcodes"],
];

const CANDIDATES = [
  // Dedicated voucher aggregators
  ["vouchercloud",    "https://www.vouchercloud.com/currys"],
  ["picodi",          "https://www.picodi.com/uk/currys"],
  ["wethrift",        "https://www.wethrift.com/currys"],
  ["couponfollow",    "https://couponfollow.com/site/currys.co.uk"],
  ["knoji",           "https://currys.knoji.com/"],
  ["hotdeals",        "https://www.hotdeals.com/coupons/currys/"],
  ["couponbirds",     "https://www.couponbirds.com/codes/currys.co.uk"],
  ["retailmenot",     "https://www.retailmenot.com/view/currys.co.uk"],
  // Newspaper-run sections (several share one white-label platform, so if one
  // exposes codes the rest probably do too)
  ["dailymail",       "https://discountcode.dailymail.co.uk/currys"],
  ["independent",     "https://discountcodes.independent.co.uk/currys"],
  ["telegraph",       "https://discountcodes.telegraph.co.uk/currys"],
  ["mirror",          "https://discountcode.mirror.co.uk/currys"],
  ["express",         "https://discountcode.express.co.uk/currys"],
  ["thesun",          "https://vouchercodes.thesun.co.uk/currys"],
  ["standard",        "https://discountcodes.standard.co.uk/currys"],
  ["mumsnet",         "https://discountcodes.mumsnet.com/currys"],
  // Cashback sites that also list codes
  ["topcashback",     "https://www.topcashback.co.uk/currys/"],
  ["quidco",          "https://www.quidco.com/currys/"],
];

const CODE_TEXT = /^[A-Z0-9][A-Z0-9._-]{2,24}$/;

/**
 * Runs in the page. Splits code-shaped strings into those sitting inside an
 * element that calls itself a code (strong signal) and everything else
 * (usually nav links and brand names).
 */
function probe() {
  const leaves = Array.from(document.querySelectorAll("*"))
    .filter((e) => e.children.length === 0 && /^[A-Z0-9][A-Z0-9._-]{2,24}$/.test(e.textContent.trim()));

  const inCodeEl = [];
  const other = [];
  for (const e of leaves) {
    const cls = (e.className || "").toString();
    const selfOrParent = cls + " " + ((e.parentElement?.className || "").toString());
    const isNav = /nav|menu|breadcrumb|header|footer/i.test(selfOrParent);
    const looksCode = /(^|[^a-z])code|voucher|coupon|promo/i.test(selfOrParent);
    const item = `${e.textContent.trim()} [${cls.split(/\s+/)[0]?.slice(0, 22) || "?"}]`;
    if (looksCode && !isNav) inCodeEl.push(item);
    else other.push(item);
  }

  const dataAttr = Array.from(document.querySelectorAll("[data-code],[data-voucher],[data-coupon],[data-clipboard-text]")).length;
  return { inCodeEl, other, dataAttr };
}

const filter = process.argv[2];
const ALL = process.argv.includes("--listings") ? LISTING_PAGES : CANDIDATES;
const targets = filter && !filter.startsWith("--") ? ALL.filter(([n]) => n.includes(filter)) : ALL;

const browser = await launchHeadfulBrowser();
const verdicts = [];

for (const [name, url] of targets) {
  const ctx = await browser.newContext({ locale: "en-GB", viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  page.on("popup", (p) => p.close().catch(() => {}));
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    if (/just a moment|attention required/i.test(await page.title())) {
      await page.waitForFunction(() => !/just a moment|attention required/i.test(document.title), { timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(4000);

    const status = res?.status() ?? 0;
    const title = (await page.title()).slice(0, 46);
    const { inCodeEl, other, dataAttr } = await page.evaluate(probe);

    let verdict;
    if (status >= 400) verdict = `HTTP ${status}`;
    else if (inCodeEl.length || dataAttr) verdict = "CODES";
    else verdict = "none";

    verdicts.push({ name, verdict, inCode: inCodeEl.length, dataAttr, status });
    console.log(`\n${name.padEnd(14)} ${String(status).padEnd(4)} ${verdict.padEnd(8)} "${title}"`);
    if (inCodeEl.length) console.log(`   in code-ish elements: ${inCodeEl.slice(0, 6).join(", ")}`);
    if (dataAttr) console.log(`   data-code attributes: ${dataAttr}`);
    if (!inCodeEl.length && other.length) console.log(`   only nav/brand-like: ${other.slice(0, 4).join(", ")}`);
  } catch (err) {
    verdicts.push({ name, verdict: "ERROR", inCode: 0, dataAttr: 0 });
    console.log(`\n${name.padEnd(14)} ERROR ${err.message.split("\n")[0].slice(0, 60)}`);
  }
  await ctx.close().catch(() => {});
}

await browser.close();

console.log("\n\n=== SUMMARY ===");
for (const v of verdicts.sort((a, b) => (b.inCode + b.dataAttr) - (a.inCode + a.dataAttr))) {
  console.log(`  ${v.name.padEnd(15)} ${v.verdict.padEnd(9)} codeEls=${String(v.inCode).padStart(3)} dataAttrs=${v.dataAttr}`);
}
console.log("\nWorth writing a scraper for:",
  verdicts.filter((v) => v.verdict === "CODES").map((v) => v.name).join(", ") || "(none)");
