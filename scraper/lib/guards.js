/**
 * Reasons to refuse to save, and to say so with a non-zero exit code.
 *
 * Both guards exist because "refused to save" was being reported as success.
 * The pipeline would write nothing, exit 0, and let CI's commit step run and
 * announce "No changes to commit", which is indistinguishable from a quiet
 * night. A scrape that cannot reach anything therefore looked identical to a
 * scrape that found nothing new, which is how GG.deals served a cache frozen
 * since 2026-07-13 while `lastSeen` kept being refreshed.
 */

/**
 * True when a run that was supposed to scrape came back with nothing at all.
 *
 * There is no honest reading of this. Every source returns hundreds of entries
 * on a normal night, so zero means the source is blocked, the site changed, or
 * the browser never launched. Measured on 2026-09-10: a headful browser with no
 * X server fails in 130ms, and the run still saved and pushed a commit.
 *
 * @param {object}  o
 * @param {boolean} o.scraped     a scrape or merge was actually attempted
 * @param {number}  o.entryCount  raw entries returned by all sources
 * @param {boolean} o.force       --force was given
 */
export function isEmptyScrape({ scraped, entryCount, force = false }) {
  if (!scraped || force) return false;
  return entryCount === 0;
}

/**
 * True when the run would replace the database with a fraction of itself.
 *
 * A single source failing should not be able to swap 700+ codes for the 4 it
 * managed. The floor keeps this quiet while the database is still small enough
 * for ordinary churn to look like a collapse.
 *
 * @param {object}  o
 * @param {number}  o.before  code count loaded at the start of the run
 * @param {number}  o.after   code count this run would save
 * @param {boolean} o.force   --force was given
 * @param {number}  o.floor   don't apply the guard below this many codes
 */
export function hasCollapsed({ before, after, force = false, floor = 50 }) {
  if (force || before <= floor) return false;
  return after < before * 0.5;
}
