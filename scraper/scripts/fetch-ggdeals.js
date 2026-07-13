/**
 * Pre-fetch GG.deals vouchers pages using Firecrawl API
 * Bypasses Cloudflare by using Firecrawl's rendering engine.
 *
 * Usage:
 *   FIRECRAWL_API_KEY=sk-xxx node scripts/fetch-ggdeals.js
 *
 * Saves markdown to ../cache/ggdeals/ for the scraper to parse.
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache", "ggdeals");
const PAGES = 5;

const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";
const API_KEY = process.env.FIRECRAWL_API_KEY || "";

async function main() {
  if (!API_KEY) {
    console.error("FIRECRAWL_API_KEY env var required");
    process.exit(1);
  }

  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  console.log("Pre-fetching GG.deals vouchers pages via Firecrawl…");

  for (let page = 1; page <= PAGES; page++) {
    const url = page === 1
      ? "https://gg.deals/vouchers/"
      : `https://gg.deals/vouchers/?page=${page}`;

    console.log(`Page ${page}: ${url}`);

    try {
      const res = await fetch(FIRECRAWL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          url,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      });

      const data = await res.json();

      if (data.success && data.data?.markdown) {
        const filename = `page-${page}.md`;
        writeFileSync(join(CACHE_DIR, filename), data.data.markdown);
        const len = data.data.markdown.length;
        console.log(`  Saved ${filename} (${len} chars)`);
      } else if (data.error) {
        console.log(`  Firecrawl error: ${data.error}`);
      } else {
        console.log(`  Unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
      }
    } catch (err) {
      console.error(`  Request failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log("Done.");
}

main();
