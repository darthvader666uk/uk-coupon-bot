/**
 * UK Coupon Bot — Main Scraper
 * Orchestrates all sources, normalizes, deduplicates, and pushes to GitHub
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env if present
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      process.env[key] = val;
    }
  }
}

import { scrape as scrapeHotUKDeals } from "./sources/hotukdeals.js";
import { scrape as scrapeVoucherCodes } from "./sources/vouchercodes.js";
import { scrape as scrapeGGdeals } from "./sources/ggdeals.js";
import { mergeCodes, pruneStaleCodes, normalizeCode } from "./lib/normalizer.js";
import { logRun } from "./lib/logger.js";
import { readJSON, writeJSON } from "./lib/github.js";

const LOCAL_JSON = join(__dirname, "..", "data", "uk-coupons.json");

async function main() {
  const args = process.argv.slice(2);
  const sourceFlag = args.find((a) => a.startsWith("--source="))?.split("=")[1]
    || (args.includes("--source") ? args[args.indexOf("--source") + 1] : null);

  console.log("═══════════════════════════════════════════");
  console.log("  UK Coupon Bot — Scraper");
  console.log(`  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════");

  // Load existing database
  let database;
  try {
    if (process.env.GITHUB_TOKEN) {
      console.log("\n📦 Loading from GitHub repo…");
      const { json } = await readJSON();
      database = json;
    } else {
      console.log("\n📦 Loading from local file…");
      database = JSON.parse(readFileSync(LOCAL_JSON, "utf8"));
    }
  } catch (err) {
    console.log(`  ⚠ Could not load existing data: ${err.message}`);
    database = { meta: { lastUpdated: new Date().toISOString(), totalCodes: 0, version: "1.0", sources: [] }, stores: {} };
  }

  const allEntries = [];
  const errors = [];

  // Run scrapers
  const scrapers = [];
  if (!sourceFlag || sourceFlag === "hotukdeals") scrapers.push({ name: "hotukdeals", fn: scrapeHotUKDeals });
  if (!sourceFlag || sourceFlag === "vouchercodes") scrapers.push({ name: "vouchercodes", fn: scrapeVoucherCodes });
  if (!sourceFlag || sourceFlag === "ggdeals") scrapers.push({ name: "ggdeals", fn: scrapeGGdeals });

  for (const { name, fn } of scrapers) {
    try {
      console.log(`\n🔍 Scraping ${name}…`);
      const result = await fn();
      allEntries.push(...result.entries);
      logRun(name, { found: result.entries.length, duration: result.duration }, result.errors || []);
      if (result.errors?.length) errors.push(...result.errors.map((e) => `[${name}] ${e}`));
    } catch (err) {
      console.log(`  ❌ ${name} failed: ${err.message}`);
      logRun(name, { found: 0 }, [err.message]);
      errors.push(`[${name}] ${err.message}`);
    }
  }

  console.log(`\n📊 Total raw codes found: ${allEntries.length}`);

  // Merge into database
  const { stores, stats } = mergeCodes(database.stores, allEntries);
  console.log(`  ✅ Added: ${stats.added} | Updated: ${stats.updated}`);

  // Prune stale codes (>90 days old)
  const pruned = pruneStaleCodes(stores, 90);
  if (pruned.pruned > 0) {
    console.log(`  🗑 Pruned ${pruned.pruned} stale codes`);
  }

  // Update meta
  database.stores = pruned.stores;
  database.meta.lastUpdated = new Date().toISOString();
  database.meta.totalCodes = Object.values(database.stores).reduce((sum, s) => sum + s.codes.length, 0);

  console.log(`\n📈 Total codes in database: ${database.meta.totalCodes}`);

  // Save locally
  writeFileSync(LOCAL_JSON, JSON.stringify(database, null, 2));
  console.log(`💾 Saved to ${LOCAL_JSON}`);

  // Push to GitHub if token available
  if (process.env.GITHUB_TOKEN) {
    try {
      console.log("\n🚀 Pushing to GitHub…");
      const date = new Date().toISOString().split("T")[0];
      await writeJSON(database, `Auto-scrape ${date} — ${database.meta.totalCodes} codes`);
      console.log("  ✅ Pushed successfully");
    } catch (err) {
      console.log(`  ❌ Push failed: ${err.message}`);
      errors.push(`[github] ${err.message}`);
    }
  } else {
    console.log("\n⚠ No GITHUB_TOKEN — skipping push (dry run)");
  }

  // Summary
  console.log("\n═══════════════════════════════════════════");
  console.log("  Summary");
  console.log(`  Codes found:   ${allEntries.length}`);
  console.log(`  Added:         ${stats.added}`);
  console.log(`  Updated:       ${stats.updated}`);
  console.log(`  Pruned:        ${pruned.pruned}`);
  console.log(`  Total in DB:   ${database.meta.totalCodes}`);
  console.log(`  Errors:        ${errors.length}`);
  if (errors.length) {
    console.log("  Error details:");
    errors.forEach((e) => console.log(`    - ${e}`));
  }
  console.log("═══════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
