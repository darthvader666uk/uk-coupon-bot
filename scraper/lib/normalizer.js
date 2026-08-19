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
  // Truncate to 200 chars without cutting mid-word
  const cutoff = cleaned.lastIndexOf(" ", 200);
  return cleaned.substring(0, cutoff > 0 ? cutoff : 200);
}

/**
 * Extract discount value from description based on type
 */
export function extractValue(description, type) {
  if (!description) return null;

  if (type === "percentage") {
    const match = description.match(/(\d+)%\s*off/i);
    return match ? parseInt(match[1]) : null;
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
  const match = description.match(/(?:min(?:imum)?\s*(?:spend|order)?\s*(?:of\s*)?|spend\s+(?:at\s+least\s+)?|on\s+)£(\d+(?:\.\d{1,2})?)/i);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Guess coupon type from description text
 */
function guessTypeFromDescription(desc) {
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
        existing.testResults.worked = Math.round(entry.successRate * existing.testResults.total);
      }
      existing.lastSeen = now;
      if (entry.source && !existing.sources?.includes(entry.source)) {
        existing.sources = [...(existing.sources || []), entry.source];
      }
      updated++;
    } else {
      const cleanedDesc = cleanDescription(entry.description);
      const inferredType = entry.type !== "unknown" ? entry.type : guessTypeFromDescription(cleanedDesc);
      store.codes.push({
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
