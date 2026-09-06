/**
 * Playwright Base Scraper
 * Shared browser logic for scraping JavaScript-heavy voucher sites.
 * Each source extends this with its own URL patterns and code extraction.
 */
import { chromium } from "playwright";
import { readdirSync, existsSync } from "fs";
import { join } from "path";

const BROWSER_OPTS = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
};

const CONTEXT_OPTS = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "en-GB",
  viewport: { width: 1280, height: 720 },
};

/**
 * Find a chromium build already on disk.
 *
 * Playwright insists on a browser build matching its own version. Bumping the
 * package without re-running `playwright install` leaves every scraper dead
 * locally with "Executable doesn't exist", even though an older, perfectly
 * usable chromium is sitting in the cache. CI installs the matching build, so
 * this only ever kicks in for local development.
 */
function findCachedChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"))
    || (process.env.HOME && join(process.env.HOME, ".cache", "ms-playwright"));
  if (!root || !existsSync(root)) return null;

  const candidates = readdirSync(root)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse()
    .flatMap((d) => [
      join(root, d, "chrome-win64", "chrome.exe"),
      join(root, d, "chrome-win", "chrome.exe"),
      join(root, d, "chrome-linux", "chrome"),
      join(root, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
    ]);
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * Launch a shared browser instance for batch scraping.
 * Call browser.close() when done.
 */
/**
 * Launch a *headful* browser.
 *
 * Cloudflare-protected sites (Coupert, GG.deals) detect headless Chrome and
 * serve "Just a moment..." forever. Measured against uk.coupert.com:
 *
 *   headless (default)  -> challenged
 *   headless=new        -> challenged
 *   headful             -> loads normally
 *
 * CI has no display, so the workflow wraps these jobs in `xvfb-run`.
 */
export async function launchHeadfulBrowser() {
  const opts = {
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // Removes navigator.webdriver, the first thing bot checks look at.
      "--disable-blink-features=AutomationControlled",
    ],
  };
  try {
    return await chromium.launch(opts);
  } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    const executablePath = findCachedChromium();
    if (!executablePath) throw err;
    console.log(`[Playwright] Version mismatch — using cached chromium: ${executablePath}`);
    return chromium.launch({ ...opts, executablePath });
  }
}

export async function launchBrowser() {
  try {
    return await chromium.launch(BROWSER_OPTS);
  } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    const executablePath = findCachedChromium();
    if (!executablePath) throw err;
    console.log(`[Playwright] Version mismatch — using cached chromium: ${executablePath}`);
    return chromium.launch({ ...BROWSER_OPTS, executablePath });
  }
}

/**
 * Create a new page with standard settings.
 */
export async function newPage(browser) {
  const context = await browser.newContext(CONTEXT_OPTS);
  const page = await context.newPage();
  // Block images/media to speed up loading
  await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3,woff,woff2}", (route) => route.abort());
  return { context, page };
}

/**
 * Navigate to a URL and wait for the page to settle.
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {object} opts - { waitForSelector, timeout }
 */
export async function gotoAndWait(page, url, opts = {}) {
  const { waitForSelector, timeout = 15000 } = opts;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    // Wait for additional content to load
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => {});
    }
    // Extra settle time for AJAX
    await page.waitForTimeout(2000);
  } catch (err) {
    // Timeout is OK — we still want to extract what we can
    if (!err.message.includes("Timeout")) {
      throw err;
    }
  }
}

/**
 * Extract codes from a page using the provided selector and extraction function.
 * @param {import('playwright').Page} page
 * @param {string} selector - CSS selector for code containers
 * @param {Function} extractFn - (element) => { code, description }
 */
export async function extractCodes(page, selector, extractFn) {
  const codes = [];
  try {
    const elements = await page.$$(selector);
    for (const el of elements) {
      const result = await extractFn(el);
      if (result && result.code) {
        codes.push(result);
      }
    }
  } catch (err) {
    // Extraction errors are non-fatal
  }
  return codes;
}

/**
 * Extract text content from an element.
 */
export async function getElementText(el, selector) {
  try {
    const child = selector ? await el.$(selector) : el;
    if (!child) return "";
    return (await child.textContent()) || "";
  } catch {
    return "";
  }
}

/**
 * Extract attribute value from an element.
 */
export async function getElementAttr(el, attr) {
  try {
    return (await el.getAttribute(attr)) || "";
  } catch {
    return "";
  }
}

/**
 * Close a context (page + cookies).
 */
export async function closeContext(context) {
  try {
    await context.close();
  } catch {}
}

/**
 * Common code validation — rejects obvious non-codes.
 */
export function isValidCode(code) {
  if (!code || typeof code !== "string") return false;
  const trimmed = code.trim();
  if (trimmed.length < 3 || trimmed.length > 30) return false;
  // Must contain at least one letter
  if (!/[A-Z]/i.test(trimmed)) return false;
  // Must contain a digit or be 6+ all-caps
  const hasDigit = /\d/.test(trimmed);
  const isLongCaps = trimmed.length >= 6 && trimmed === trimmed.toUpperCase();
  if (!hasDigit && !isLongCaps) return false;
  // Reject common non-code words
  if (COMMON_WORDS.has(trimmed.toUpperCase())) return false;
  // Reject pure years
  if (/^20\d{2}$/.test(trimmed)) return false;
  return true;
}

const COMMON_WORDS = new Set([
  "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HER",
  "WAS", "ONE", "OUR", "OUT", "HAS", "HIS", "HOW", "ITS", "MAY", "NEW",
  "NOW", "OLD", "SEE", "WAY", "WHO", "DID", "GET", "LET", "SAY", "SHE",
  "TOO", "USE", "CODE", "FREE", "DEAL", "OFFER", "SAVE", "VIEW", "COPY",
  "EXCLUSIVE", "VERIFIED", "TESTED", "TODAY", "VALID", "SPONSORED",
  "ARTICLES", "MORE", "LESS", "BACK", "NEXT", "HOME", "SHOP", "SALE",
]);

/**
 * Guess discount type from description text.
 */
export function guessType(desc) {
  const lower = (desc || "").toLowerCase();
  if (lower.match(/\d+%\s*off/)) return "percentage";
  if (lower.match(/£\d+/)) return "fixed";
  if (lower.match(/free\s+(delivery|shipping)/)) return "free_shipping";
  if (lower.match(/buy\s+\d+\s+get/)) return "bogo";
  return "unknown";
}

/**
 * Rate-limit delay.
 */
export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
