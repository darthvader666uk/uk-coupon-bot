/**
 * Splits the database into one file per store plus a small index.
 *
 * A single uk-coupons.json is ~363 bytes per code, so at 20k codes the
 * userscript would pull ~7MB from raw.githubusercontent.com every 6 hours just
 * to show a dozen codes. Sharded, the browser fetches a small index and then
 * only the one store file for the site it's on, so per-page cost stays flat
 * however large the database gets. It also keeps daily commits small: only the
 * stores that actually changed get rewritten.
 *
 *   data/index.json              -> { domain: { name, count } }
 *   data/stores/currys.co.uk.json -> { domain, name, codes: [...] }
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { ALIASES, HOSTNAME_ALIASES } from "./stores.js";

/** Domains come from a curated map, but never trust one into a file path. */
function isSafeDomain(domain) {
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain) && !domain.includes("..");
}

/**
 * Write index + per-store files. Only rewrites a store file when its contents
 * changed, so `git status` stays honest about what actually moved.
 */
export function writeShards(dataDir, database) {
  const storesDir = join(dataDir, "stores");
  mkdirSync(storesDir, { recursive: true });

  const index = { meta: {}, aliases: {}, stores: {} };
  const written = new Set();
  // Paths (repo-relative) that actually changed, so a push only sends those.
  const changedPaths = [];
  let changed = 0;

  for (const [domain, store] of Object.entries(database.stores)) {
    if (!isSafeDomain(domain)) {
      console.log(`  ⚠ Skipping unsafe store domain: ${domain}`);
      continue;
    }

    const codes = store.codes || [];
    if (codes.length === 0) continue;

    const payload = {
      domain,
      name: store.name || domain,
      category: store.category || "general",
      codes,
    };
    const serialised = JSON.stringify(payload, null, 2);
    const file = join(storesDir, `${domain}.json`);

    if (!existsSync(file) || readFileSync(file, "utf8") !== serialised) {
      writeFileSync(file, serialised);
      changedPaths.push(`data/stores/${domain}.json`);
      changed++;
    }
    written.add(`${domain}.json`);

    // Domain -> code count only. The store name lives in the store file, which
    // the browser fetches anyway once it matches; carrying names here would
    // roughly double an index that every supported site downloads.
    index.stores[domain] = codes.length;
  }

  // Drop store files for stores that no longer exist.
  let removed = 0;
  const removedPaths = [];
  for (const file of readdirSync(storesDir)) {
    if (!file.endsWith(".json") || written.has(file)) continue;
    unlinkSync(join(storesDir, file));
    removedPaths.push(`data/stores/${file}`);
    removed++;
  }

  // Ship the alias table in the index so the userscript reads it rather than
  // carrying a hand-synced copy. Only aliases pointing at a store we actually
  // have are worth sending.
  for (const [alias, canonical] of Object.entries({ ...ALIASES, ...HOSTNAME_ALIASES })) {
    if (index.stores[canonical] && alias !== canonical) index.aliases[alias] = canonical;
  }

  index.meta = {
    version: 2,
    updatedAt: new Date().toISOString(),
    totalStores: Object.keys(index.stores).length,
    totalCodes: Object.values(index.stores).reduce((n, count) => n + count, 0),
  };

  // The index is fetched by every browser on every supported site, so keep it
  // minified — pretty-printing roughly triples it for no reader benefit.
  const indexPath = join(dataDir, "index.json");
  const indexBody = JSON.stringify(index);
  // The index carries an updatedAt, so compare everything except that.
  const indexChanged = !existsSync(indexPath)
    || JSON.stringify({ ...JSON.parse(readFileSync(indexPath, "utf8")), meta: null })
       !== JSON.stringify({ ...index, meta: null });
  writeFileSync(indexPath, indexBody);
  if (indexChanged || changedPaths.length || removedPaths.length) changedPaths.push("data/index.json");

  return {
    changed,
    removed,
    changedPaths,
    removedPaths,
    stores: index.meta.totalStores,
    codes: index.meta.totalCodes,
  };
}
