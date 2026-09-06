# 🎟 UK Coupon Bot

Automated UK coupon code scraper + browser checker. Scrapes codes from HotUKDeals and VoucherCodes.co.uk, stores them in a JSON database, and shows available codes via a Tampermonkey script when you visit UK stores.

## 🏗 Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   GitHub Actions  │────▶│   JSON Database   │◀────│   Tampermonkey   │
│   (Daily Cron)    │     │  uk-coupons.json  │     │  (Browser Side)  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
         │                        ▲                         │
         ▼                        │                         ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Node.js Scraper │     │  GitHub REST API  │     │  Shows Codes +   │
│   HUKD + Voucher  │     │  Read/Write JSON  │     │  Auto-Fill       │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

## 🚀 Quick Start

### 1. Install the Tampermonkey Script

1. Install [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Open `tampermonkey/UK Coupon Checker.user.js`
3. Click "Install" in Tampermonkey
4. Visit any UK store — codes will appear as a badge in the bottom-right corner

### 2. Run the Scraper Locally

```bash
cd scraper
npm install
npm test          # pipeline + userscript tests
cp .env.example .env
# Edit .env and add your GitHub token (optional for local runs)
node index.js
```

Without a GitHub token, the scraper runs in "dry run" mode and saves locally to `data/uk-coupons.json`.

Useful flags:

| Flag | Effect |
|---|---|
| `--source=savoo` | Run one source only |
| `--no-push` | Write everything locally, push nothing |
| `--emit=FILE` | Scrape only; write raw entries for a later merge (used by CI) |
| `--merge-dir=DIR` | Merge previously emitted entry files, no scraping (used by CI) |
| `--remove=CODE [--store=DOMAIN]` | Remove a code **and tombstone it** so it can't come back |
| `--force` | Override the "code count collapsed" save guard |

### 3. Set Up GitHub Actions (Automatic Daily Scraping)

1. Push this repo to GitHub
2. Go to repo Settings → Secrets and variables → Actions
3. The `GITHUB_TOKEN` is provided automatically by GitHub Actions
4. The workflow runs daily at 6am UTC

Each source runs as its own matrix job and uploads only its raw entries; a
single merge job combines them and commits once. A source that hangs or gets
Cloudflare-blocked fails on its own instead of taking the run with it, and
`index.js` refuses to save if the code count collapses.

To trigger manually: Actions tab → "Scrape UK Coupons" → "Run workflow"

## 📁 File Structure

```
uk-coupon-bot/
├── .github/workflows/scrape.yml   # Daily cron job
├── data/
│   ├── index.json                 # Store index (domain -> code count)
│   ├── stores/<domain>.json       # One file per store — what the script reads
│   ├── dead-codes.json            # Tombstones for reported-broken codes
│   └── uk-coupons.json            # Generated aggregate
├── scraper/
│   ├── index.js                   # Main scraper orchestrator
│   ├── sources/
│   │   ├── hotukdeals.js          # RSS feed scraper
│   │   ├── vouchercodes.js        # HTML scraper
│   │   ├── ggdeals.js             # Gaming cache scraper
│   │   ├── myvouchercodes.js      # Playwright scraper
│   │   ├── savoo.js               # Playwright scraper
│   │   ├── coupert.js             # Playwright scraper
│   │   ├── netvouchercodes.js     # Playwright scraper
│   │   ├── voucherbox.js          # Playwright scraper
│   │   ├── codesuk.js             # Playwright scraper
│   │   ├── latestdeals.js         # Playwright scraper
│   │   └── moneysavingexpert.js   # Playwright scraper
│   ├── lib/
│   │   ├── stores.js              # Canonical domains, aliases, display names
│   │   ├── deadcodes.js           # Tombstones for reported-broken codes
│   │   ├── shard.js               # Writes index.json + per-store files
│   │   ├── normalizer.js          # Code dedup + normalization
│   │   ├── playwright-base.js     # Shared browser logic
│   │   ├── github.js              # GitHub API writer
│   │   └── logger.js              # Scrape run logging
│   ├── scripts/
│   │   ├── test-userscript.mjs    # Browser tests for the userscript
│   │   └── test-pipeline.mjs      # Tests for tombstones, cleaning, sharding
│   ├── package.json
│   └── .env.example
├── tampermonkey/
│   └── UK Coupon Checker.user.js  # Browser userscript
└── README.md
```

## 🗂 Data Layout

The database is **sharded per store**. A single combined file is ~363 bytes per
code, so at 20k codes the userscript would pull ~7 MB from
`raw.githubusercontent.com` every 6 hours just to show a dozen codes.

```
data/
├── index.json          # { domain: codeCount } + alias table — ~22 B per store
├── stores/
│   ├── currys.co.uk.json
│   └── argos.co.uk.json # one file per store, ~1.5 KB average
├── dead-codes.json     # tombstones for reported-broken codes
└── uk-coupons.json     # generated aggregate, for humans and tooling
```

At the current 3,371 stores / 9,020 codes that's a **75 KB index** and ~1.5 KB
per store, against a **5.5 MB aggregate**.

The userscript fetches `index.json` (cached 24h), and only then the one store
file for the site you're on (cached 6h). Per-page cost stays flat however large
the database grows. Daily commits also stay small, because only the stores that
actually changed get rewritten.

`index.json` also carries the **alias table** (`asos.com` → `asos.co.uk`), so
the userscript doesn't keep a hand-synced copy. `scraper/lib/stores.js` is the
single source of truth; the index is generated from it.

## 🚫 Dead Codes

`data/dead-codes.json` is the memory that makes "don't use it again" work.

Without it the loop was self-defeating: removing a reported code did nothing,
because the next scrape found it at the same source and added it straight back.
Now `mergeCodes` refuses to re-add anything tombstoned.

- Keyed `STORE::CODE`, so a code dead at one store can still be live at another
  (use store `*` to block it everywhere).
- Tombstones expire after 180 days — codes do get reissued.
- Added by `--remove`, and by the `failed-code` GitHub issues the userscript
  opens when you thumbs-down a code.

## 📅 Expiry

Codes carry an `expiry` when a source states one, but **an expired code is not
deleted** — retailers routinely leave codes working past the advertised end
date. Instead the userscript ranks expired codes last and tags them in red, so
you can still try one. Only codes more than 90 days past expiry are pruned, to
stop them accumulating forever.

In practice almost no source publishes an end date in the description text, so
this rarely fires today. The staleness signal (no source has listed the code in
21+ days, shown as an amber tag) is the more useful indicator.

## 🔧 Data Schema

Each code entry:

```json
{
  "code": "SAVE20NOW",
  "description": "20% off orders over £50",
  "type": "percentage",
  "value": 20,
  "minSpend": 50,
  "expiry": "2026-08-01",
  "source": "hotukdeals",
  "sources": ["hotukdeals", "vouchercodes"],
  "url": "https://www.hotukdeals.com/vouchers/amazon.co.uk",
  "addedAt": "2026-07-13T12:00:00Z",
  "lastSeen": "2026-07-13T12:00:00Z",
  "testResults": {
    "total": 5,
    "worked": 3,
    "lastTested": "2026-07-12"
  }
}
```

## 🎯 Tampermonkey Features

- **Exact store matching** — the current hostname is resolved against the database
  by exact domain plus an explicit alias table, walking up subdomains so
  `checkout.currys.co.uk` finds `currys.co.uk`. There is no fuzzy fallback.
- **Badge** — code count in the bottom-right corner. Nothing is injected at all
  (no styles, no DOM) on sites that aren't in the database.
- **Code panel** — click the badge for every code with its discount, minimum
  spend, how recently a source listed it, and how many sources agree.
- **Copy + fill** — clicking a code copies it and fills the promo box *if* a
  high-confidence match is found. It never clicks Apply; you do that.
- **👍 / 👎 per code** — thumbs-down hides the code on that store and offers to
  open a prefilled `failed-code` GitHub issue, which the scraper reads on its
  next run and removes.
- **Hide on this site** — persistent per-hostname, survives reloads.
- **Cached** — the database is fetched at most once every 6 hours.

### What v2 deliberately does not do

v1 tried to drive the whole checkout — find the promo box, find the Apply
button, click it, then read the page text to decide whether the code worked.
Each step was a guess, and a wrong guess could click "Place order". Removed in
v2: auto-apply, auto-try-all, page-text result detection, savings tracking, the
notification toast, panel dragging, and the in-page self-updater.

## 🤝 Contributing

1. Fork the repo
2. Add codes or improve scrapers
3. Submit a PR

Or just report failed codes via the Tampermonkey script — it creates GitHub Issues automatically.

## 📊 Sources

| Source | Method | UK Focus | Codes/Run | Notes |
|--------|--------|----------|-----------|-------|
| HotUKDeals | RSS | ✅ | 15-20 | Fast, community-voted |
| VoucherCodes.co.uk | HTML | ✅ | 30-40 | Reliable UK retailer codes |
| GG.deals | Playwright (headful) | 🎮 | 200+ | Gaming stores, scraped live |
| MyVoucherCodes | Playwright | ✅ | 80-100 | Dynamic JS rendering |
| Savoo | Playwright | ✅ | 100+ | Best UK coverage |
| Coupert | Playwright (headful) | 🌍 | 100+ | 20 verified store slugs |
| NetVoucherCodes | Playwright | ✅ | 0-10 | May have browser issues |
| Voucherbox | Playwright | ✅ | 5-10 | UK exclusive codes |
| Codes.co.uk | Playwright | ✅ | 10-15 | Daily updated |
| LatestDeals | Playwright | ✅ | 1-5 | Community-posted codes |
| MoneySavingExpert | Playwright | ✅ | 1-3 | Curated list |

**Retired sources:** Honey (bot protection), Vouchercloud (Cloudflare), RetailMeNot (no codes), Wowcher (browser crashes)

## ⚠️ Notes

- Codes are scraped from public sources — no warranty on validity
- Some codes may be targeted/expired — use the "Report Failed" button to help clean up
- The scraper respects rate limits (1.5-2s between requests)
- Codes older than 90 days are automatically pruned
- **Bot protection:** Coupert and GG.deals sit behind Cloudflare, which serves
  headless Chrome — old *or* new — an endless "Just a moment..." page. Both are
  scraped with a **headful** browser instead, which loads normally. CI has no
  display, so the workflow runs the scrape under `xvfb-run`.

  ```
  headless (default)   ->  challenged
  headless=new         ->  challenged
  headful              ->  loads normally
  ```

  Running a source locally works without `xvfb` — a browser window will open.
- **No API keys.** An earlier version routed Coupert and GG.deals through
  Firecrawl. That key expired, and because the GG.deals pre-fetch only logged
  the error and carried on, the scraper served a cache frozen since
  2026-07-13 while still refreshing each code's `lastSeen` — so long-dead codes
  looked current. Both now scrape live and the dependency is gone.

## 📝 License

MIT — do what you want with it.
