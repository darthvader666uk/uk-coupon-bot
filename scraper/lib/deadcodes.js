/**
 * Tombstones for codes that have been reported as not working.
 *
 * Without this, the failed-code loop is self-defeating: removing a code from
 * the database does nothing, because the next scrape finds it at the same
 * source and adds it straight back. A tombstone records that the code was
 * rejected, so mergeCodes refuses to re-add it.
 *
 * Keyed `STORE::CODE`, so a code that's dead at one store can still be live at
 * another. Use store "*" to block a code everywhere.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { normalizeCode } from "./normalizer.js";
import { canonicalDomain } from "./stores.js";

/** How long a tombstone holds. Codes do get reissued, so they aren't forever. */
export const DEFAULT_TTL_DAYS = 180;

function keyFor(code, storeDomain) {
  const store = storeDomain === "*" ? "*" : canonicalDomain(storeDomain);
  return `${store}::${normalizeCode(code)}`;
}

export function loadDeadCodes(path) {
  if (!existsSync(path)) return { meta: { version: 1 }, codes: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { meta: parsed.meta || { version: 1 }, codes: parsed.codes || {} };
  } catch {
    return { meta: { version: 1 }, codes: {} };
  }
}

export function saveDeadCodes(path, deadCodes) {
  mkdirSync(dirname(path), { recursive: true });
  deadCodes.meta = { ...deadCodes.meta, version: 1, updatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(deadCodes, null, 2));
}

/**
 * Record a code as dead. Repeated reports bump `reports`, which is the signal
 * for "several people hit this", not just a one-off checkout mistake.
 */
export function addDeadCode(deadCodes, code, storeDomain, reason) {
  const key = keyFor(code, storeDomain);
  const existing = deadCodes.codes[key];
  if (existing) {
    existing.reports = (existing.reports || 1) + 1;
    existing.lastReportedAt = new Date().toISOString();
    if (reason && !existing.reasons?.includes(reason)) {
      existing.reasons = [...(existing.reasons || []), reason];
    }
    return false;
  }
  deadCodes.codes[key] = {
    code: normalizeCode(code),
    store: storeDomain === "*" ? "*" : canonicalDomain(storeDomain),
    reports: 1,
    reasons: reason ? [reason] : [],
    reportedAt: new Date().toISOString(),
    lastReportedAt: new Date().toISOString(),
  };
  return true;
}

/** True if this code is tombstoned for this store (or globally). */
export function isDeadCode(deadCodes, code, storeDomain, ttlDays = DEFAULT_TTL_DAYS) {
  const cutoff = Date.now() - ttlDays * 86400000;
  for (const key of [keyFor(code, storeDomain), keyFor(code, "*")]) {
    const entry = deadCodes.codes[key];
    if (!entry) continue;
    const reportedAt = new Date(entry.lastReportedAt || entry.reportedAt).getTime();
    if (isNaN(reportedAt) || reportedAt > cutoff) return true;
  }
  return false;
}

/** Drop tombstones past their TTL so reissued codes can come back. */
export function pruneDeadCodes(deadCodes, ttlDays = DEFAULT_TTL_DAYS) {
  const cutoff = Date.now() - ttlDays * 86400000;
  let pruned = 0;
  for (const [key, entry] of Object.entries(deadCodes.codes)) {
    const reportedAt = new Date(entry.lastReportedAt || entry.reportedAt).getTime();
    if (!isNaN(reportedAt) && reportedAt <= cutoff) {
      delete deadCodes.codes[key];
      pruned++;
    }
  }
  return pruned;
}

/** Remove any tombstoned codes already sitting in the database. */
export function purgeDeadFromStores(stores, deadCodes, ttlDays = DEFAULT_TTL_DAYS) {
  let removed = 0;
  for (const [domain, store] of Object.entries(stores)) {
    const before = (store.codes || []).length;
    store.codes = (store.codes || []).filter((c) => !isDeadCode(deadCodes, c.code, domain, ttlDays));
    removed += before - store.codes.length;
    if (store.codes.length === 0) delete stores[domain];
  }
  return removed;
}
