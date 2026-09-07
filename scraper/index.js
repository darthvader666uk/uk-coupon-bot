/**
 * UK Coupon Bot — Main Scraper
 * Orchestrates all sources, normalizes, deduplicates, and pushes to GitHub
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
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
import { scrape as scrapeGGdeals } from "./sources/ggdeals.js";
import { scrape as scrapeSavoo } from "./sources/savoo.js";
import { scrape as scrapeCoupert } from "./sources/coupert.js";
import { scrape as scrapeKnoji } from "./sources/knoji.js";
import { mergeCodes, pruneStaleCodes, pruneExpiredCodes, normalizeCode, removeCode, sanitizeStores } from "./lib/normalizer.js";
import { canonicalDomain } from "./lib/stores.js";
import { loadDeadCodes, saveDeadCodes, addDeadCode, isDeadCode, pruneDeadCodes, purgeDeadFromStores } from "./lib/deadcodes.js";
import { writeShards } from "./lib/shard.js";
import { logRun } from "./lib/logger.js";
import { readJSON, writeJSON, pushFiles, fetchFailedCodeIssues, closeIssue } from "./lib/github.js";

const DATA_DIR = join(__dirname, "..", "data");
const LOCAL_JSON = join(DATA_DIR, "uk-coupons.json");
const DEAD_CODES_JSON = join(DATA_DIR, "dead-codes.json");

async function main() {
  const args = process.argv.slice(2);
  const sourceFlag = args.find((a) => a.startsWith("--source="))?.split("=")[1]
    || (args.includes("--source") ? args[args.indexOf("--source") + 1] : null);

  // Sharded CI: each source runs as its own matrix job and writes only its raw
  // entries (--emit), then one job merges every artifact (--merge-dir) and
  // commits once. A slow or Cloudflare-blocked source then fails on its own
  // instead of taking the whole nightly run down with it.
  const emitFlag = args.find((a) => a.startsWith("--emit="))?.split("=")[1] || null;
  const mergeDirFlag = args.find((a) => a.startsWith("--merge-dir="))?.split("=")[1] || null;

  const removeFlag = args.find((a) => a.startsWith("--remove="))?.split("=")[1]
    || (args.includes("--remove") ? args[args.indexOf("--remove") + 1] : null);
  const removeStoreFlag = args.find((a) => a.startsWith("--store="))?.split("=")[1]
    || (args.includes("--store") ? args[args.indexOf("--store") + 1] : null);

  console.log("═══════════════════════════════════════════");
  console.log("  UK Coupon Bot — Scraper");
  console.log(`  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════");

  // Load existing database
  let database;
  // Deliberate rebuild: start empty so only what the current sources return
  // survives. Without it the run merges into the remote database and entries
  // from removed sources live on.
  const fresh = args.includes("--fresh");
  try {
    if (fresh) {
      console.log("\n🆕 --fresh: starting from an empty database");
      throw new Error("fresh start requested");
    }
    if (process.env.GITHUB_TOKEN) {
      console.log("\n📦 Loading from GitHub repo…");
      const { json } = await readJSON();
      database = json;
    } else {
      console.log("\n📦 Loading from local file…");
      database = JSON.parse(readFileSync(LOCAL_JSON, "utf8"));
    }
  } catch (err) {
    if (fresh) {
      database = { meta: { lastUpdated: new Date().toISOString(), totalCodes: 0, version: "2.0", sources: [] }, stores: {} };
    } else {
      console.log(`  ⚠ Could not load existing data: ${err.message}`);
      // Never start from an empty database while a populated local file exists
      // — the run would end by writing its handful of fresh codes over the lot.
      try {
        database = JSON.parse(readFileSync(LOCAL_JSON, "utf8"));
        const recovered = Object.values(database.stores || {}).reduce((n, s) => n + (s.codes?.length || 0), 0);
        console.log(`  ↩ Fell back to local file (${recovered} codes)`);
      } catch {
        database = { meta: { lastUpdated: new Date().toISOString(), totalCodes: 0, version: "1.0", sources: [] }, stores: {} };
      }
    }
  }

  if (!database || typeof database !== "object" || !database.stores) {
    database = { meta: { lastUpdated: new Date().toISOString(), totalCodes: 0, version: "1.0", sources: [] }, stores: {} };
  }
  database.meta = database.meta || { version: "1.0", sources: [] };
  const startingCodeCount = Object.values(database.stores).reduce((n, s) => n + (s.codes?.length || 0), 0);

  // Codes reported as broken. Without these the failed-code loop is pointless:
  // removing a code just means the next scrape adds it back.
  const deadCodes = loadDeadCodes(DEAD_CODES_JSON);
  const expiredTombstones = pruneDeadCodes(deadCodes);
  const deadCount = Object.keys(deadCodes.codes).length;
  if (deadCount || expiredTombstones) {
    console.log(`  \u{1F6AB} ${deadCount} dead code(s) on file${expiredTombstones ? `, ${expiredTombstones} tombstone(s) expired` : ""}`);
  }

  // Handle --remove: remove a code and exit without running scrapers
  if (removeFlag) {
    console.log(`\n🗑 Removing code "${removeFlag}"${removeStoreFlag ? ` from store "${removeStoreFlag}"` : ""}…`);
    const { removed, matchedDomains } = removeCode(database.stores, removeFlag, removeStoreFlag);
    // Tombstone it, or tomorrow's scrape puts it straight back.
    addDeadCode(deadCodes, removeFlag, removeStoreFlag || "*", "removed via --remove");
    saveDeadCodes(DEAD_CODES_JSON, deadCodes);
    database.meta.lastUpdated = new Date().toISOString();
    database.meta.totalCodes = Object.values(database.stores).reduce((sum, s) => sum + s.codes.length, 0);
    writeFileSync(LOCAL_JSON, JSON.stringify(database, null, 2));
    console.log(`  ✅ Removed: ${removed} code(s) from ${matchedDomains.length ? matchedDomains.join(", ") : "no stores"}`);
    console.log(`  📈 Total codes in database: ${database.meta.totalCodes}`);
    if (process.env.GITHUB_TOKEN) {
      try {
        console.log("\n🚀 Pushing to GitHub…");
        const domains = matchedDomains.length ? ` from ${matchedDomains.join(", ")}` : "";
        await writeJSON(database, `Remove code ${removeFlag}${domains}`);
        console.log("  ✅ Pushed successfully");
      } catch (err) {
        console.log(`  ❌ Push failed: ${err.message}`);
      }
    } else {
      console.log("\n⚠ No GITHUB_TOKEN — skipping push (dry run)");
    }
    process.exit(0);
  }

  const allEntries = [];
  const errors = [];

  // Run scrapers
  const scrapers = [];
  if (!sourceFlag || sourceFlag === "hotukdeals") scrapers.push({ name: "hotukdeals", fn: scrapeHotUKDeals });
  if (!sourceFlag || sourceFlag === "ggdeals") scrapers.push({ name: "ggdeals", fn: scrapeGGdeals });
  if (!sourceFlag || sourceFlag === "savoo") scrapers.push({ name: "savoo", fn: scrapeSavoo });
  if (!sourceFlag || sourceFlag === "coupert") scrapers.push({ name: "coupert", fn: scrapeCoupert });
  if (!sourceFlag || sourceFlag === "knoji") scrapers.push({ name: "knoji", fn: scrapeKnoji });

  if (mergeDirFlag) {
    // Merge-only: the scraping already happened in the matrix jobs.
    scrapers.length = 0;
    const files = readdirSync(mergeDirFlag).filter((f) => f.endsWith(".json"));
    console.log(`\n📥 Merging ${files.length} scrape artifact(s) from ${mergeDirFlag}`);
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(join(mergeDirFlag, file), "utf8"));
        allEntries.push(...(parsed.entries || []));
        if (parsed.errors?.length) errors.push(...parsed.errors);
        console.log(`  • ${file}: ${(parsed.entries || []).length} entries`);
      } catch (err) {
        console.log(`  ⚠ Could not read ${file}: ${err.message}`);
        errors.push(`[artifact:${file}] ${err.message}`);
      }
    }
  }

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

  if (emitFlag) {
    // Emit-only: hand the raw entries to the merge job and touch nothing else.
    mkdirSync(dirname(emitFlag), { recursive: true });
    writeFileSync(emitFlag, JSON.stringify({ source: sourceFlag || "all", entries: allEntries, errors }));
    console.log(`📤 Wrote ${allEntries.length} raw entries to ${emitFlag} (no merge, no push)`);
    return;
  }

  // Merge into database
  const { stores, stats } = mergeCodes(database.stores, allEntries, {
    isDeadCode: (code, domain) => isDeadCode(deadCodes, code, domain),
  });
  console.log(`  ✅ Added: ${stats.added} | Updated: ${stats.updated}${stats.blocked ? ` | Blocked (reported dead): ${stats.blocked}` : ""}`);

  // Fold alias domains, drop fabricated stores, re-clean descriptions and
  // backfill value/minSpend on codes stored before those fixes existed.
  const sanitized = sanitizeStores(stores);
  const ss = sanitized.stats;
  if (ss.merged || ss.droppedStores || ss.droppedCodes || ss.cleanedCodes) {
    console.log(`  🧹 Cleaned: merged ${ss.merged} alias stores | dropped ${ss.droppedStores} stores / ${ss.droppedCodes} codes | repaired ${ss.cleanedCodes} codes`);
  }

  // Drop anything already tombstoned that predates the dead-code list.
  const purged = purgeDeadFromStores(sanitized.stores, deadCodes);
  if (purged > 0) console.log(`  🚫 Purged ${purged} previously-reported code(s)`);

  // Only drop codes long past expiry — recently-expired ones often still work,
  // so the userscript flags them instead of us deleting them.
  const expired = pruneExpiredCodes(sanitized.stores);
  if (expired.pruned > 0) console.log(`  📅 Pruned ${expired.pruned} long-expired codes`);

  // Prune stale codes (>90 days old)
  const pruned = pruneStaleCodes(expired.stores, 90);
  if (pruned.pruned > 0) {
    console.log(`  🗑 Pruned ${pruned.pruned} stale codes`);
  }

  // Remove codes reported as failed via GitHub issues
  try {
    const failedIssues = await fetchFailedCodeIssues();
    if (failedIssues.length > 0) {
      let removed = 0;
      for (const { code, storeDomain, issueNumber } of failedIssues) {
        // Find the store and remove the code
        for (const [key, store] of Object.entries(pruned.stores)) {
          const domainMatch = key === canonicalDomain(storeDomain);
          if (domainMatch && store.codes) {
            const before = store.codes.length;
            store.codes = store.codes.filter(c => normalizeCode(c.code) !== normalizeCode(code));
            removed += before - store.codes.length;
          }
        }
        // Tombstone before closing, so the next scrape can't resurrect it.
        addDeadCode(deadCodes, code, storeDomain, `reported via issue #${issueNumber}`);
        await closeIssue(issueNumber);
      }
      if (removed > 0) {
        console.log(`  ❌ Removed ${removed} failed codes from ${failedIssues.length} reports`);
      }
    }
  } catch (err) {
    console.log(`  ⚠ Failed to process failed-code issues: ${err.message}`);
  }

  // Update meta
  database.stores = pruned.stores;
  // Remove stores with no codes left
  for (const [key, store] of Object.entries(database.stores)) {
    if (!store.codes || store.codes.length === 0) {
      delete database.stores[key];
    }
  }
  database.meta.lastUpdated = new Date().toISOString();
  database.meta.totalCodes = Object.values(database.stores).reduce((sum, s) => sum + s.codes.length, 0);

  console.log(`\n📈 Total codes in database: ${database.meta.totalCodes}`);

  // Save locally
  // Guard against a partial run wiping the database. A single source failing
  // shouldn't be able to replace 700+ codes with the 4 it managed to scrape.
  const collapsed = startingCodeCount > 50 && database.meta.totalCodes < startingCodeCount * 0.5;
  if (collapsed && !args.includes("--force")) {
    console.log(
      `
🛑 Refusing to save: code count collapsed from ${startingCodeCount} to ${database.meta.totalCodes}.` +
      `
   The database on disk is unchanged. Re-run with --force if this is intentional.`
    );
    return;
  }

  writeFileSync(LOCAL_JSON, JSON.stringify(database, null, 2));
  console.log(`💾 Saved to ${LOCAL_JSON}`);

  saveDeadCodes(DEAD_CODES_JSON, deadCodes);

  // Per-store shards + index. The userscript reads these, not the aggregate:
  // it fetches a small index then only the store for the site you're on.
  const shards = writeShards(DATA_DIR, database);
  console.log(`🗂 Sharded ${shards.stores} stores / ${shards.codes} codes (${shards.changed} file(s) changed, ${shards.removed} removed)`);

  // Push to GitHub if token available
  if (args.includes("--no-push")) {
    console.log("\n⏹ --no-push given — everything written locally, nothing pushed");
  } else if (process.env.GITHUB_TOKEN) {
    try {
      console.log("\n🚀 Pushing to GitHub…");
      const date = new Date().toISOString().split("T")[0];
      // Push the shards, not just the aggregate — the userscript reads the
      // shards, so pushing the aggregate alone would leave them stale.
      const files = [
        { path: "data/uk-coupons.json", content: JSON.stringify(database, null, 2) },
        { path: "data/dead-codes.json", content: readFileSync(DEAD_CODES_JSON, "utf8") },
        ...shards.changedPaths.map((p) => ({
          path: p,
          content: readFileSync(join(DATA_DIR, "..", p), "utf8"),
        })),
      ];
      await pushFiles(files, `Auto-scrape ${date} — ${database.meta.totalCodes} codes`);
      if (shards.removedPaths.length) {
        // Tree updates can't express deletions this way; git in CI handles it.
        console.log(`  ℹ ${shards.removedPaths.length} store file(s) removed locally — commit via git to delete remotely`);
      }
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
