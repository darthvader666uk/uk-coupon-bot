import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

// `new URL(...).pathname` yields "/C:/..." on Windows, which fs then resolves
// against the drive root as "C:\C:\...". fileURLToPath handles both platforms.
const LOG_FILE = fileURLToPath(new URL("../scrape-log.json", import.meta.url));

export function loadLog() {
  if (!existsSync(LOG_FILE)) return { runs: [] };
  try {
    return JSON.parse(readFileSync(LOG_FILE, "utf8"));
  } catch {
    return { runs: [] };
  }
}

export function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

export function logRun(source, stats, errors = []) {
  const log = loadLog();
  log.runs.push({
    timestamp: new Date().toISOString(),
    source,
    codesFound: stats.found || 0,
    codesAdded: stats.added || 0,
    codesUpdated: stats.updated || 0,
    duration: stats.duration || 0,
    errors,
  });
  // Keep last 100 runs
  if (log.runs.length > 100) log.runs = log.runs.slice(-100);
  saveLog(log);
}
