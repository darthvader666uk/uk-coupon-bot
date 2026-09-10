/**
 * Deciding which store an offer actually belongs to.
 *
 * Every voucher aggregator pads a store's page with other retailers' offers —
 * Savoo calls them related offers, Coupert calls them Alternatives, Knoji shows
 * "similar coupons". Believing the page you are on rather than the offer itself
 * is what put a Wayfair code under B&Q and Macy's codes under Anastasia
 * Beverly Hills.
 *
 * Fortunately they all label them the same way: the offer title ends with
 * "... at <Retailer>".
 */

/**
 * "&" must expand before the strip, or "B&Q" reduces to "bq" while the slug
 * "b-and-q" reduces to "bandq" and a store fails to match its own offers.
 */
export function normaliseName(value) {
  return (value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

/** The retailer an offer title claims, or null when it doesn't name one. */
export function claimedStore(title) {
  const m = /\bat ([A-Za-z0-9&'. -]{2,40})$/.exec((title || "").trim());
  return m ? m[1].trim() : null;
}

/**
 * True when a title either names this store or names nobody.
 *
 * @param {string} title        offer title, e.g. "20% off Toys at Argos"
 * @param {...string} identifiers  any spelling of the store: domain, slug, name
 */
export function belongsToStore(title, ...identifiers) {
  const claimed = normaliseName(claimedStore(title));
  // No "at X" suffix — treat it as the page's own offer.
  if (!claimed || claimed.length < 2) return true;

  // Short names are matched whole. Accepting a substring here would let a
  // three-letter retailer match any store that merely contains those letters
  // ("at UR" against purely.co.uk), and the old four-character floor waved
  // every short name through instead: that is how a "$20 off at HSN" coupon
  // came to sit under De'Longhi and an END. offer under Paul Smith.
  const exactOnly = claimed.length < 4;

  for (const id of identifiers) {
    const known = normaliseName(
      String(id || "").replace(/\.(co\.uk|com|net|org|io|gg|land)$/, "")
    );
    if (!known) continue;
    if (exactOnly) {
      if (known === claimed) return true;
      continue;
    }
    if (known.length < 3) continue;
    if (claimed.includes(known) || known.includes(claimed)) return true;
  }
  return false;
}
