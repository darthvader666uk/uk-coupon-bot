/**
 * Normalize a coupon code string: uppercase, strip spaces/hyphens
 */
export function normalizeCode(code) {
  if (!code || typeof code !== "string") return "";
  return code.trim().toUpperCase().replace(/[\s\-_]+/g, "");
}

/**
 * Generate a dedup key from code + store
 */
export function dedupKey(code, storeDomain) {
  return `${normalizeCode(code)}::${storeDomain.toLowerCase()}`;
}

/**
 * Merge new codes into existing store data. Returns updated stores object.
 * - Deduplicates by code+store
 * - Keeps highest successRate
 * - Updates lastSeen timestamp
 */
export function mergeCodes(existingStores, newEntries) {
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const entry of newEntries) {
    const domain = entry.storeDomain.toLowerCase();
    if (!existingStores[domain]) {
      existingStores[domain] = {
        name: entry.storeName || domain,
        category: entry.category || "general",
        codes: [],
      };
    }

    const store = existingStores[domain];
    const normalised = normalizeCode(entry.code);
    const existing = store.codes.find(
      (c) => normalizeCode(c.code) === normalised
    );

    if (existing) {
      // Update: keep higher successRate, refresh lastSeen
      if (entry.successRate !== undefined && entry.successRate > (existing.testResults?.worked || 0) / Math.max(existing.testResults?.total || 1, 1)) {
        existing.testResults = existing.testResults || { total: 0, worked: 0 };
        existing.testResults.worked = entry.successRate > 0 ? existing.testResults.total : existing.testResults.worked;
      }
      existing.lastSeen = now;
      if (entry.source && !existing.sources?.includes(entry.source)) {
        existing.sources = [...(existing.sources || []), entry.source];
      }
      updated++;
    } else {
      store.codes.push({
        code: normalised,
        description: entry.description || "",
        type: entry.type || "unknown",
        value: entry.value || null,
        minSpend: entry.minSpend || null,
        expiry: entry.expiry || null,
        source: entry.source || "unknown",
        sources: [entry.source || "unknown"],
        url: entry.url || "",
        addedAt: now,
        lastSeen: now,
        testResults: { total: 0, worked: 0, lastTested: null },
      });
      added++;
    }
  }

  return { stores: existingStores, stats: { added, updated, skipped } };
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
