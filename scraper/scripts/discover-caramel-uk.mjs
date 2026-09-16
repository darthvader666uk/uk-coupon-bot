/**
 * One-off discovery of UK stores Caramel holds that data/index.json does not.
 *
 * Caramel's /api/coupons/stores is an autocomplete (ILIKE %q%, 50 rows, no
 * paging), so the .co.uk / .uk catalogue is walked by suffix: "s.co.uk", and
 * where a page comes back full, "as.co.uk", "bs.co.uk"… until it doesn't.
 * Around a thousand requests at one a second. Run by hand now and then, never
 * nightly: the catalogue walk is exactly what Caramel's page cap is there to
 * discourage, and the nightly source only ever asks about stores it knows.
 *
 * Writes data/caramel-seeds.json, which sources/caramel.js queries alongside
 * the index. A seed that yields codes joins the database and is then in the
 * index in its own right.
 *
 * Run: node scripts/discover-caramel-uk.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { canonicalDomain } from "../lib/stores.js";
import { delay } from "../lib/playwright-base.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const API = "https://grabcaramel.com/api/coupons/stores";
const SUFFIXES = [".co.uk", ".org.uk", ".me.uk", ".uk"];
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";
const PAGE = 50;
const GAP_MS = 1000;

let requests = 0;

async function search(q) {
  requests++;
  const res = await fetch(`${API}?q=${encodeURIComponent(q)}&limit=${PAGE}`, {
    headers: { Accept: "application/json", "User-Agent": "uk-coupon-bot (github.com/darthvader666uk/uk-coupon-bot)" },
  });
  if (res.status === 429) {
    console.log("  429 — pausing 60s");
    await delay(60000);
    return search(q);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${q}`);
  await delay(GAP_MS);
  return (await res.json()).sites || [];
}

/** Every site ending in `suffix`, recursing on prefixes while pages are full. */
async function walk(suffix, found) {
  const sites = await search(suffix);
  // Contains-match: keep only sites that actually END with the suffix.
  for (const s of sites) if (s.endsWith(suffix)) found.add(s);
  if (sites.length < PAGE) return;
  for (const ch of CHARS) await walk(ch + suffix, found);
}

const index = JSON.parse(readFileSync(join(DATA_DIR, "index.json"), "utf8"));
const known = new Set([...Object.keys(index.stores || {}), ...Object.keys(index.aliases || {})]);

const found = new Set();
for (const suffix of SUFFIXES) {
  const before = found.size;
  await walk(suffix, found);
  console.log(`${suffix}: ${found.size - before} sites (${requests} requests so far)`);
}

const fresh = [...found].map(canonicalDomain).filter((d) => !known.has(d)).sort();
const out = { updatedAt: new Date().toISOString(), source: "caramel /api/coupons/stores suffix walk", sites: fresh };
writeFileSync(join(DATA_DIR, "caramel-seeds.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`\n${found.size} UK sites on Caramel, ${fresh.length} not in the index → data/caramel-seeds.json (${requests} requests)`);
