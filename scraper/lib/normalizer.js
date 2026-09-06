import { canonicalDomain, displayName, isJunkDomain } from "./stores.js";

/**
 * Normalize a coupon code string: uppercase, strip spaces/hyphens
 */
export function normalizeCode(code) {
  if (!code || typeof code !== "string") return "";
  return code.trim().toUpperCase().replace(/[\s\-_]+/g, "");
}

/**
 * Clean a description string: strip CDATA wrappers, HTML tags, garbage text, collapse whitespace
 */
export function cleanDescription(desc) {
  if (!desc || typeof desc !== "string") return "";
  // Strip CDATA wrappers
  let cleaned = desc.replace(/<!\[CDATA\[/gi, "").replace(/\]\]>/g, "").trim();
  // Strip HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "").trim();
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  // Filter out garbage descriptions
  const garbagePatterns = /^(sponsored|we use cookies|share this page|view all|travel|newsletter|subscribe|follow us|sign up|login|register|cookie|privacy|terms)/i;
  if (garbagePatterns.test(cleaned)) return "";
  // Filter descriptions shorter than 5 characters (likely noise)
  if (cleaned.length < 5) return "";
  // Truncate to 200 chars without cutting mid-word. Anything already short
  // enough is returned untouched — lastIndexOf(" ", 200) on a short string
  // returns its final space, which would drop the last word of every
  // description.
  if (cleaned.length <= 200) return cleaned;
  const cutoff = cleaned.lastIndexOf(" ", 200);
  return cleaned.substring(0, cutoff > 0 ? cutoff : 200).trim();
}

/**
 * Extract discount value from description based on type
 */
export function extractValue(description, type) {
  if (!description) return null;

  if (type === "percentage") {
    // The decimal part must be included: /(\d+)%/ on "14.1% off" matches the
    // "1" after the point, so every fractional discount was stored as its
    // last digit — 14.1% became 1%, 12.8% became 8%.
    const match = description.match(/(\d+(?:\.\d+)?)\s*%\s*off/i);
    return match ? parseFloat(match[1]) : null;
  }

  if (type === "fixed") {
    const match = description.match(/£(\d+(?:\.\d{1,2})?)/);
    return match ? parseFloat(match[1]) : null;
  }

  return null;
}

/**
 * Extract minimum spend requirement from description
 */
export function extractMinSpend(description) {
  if (!description) return null;
  const match = description.match(
    /(?:min(?:imum)?\s*(?:spend|order)?\s*(?:of\s*)?|spend\s+(?:at\s+least\s+)?|orders?\s+(?:over|above|of)\s+|when\s+you\s+spend\s+|over\s+|on\s+)£(\d+(?:\.\d{1,2})?)/i
  );
  return match ? parseFloat(match[1]) : null;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Pull an expiry date out of description text. Deliberately conservative — a
 * wrong date silently deletes a working code, so anything ambiguous returns
 * null and the code just lives until the staleness prune catches it.
 *
 * @returns {string|null} ISO date (YYYY-MM-DD)
 */
export function extractExpiry(description, now = new Date()) {
  if (!description || typeof description !== "string") return null;
  const text = description.toLowerCase();

  // Only trust dates that are explicitly framed as an end date.
  const framed = /(?:expires?|expiry|ends?|valid\s+until|until|till|before)\s*:?\s*(.{0,24})/i.exec(text);
  if (!framed) return null;
  const tail = framed[1];

  // 31/12/2026, 31-12-26, 31.12.2026 — UK order (day first).
  const numeric = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/.exec(tail);
  if (numeric) {
    const day = parseInt(numeric[1], 10);
    const month = parseInt(numeric[2], 10) - 1;
    let year = parseInt(numeric[3], 10);
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() === month && d.getUTCDate() === day) return d.toISOString().slice(0, 10);
    return null;
  }

  // "31 December 2026" / "31st Dec" / "December 31"
  const named = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b(?:\s+(\d{4}))?/.exec(tail)
    || /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s+(\d{4}))?/.exec(tail);
  if (named) {
    const monthFirst = isNaN(parseInt(named[1], 10));
    const day = parseInt(monthFirst ? named[2] : named[1], 10);
    const monthKey = (monthFirst ? named[1] : named[2]).slice(0, 3);
    if (!(monthKey in MONTHS)) return null;
    const month = MONTHS[monthKey];
    let year = named[3] ? parseInt(named[3], 10) : now.getUTCFullYear();
    // No year given and the date has already passed this year — assume next.
    if (!named[3]) {
      const candidate = new Date(Date.UTC(year, month, day));
      if (candidate.getTime() < now.getTime() - 86400000) year += 1;
    }
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() === month && d.getUTCDate() === day) return d.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * How long past its stated expiry a code is still kept. Retailers routinely
 * leave codes working after the advertised end date, so a passed expiry is
 * shown as a warning rather than treated as fact. This grace period only
 * exists to stop long-dead codes accumulating forever.
 */
export const EXPIRY_GRACE_DAYS = 90;

/** True if the stated expiry has passed — displayed, not acted on. */
export function isExpired(code, now = new Date()) {
  if (!code.expiry) return false;
  return code.expiry < now.toISOString().slice(0, 10);
}

/**
 * Drop only codes long past their expiry. Anything recently expired is kept,
 * because it may well still work.
 */
export function pruneExpiredCodes(stores, { now = new Date(), graceDays = EXPIRY_GRACE_DAYS } = {}) {
  const cutoff = new Date(now.getTime() - graceDays * 86400000).toISOString().slice(0, 10);
  let pruned = 0;
  for (const domain of Object.keys(stores)) {
    const before = stores[domain].codes.length;
    stores[domain].codes = stores[domain].codes.filter((c) => !c.expiry || c.expiry >= cutoff);
    pruned += before - stores[domain].codes.length;
    if (stores[domain].codes.length === 0) delete stores[domain];
  }
  return { stores, pruned };
}

/**
 * Guess coupon type from description text
 */
export function guessTypeFromDescription(desc) {
  if (!desc) return "unknown";
  const lower = desc.toLowerCase();
  if (/\d+%\s*off/.test(lower)) return "percentage";
  if (/£\d+/.test(lower)) return "fixed";
  if (/free\s+(delivery|shipping)/.test(lower)) return "free_shipping";
  if (/buy\s+\d+\s+get/.test(lower)) return "bogo";
  return "unknown";
}

/**
 * Generate a dedup key from code + store
 */
export function dedupKey(code, storeDomain) {
  return `${normalizeCode(code)}::${storeDomain.toLowerCase()}`;
}

/**
 * Re-clean a stored code in place. Codes written before the description and
 * value-extraction fixes landed keep their old dirty fields forever, because
 * mergeCodes only ever built those fields for *new* codes. This backfills them
 * on every run so the database converges on clean data.
 *
 * @returns {boolean} true if anything changed
 */
export function enrichCode(code) {
  let changed = false;

  const cleanedDesc = cleanDescription(code.description);
  if (cleanedDesc !== code.description) {
    code.description = cleanedDesc;
    changed = true;
  }

  if (!code.type || code.type === "unknown") {
    const inferred = guessTypeFromDescription(code.description);
    if (inferred !== code.type) {
      code.type = inferred;
      changed = true;
    }
  }

  if (code.value === null || code.value === undefined) {
    const value = extractValue(code.description, code.type);
    if (value !== null) {
      code.value = value;
      changed = true;
    }
  } else if (code.type === "percentage") {
    // Repair values stored by the old decimal-losing regex. The description is
    // what the user reads next to the figure, so it wins.
    const value = extractValue(code.description, code.type);
    if (value !== null && value !== code.value) {
      code.value = value;
      changed = true;
    }
  }

  if (code.minSpend === null || code.minSpend === undefined) {
    const minSpend = extractMinSpend(code.description);
    if (minSpend !== null) {
      code.minSpend = minSpend;
      changed = true;
    }
  }

  if (!code.expiry) {
    const expiry = extractExpiry(code.description);
    if (expiry) {
      code.expiry = expiry;
      changed = true;
    }
  }

  // A type we can't back with a number is worse than no type at all — the UI
  // renders "fixed" with a null value as a blank discount.
  if ((code.type === "percentage" || code.type === "fixed") && code.value === null) {
    code.type = "unknown";
    changed = true;
  }

  return changed;
}

/**
 * Merge new codes into existing store data. Returns updated stores object.
 * - Folds alias domains onto their canonical store
 * - Drops codes attributed to fabricated ("junk") domains
 * - Deduplicates by code+store
 * - Keeps highest successRate
 * - Updates lastSeen timestamp
 */
export function mergeCodes(existingStores, newEntries, options = {}) {
  const now = new Date().toISOString();
  // Injected rather than imported so normalizer stays free of file I/O and
  // deadcodes.js can import from here without a cycle.
  const isDead = options.isDeadCode || (() => false);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let blocked = 0;

  for (const entry of newEntries) {
    const domain = canonicalDomain(entry.storeDomain);
    if (!domain || isJunkDomain(domain)) {
      skipped++;
      continue;
    }

    // Reported as broken — do not resurrect it.
    if (isDead(entry.code, domain)) {
      blocked++;
      continue;
    }

    if (!existingStores[domain]) {
      existingStores[domain] = {
        name: displayName(domain, entry.storeName),
        category: entry.category || "general",
        codes: [],
      };
    }

    const store = existingStores[domain];
    store.name = displayName(domain, store.name);
    const normalised = normalizeCode(entry.code);
    const existing = store.codes.find(
      (c) => normalizeCode(c.code) === normalised
    );

    if (existing) {
      // Update: keep higher successRate, refresh lastSeen
      if (entry.successRate !== undefined && entry.successRate > (existing.testResults?.worked || 0) / Math.max(existing.testResults?.total || 1, 1)) {
        existing.testResults = existing.testResults || { total: 0, worked: 0 };
        existing.testResults.worked = Math.round(entry.successRate * existing.testResults.total);
      }
      existing.lastSeen = now;
      if (entry.source && !existing.sources?.includes(entry.source)) {
        existing.sources = [...(existing.sources || []), entry.source];
      }
      // A later source often carries a better description than the one we
      // first stored — take it if ours is empty and theirs survives cleaning.
      if (!existing.description) {
        const incoming = cleanDescription(entry.description);
        if (incoming) existing.description = incoming;
      }
      enrichCode(existing);
      updated++;
    } else {
      const cleanedDesc = cleanDescription(entry.description);
      const inferredType = entry.type !== "unknown" ? entry.type : guessTypeFromDescription(cleanedDesc);
      const created = {
        code: normalised,
        description: cleanedDesc || "",
        type: inferredType,
        value: entry.value || extractValue(cleanedDesc, inferredType),
        minSpend: entry.minSpend || extractMinSpend(cleanedDesc),
        expiry: entry.expiry || null,
        source: entry.source || "unknown",
        sources: [entry.source || "unknown"],
        url: entry.url || "",
        addedAt: now,
        lastSeen: now,
        testResults: { total: 0, worked: 0, lastTested: null },
      };
      enrichCode(created);
      store.codes.push(created);
      added++;
    }
  }

  return { stores: existingStores, stats: { added, updated, skipped, blocked } };
}

/**
 * Bring an entire stores object up to current standards. Safe to run on every
 * scrape — it is idempotent.
 *
 * - Folds alias domains onto their canonical store, merging the code lists
 * - Drops stores on fabricated domains
 * - Replaces scraped-page-title names with real store names
 * - Re-cleans every code's description and backfills type/value/minSpend
 */
export function sanitizeStores(stores) {
  const result = {};
  const stats = { merged: 0, droppedStores: 0, droppedCodes: 0, cleanedCodes: 0, renamed: 0 };

  for (const [rawDomain, store] of Object.entries(stores)) {
    const domain = canonicalDomain(rawDomain);

    if (isJunkDomain(domain)) {
      stats.droppedStores++;
      stats.droppedCodes += (store.codes || []).length;
      continue;
    }

    if (!result[domain]) {
      result[domain] = {
        name: displayName(domain, store.name),
        category: store.category || "general",
        codes: [],
      };
      if (result[domain].name !== store.name) stats.renamed++;
    } else {
      stats.merged++;
    }

    const target = result[domain];
    for (const code of store.codes || []) {
      const normalised = normalizeCode(code.code);
      if (!normalised) {
        stats.droppedCodes++;
        continue;
      }

      const existing = target.codes.find((c) => normalizeCode(c.code) === normalised);
      if (existing) {
        // Same code arriving from both halves of a split store — keep the
        // richer record and union the source lists. One half often holds
        // scraped nav garbage while the other holds the real offer text, so
        // adopt the incoming description when ours cleans away to nothing,
        // then re-derive type/value from whichever text we ended up with.
        const incoming = cleanDescription(code.description);
        if (!existing.description && incoming) existing.description = incoming;
        existing.sources = [...new Set([...(existing.sources || []), ...(code.sources || [])])];
        if (new Date(code.lastSeen || 0) > new Date(existing.lastSeen || 0)) {
          existing.lastSeen = code.lastSeen;
        }
        if (existing.expiry == null && code.expiry != null) existing.expiry = code.expiry;
        if (!existing.url && code.url) existing.url = code.url;
        enrichCode(existing);
        stats.droppedCodes++;
        continue;
      }

      code.code = normalised;
      if (enrichCode(code)) stats.cleanedCodes++;
      target.codes.push(code);
    }
  }

  // Drop stores left with nothing after cleaning.
  for (const domain of Object.keys(result)) {
    if (result[domain].codes.length === 0) {
      delete result[domain];
      stats.droppedStores++;
    }
  }

  return { stores: result, stats };
}

/**
 * Remove codes older than maxAgeDays that haven't been seen recently
 */
export function pruneStaleCodes(stores, maxAgeDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  let pruned = 0;

  for (const domain of Object.keys(stores)) {
    const before = stores[domain].codes.length;
    stores[domain].codes = stores[domain].codes.filter((c) => {
      const lastSeen = new Date(c.lastSeen || c.addedAt);
      return lastSeen > cutoff;
    });
    pruned += before - stores[domain].codes.length;

    // Remove empty stores
    if (stores[domain].codes.length === 0) {
      delete stores[domain];
    }
  }

  return { stores, pruned };
}

/**
 * Remove a single code from a store (or from all stores if storeDomain omitted).
 * Mutates `stores` in place. Deletes the store if its codes array becomes empty.
 *
 * @param {object} stores - The stores object from the database
 * @param {string} code - The code to remove (case-insensitive, spaces/hyphens ignored)
 * @param {string} [storeDomain] - Optional: only remove from this specific domain
 * @returns {{ stores: object, removed: number, matchedDomains: string[] }}
 */
export function removeCode(stores, code, storeDomain) {
  const target = normalizeCode(code);
  if (!target) return { stores, removed: 0, matchedDomains: [] };
  let removed = 0;
  const matchedDomains = [];
  for (const [domain, store] of Object.entries(stores)) {
    if (storeDomain && domain.toLowerCase() !== storeDomain.toLowerCase()) continue;
    const before = (store.codes || []).length;
    store.codes = (store.codes || []).filter(c => normalizeCode(c.code) !== target);
    const diff = before - store.codes.length;
    if (diff > 0) {
      removed += diff;
      matchedDomains.push(domain);
      if (store.codes.length === 0) delete stores[domain];
    }
  }
  return { stores, removed, matchedDomains };
}
