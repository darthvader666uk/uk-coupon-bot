/**
 * Regenerate lib/domain-corrections.json.
 *
 * Savoo derives a store domain by appending .co.uk to its slug, so `alo-yoga`
 * becomes `alo-yoga.co.uk` when the shop is aloyoga.com. The userscript looks
 * up the hostname it is actually on, so a wrong key means the codes may as
 * well not be there. This finds every store key that does not exist and works
 * out what it should have been.
 *
 * Method, and why each part is needed:
 *   - DNS first, because it is free and settles most of it.
 *   - Then HTTP with redirects followed, taking the FINAL hostname: DNS alone
 *     kept aloyoga.co.uk (a parked domain for sale) and missed that
 *     anastasiabeverlyhills.co.uk redirects to the .com.
 *   - 403 and 503 count as live. Demanding 200 rejected musclesquad.com and
 *     theinkeylist.com, which are real shops behind bot protection.
 *   - The final hostname must still contain the store's flattened name. That
 *     is what rejects parking pages, which redirect off to a broker.
 *
 * Usage:  node scripts/verify-domains.mjs [--write]
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { lookup } from "dns/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = join(__dirname, "..", "..", "data", "uk-coupons.json");
const OUT = join(__dirname, "..", "lib", "domain-corrections.json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LIVE = new Set(["200", "403", "503", "429", "401"]);
const CONCURRENCY = 24;

const strip = (d) => d.replace(/\.(co\.uk|com|net|org|io|gg|land)$/, "");
const flatten = (d) => strip(d).replace(/-/g, "");

async function resolves(host) {
  for (const h of [host, `www.${host}`]) {
    try {
      await lookup(h);
      return true;
    } catch { /* try the next spelling */ }
  }
  return false;
}

/** Spellings worth trying, best guess first. */
function candidates(domain) {
  const base = strip(domain);
  const flat = base.replace(/-/g, "");
  const noUk = flat.replace(/uk$/, "");
  const out = [];
  for (const b of [flat, base, noUk]) {
    if (b.length < 3) continue;
    for (const tld of ["co.uk", "com"]) {
      const c = `${b}.${tld}`;
      if (c !== domain && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

async function probe(host) {
  try {
    const { stdout } = await execFileAsync("curl", [
      "-sS", "-o", "/dev/null", "-L", "--max-time", "12",
      "-A", UA, "-w", "%{http_code} %{url_effective}", `https://${host}`,
    ], { timeout: 20000 });
    const [status, url = ""] = stdout.trim().split(/\s+/);
    const finalHost = (url.match(/^https?:\/\/([^/]+)/)?.[1] || "").toLowerCase().replace(/^www\./, "");
    return { status, finalHost };
  } catch {
    return { status: null, finalHost: "" };
  }
}

async function repair(domain) {
  const want = flatten(domain).slice(0, 12);
  for (const c of candidates(domain)) {
    const { status, finalHost } = await probe(c);
    // The final hostname must still look like this store, or a parking broker
    // answering for the domain would be recorded as the shop.
    if (LIVE.has(status) && finalHost && finalHost.replace(/-/g, "").includes(want)) {
      return finalHost;
    }
  }
  return null;
}

/** Run `fn` over `items`, at most CONCURRENCY at a time. */
async function pooled(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) out.push([items[i], await fn(items[i++])]);
  }));
  return out;
}

const stores = Object.keys(JSON.parse(readFileSync(DB, "utf8")).stores);
console.log(`Checking ${stores.length} store domains…`);

const dns = await pooled(stores, resolves);
const dead = dns.filter(([, ok]) => !ok).map(([d]) => d);
console.log(`${dead.length} fail DNS. Probing replacements…`);

const repaired = await pooled(dead, repair);
const corrections = Object.fromEntries(repaired.filter(([, to]) => to).sort());
const unreachable = repaired.filter(([, to]) => !to).map(([d]) => d).sort();

console.log(`corrections ${Object.keys(corrections).length} | unreachable ${unreachable.length}`);

if (process.argv.includes("--write")) {
  const existing = JSON.parse(readFileSync(OUT, "utf8"));
  // Merge, never replace. The corrections are what keep the database clean, so
  // a run against an already-clean database finds nothing dead and would
  // otherwise write an empty file, letting every bad key back in on the next
  // scrape.
  const merged = { ...existing.corrections, ...corrections };
  const stillUnreachable = [...new Set([...(existing.unreachable || []), ...unreachable])].sort();
  writeFileSync(OUT, JSON.stringify({
    ...existing,
    _generated: new Date().toISOString().slice(0, 10),
    corrections: Object.fromEntries(Object.entries(merged).sort()),
    unreachable: stillUnreachable,
  }, null, 1));
  console.log(`Wrote ${OUT}: ${Object.keys(merged).length} corrections, ${stillUnreachable.length} unreachable`);
} else {
  console.log("Dry run — pass --write to update lib/domain-corrections.json");
}
