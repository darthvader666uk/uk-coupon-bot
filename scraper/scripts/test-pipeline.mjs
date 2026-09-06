/**
 * Tests for the data pipeline: tombstones, alias folding, expiry, sharding.
 *
 * The headline case is the one the whole feedback loop depends on — a code
 * reported as broken must not come back on the next scrape.
 *
 * Run: node scripts/test-pipeline.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  mergeCodes, sanitizeStores, pruneExpiredCodes, extractExpiry, isExpired,
  extractMinSpend, cleanDescription, removeCode,
} from "../lib/normalizer.js";
import {
  loadDeadCodes, saveDeadCodes, addDeadCode, isDeadCode,
  pruneDeadCodes, purgeDeadFromStores,
} from "../lib/deadcodes.js";
import { writeShards } from "../lib/shard.js";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const entry = (over = {}) => ({
  code: "BADCODE", storeDomain: "currys.co.uk", storeName: "Currys",
  description: "20% off", type: "unknown", source: "savoo", ...over,
});

console.log("\nDead-code loop");
{
  const dead = { meta: {}, codes: {} };
  const stores = {};
  const isDead = (code, domain) => isDeadCode(dead, code, domain);

  mergeCodes(stores, [entry()], { isDeadCode: isDead });
  check("day 1 scrape adds the code", stores["currys.co.uk"]?.codes.length === 1);

  // User reports it broken: remove + tombstone, as index.js now does.
  removeCode(stores, "BADCODE", "currys.co.uk");
  addDeadCode(dead, "BADCODE", "currys.co.uk", "reported");
  check("removal empties the store", !stores["currys.co.uk"]);

  const { stats } = mergeCodes(stores, [entry()], { isDeadCode: isDead });
  check("day 2 scrape does NOT re-add it", !stores["currys.co.uk"], "the v1 bug is back");
  check("the block is reported in stats", stats.blocked === 1);
}
{
  const dead = { meta: {}, codes: {} };
  addDeadCode(dead, "BADCODE", "currys.co.uk");
  check("tombstone is store-scoped", !isDeadCode(dead, "BADCODE", "argos.co.uk"));
  check("tombstone matches its own store", isDeadCode(dead, "BADCODE", "currys.co.uk"));
  check("code normalisation applies", isDeadCode(dead, "bad-code", "currys.co.uk"));
  check("alias resolves to canonical store", isDeadCode(dead, "BADCODE", "www.currys.co.uk"));

  addDeadCode(dead, "EVERYWHERE", "*");
  check("global tombstone blocks any store", isDeadCode(dead, "EVERYWHERE", "argos.co.uk"));

  addDeadCode(dead, "BADCODE", "currys.co.uk");
  check("repeat reports increment the counter", dead.codes["currys.co.uk::BADCODE"].reports === 2);
}
{
  const dead = { meta: {}, codes: {} };
  addDeadCode(dead, "OLD", "currys.co.uk");
  dead.codes["currys.co.uk::OLD"].lastReportedAt = new Date(Date.now() - 200 * 86400000).toISOString();
  check("expired tombstone stops blocking", !isDeadCode(dead, "OLD", "currys.co.uk"));
  check("expired tombstone is pruned", pruneDeadCodes(dead) === 1);
}
{
  const stores = { "currys.co.uk": { name: "Currys", codes: [{ code: "GONE" }, { code: "KEEP" }] } };
  const dead = { meta: {}, codes: {} };
  addDeadCode(dead, "GONE", "currys.co.uk");
  check("purge clears already-stored dead codes", purgeDeadFromStores(stores, dead) === 1);
  check("purge keeps the live ones", stores["currys.co.uk"].codes.length === 1);
}

console.log("\nStore canonicalisation");
{
  const stores = {};
  const { stats } = mergeCodes(stores, [
    entry({ code: "save20", storeDomain: "ASOS.com", description: "<![CDATA[20% off orders over £50]]>" }),
    entry({ code: "SAVE-20", storeDomain: "asos.co.uk", description: "", source: "myvouchercodes" }),
    entry({ code: "JUNK", storeDomain: "unknown.co.uk" }),
  ]);
  const asos = stores["asos.co.uk"];
  check("alias domains fold together", Object.keys(stores).length === 1 && !!asos);
  check("duplicate code is merged, not doubled", asos.codes.length === 1);
  check("sources are unioned", asos.codes[0].sources.length === 2);
  check("CDATA is stripped", asos.codes[0].description === "20% off orders over £50");
  check("value is derived", asos.codes[0].value === 20 && asos.codes[0].type === "percentage");
  check("min spend is derived", asos.codes[0].minSpend === 50);
  check("store name is real, not a page title", asos.name === "ASOS");
  check("junk domain is skipped", stats.skipped === 1);
}
{
  // guessDomain() builds these out of offer text; they can never match a real
  // hostname, and previously they slipped through to the sharder.
  const stores = {};
  const { stats } = mergeCodes(stores, [
    entry({ storeDomain: "instant-print..co.uk" }),
    entry({ storeDomain: "furn..co.uk" }),
    entry({ storeDomain: "nodot" }),
    entry({ storeDomain: ".leadingdot.co.uk" }),
  ]);
  check("malformed domains are rejected", stats.skipped === 4 && Object.keys(stores).length === 0,
    `skipped ${stats.skipped}, stores ${JSON.stringify(Object.keys(stores))}`);
}
{
  // The split-store case: one half holds scraped nav garbage, the other the
  // real offer text. The good description must win and re-derive the value.
  const { stores } = sanitizeStores({
    "boots.co.uk": { name: "Boots Discount Codes | July 2026", codes: [
      { code: "X1", description: "Travel\n\nView all Categories\n\nFlights", type: "unknown", value: null, sources: ["a"] },
    ]},
    "boots.com": { name: "Boots", codes: [
      { code: "X1", description: "22% off Selected Orders", type: "percentage", value: null, sources: ["b"] },
    ]},
  });
  const code = stores["boots.co.uk"].codes[0];
  check("garbage description is replaced by the good one", code.description === "22% off Selected Orders");
  check("value re-derived after the swap", code.value === 22 && code.type === "percentage");
  check("both sources retained", code.sources.length === 2);
}

console.log("\nExpiry");
{
  check("UK-order numeric date", extractExpiry("20% off, expires 31/12/2026") === "2026-12-31");
  check("named month", extractExpiry("valid until 31 December 2026") === "2026-12-31");
  check("impossible date rejected", extractExpiry("ends 32/13/2026") === null);
  check("vague text rejected", extractExpiry("expires soon") === null);
  check("unrelated £ not treated as a date", extractExpiry("£20 off £60 spend") === null);

  // Codes often keep working past their advertised end date, so a recently
  // expired code must survive — only long-dead ones get dropped.
  const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const { pruned, stores } = pruneExpiredCodes({
    "a.co.uk": { name: "A", codes: [
      { code: "ANCIENT", expiry: "2020-01-01" },
      { code: "JUSTEXPIRED", expiry: recent },
      { code: "FUTURE", expiry: "2099-01-01" },
      { code: "NONE", expiry: null },
    ]},
  });
  check("long-expired code pruned", pruned === 1);
  check("recently expired code is kept", stores["a.co.uk"].codes.some((c) => c.code === "JUSTEXPIRED"));
  check("future and undated codes kept", stores["a.co.uk"].codes.length === 3);
  check("isExpired flags a passed date", isExpired({ expiry: recent }));
  check("isExpired ignores a future date", !isExpired({ expiry: "2099-01-01" }));
  check("isExpired ignores no date", !isExpired({ expiry: null }));
}

console.log("\nDescription cleaning");
{
  check("short description keeps its last word",
    cleanDescription("20% off Selected Orders at LOOKFANTASTIC") === "20% off Selected Orders at LOOKFANTASTIC");
  check("nav garbage is dropped", cleanDescription("Travel\n\nView all Categories") === "");
  check("HTML is stripped", cleanDescription("<b>20% off</b> everything") === "20% off everything");
  check("min spend from 'orders over'", extractMinSpend("20% off orders over £50") === 50);
}

console.log("\nSharding");
{
  const dir = mkdtempSync(join(tmpdir(), "ukcp-"));
  try {
    const db = { stores: {
      "currys.co.uk": { name: "Currys", codes: [{ code: "A" }, { code: "B" }] },
      "argos.co.uk": { name: "Argos", codes: [{ code: "C" }] },
      "empty.co.uk": { name: "Empty", codes: [] },
    }};
    const first = writeShards(dir, db);
    check("one file per non-empty store", first.stores === 2 && first.changed === 2);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    check("index lists domain -> count", index.stores["currys.co.uk"] === 2);
    check("index ships the alias table", typeof index.aliases === "object");
    check("aliases only point at stores we have", Object.values(index.aliases).every((d) => index.stores[d]));
    check("store file carries its codes",
      JSON.parse(readFileSync(join(dir, "stores", "currys.co.uk.json"), "utf8")).codes.length === 2);
    check("empty store gets no file", !existsSync(join(dir, "stores", "empty.co.uk.json")));

    const second = writeShards(dir, db);
    check("unchanged stores are not rewritten", second.changed === 0);

    delete db.stores["argos.co.uk"];
    const third = writeShards(dir, db);
    check("removed store's file is deleted", third.removed === 1 && !existsSync(join(dir, "stores", "argos.co.uk.json")));

    const traversal = writeShards(dir, { stores: { "../evil": { name: "x", codes: [{ code: "A" }] } } });
    check("path traversal in a domain is refused", traversal.stores === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nTombstone persistence");
{
  const dir = mkdtempSync(join(tmpdir(), "ukcp-"));
  try {
    const file = join(dir, "dead-codes.json");
    const dead = loadDeadCodes(file);
    check("missing file loads empty", Object.keys(dead.codes).length === 0);
    addDeadCode(dead, "X", "currys.co.uk", "reported");
    saveDeadCodes(file, dead);
    check("reloads from disk", isDeadCode(loadDeadCodes(file), "X", "currys.co.uk"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
