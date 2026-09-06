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
  mergeCodes, sanitizeStores, pruneExpiredCodes, extractExpiry, isExpired, enrichCode, extractValue,
  extractMinSpend, cleanDescription, removeCode,
} from "../lib/normalizer.js";
import {
  loadDeadCodes, saveDeadCodes, addDeadCode, isDeadCode,
  pruneDeadCodes, purgeDeadFromStores,
} from "../lib/deadcodes.js";
import { writeShards } from "../lib/shard.js";
import { normaliseOffers, slugToDomain } from "../sources/coupert.js";
import { fileURLToPath } from "url";
import { dirname } from "path";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

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

console.log("\nDiscount values");
{
  // /(\d+)%/ on "14.1% off" matches the "1" after the point, so every
  // fractional discount was stored as its last digit.
  check("decimal percentage kept whole", extractValue("14.1% off selected products", "percentage") === 14.1);
  check("12.8% is not 8%", extractValue("12.8% off selected products", "percentage") === 12.8);
  check("whole percentages still work", extractValue("20% off everything", "percentage") === 20);
  check("single digit still works", extractValue("5% off", "percentage") === 5);
  check("fixed amounts unaffected", extractValue("£15 off orders", "fixed") === 15);

  // enrichCode must correct a wrong stored value, not just fill a null one.
  const code = { code: "GG1410", description: "14.1% off selected products", type: "percentage", value: 1 };
  enrichCode(code);
  check("wrong stored value is repaired", code.value === 14.1, `got ${code.value}`);

  const good = { code: "X", description: "20% off", type: "percentage", value: 20 };
  enrichCode(good);
  check("correct value left alone", good.value === 20);
}

console.log("\nDescription cleaning");
{
  check("short description keeps its last word",
    cleanDescription("20% off Selected Orders at LOOKFANTASTIC") === "20% off Selected Orders at LOOKFANTASTIC");
  check("nav garbage is dropped", cleanDescription("Travel\n\nView all Categories") === "");
  check("HTML is stripped", cleanDescription("<b>20% off</b> everything") === "20% off everything");
  check("min spend from 'orders over'", extractMinSpend("20% off orders over £50") === 50);
}

console.log("\nCoupert parsing");
{
  // Exactly what collectCards() returns from a real Driffle page, including
  // the cards below the "That You've Missed" heading.
  const cards = [
    { code: "CJ05", title: "Enjoy a Special 5% Discount with Driffle Promo Code", percent: "5%", expired: false },
    { code: "VLADDY10", title: "Exclusive 10% Savings Using Driffle Discount Code", percent: "10%", expired: false },
    { code: "PLSDONATES15", title: "Enjoy 15% off with Driffle Discount Code", percent: "15%", expired: false },
    { code: "FREECODE666", title: "Get 500 Gems and Lucky Drops", percent: null, expired: false },
    { code: "TWITTER1", title: "Get Exclusive Rewards with code", percent: null, expired: false },
    { code: "GGBOOST", title: "Enjoy a 12% Discount with Exclusive Driffle Promo Code", percent: null, expired: false },
    { code: "CRKCHRONOSLIVE26", title: "Exclusive Rewards from CRKCHRONOSLIVE26", percent: null, expired: false },
    { code: "AKS1450", title: "Save on your order with Driffle Discount Code", percent: null, expired: false },
    { code: "72KMEMBERS", title: "500 Gems with code Code", percent: null, expired: false },
    { code: "GG9GG", title: "Grab Up To 20% Off With Codes From Reddit", percent: "20%", expired: true },
    { code: "plsdonate2", title: "20 Giftbux with Code", percent: null, expired: true },
  ];

  const offers = normaliseOffers(cards);
  const codes = offers.map((o) => o.code);
  check("parses every live code", offers.length === 9, `got ${offers.length}: ${codes.join(",")}`);
  check("finds the codes we were missing",
    ["CJ05", "VLADDY10", "PLSDONATES15", "GGBOOST"].every((c) => codes.includes(c)));
  check("drops the expired section", !codes.includes("GG9GG") && !codes.includes("plsdonate2"));
  check("expired can be opted back in", normaliseOffers(cards, { includeExpired: true }).length === 11);

  const by = Object.fromEntries(offers.map((o) => [o.code, o]));
  check("percentage from the card badge", by.CJ05.value === 5 && by.CJ05.type === "percentage");
  check("percentage from the title when no badge", by.GGBOOST.value === 12);
  check("reward code gets no bogus discount", by.FREECODE666.value === null, `got ${by.FREECODE666.value}`);
  check("description kept with its own code", by.VLADDY10.description.includes("10% Savings"));

  check("junk is rejected", normaliseOffers([{ code: "Details", title: "x", percent: null, expired: false }]).length === 0);
  check("duplicates collapse", normaliseOffers([
    { code: "CJ05", title: "a", percent: null, expired: false },
    { code: "cj05", title: "b", percent: null, expired: false },
  ]).length === 1);
}
{
  // "driffle-com" previously became "drifflecom.co.uk" -- a store that cannot
  // exist, so these codes never reached driffle.com.
  check("slug -com -> .com", slugToDomain("driffle-com") === "driffle.com");
  check("slug -co-uk -> .co.uk", slugToDomain("amazon-co-uk") === "amazon.co.uk");
  check("mapped slug wins", slugToDomain("cdkeys-uk") === "cdkeys.com");
  check("plain slug defaults to .co.uk", slugToDomain("argos") === "argos.co.uk");
  check("already-a-domain slug passes through", slugToDomain("primelicense.com") === "primelicense.com");
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
