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
cp .env.example .env
# Edit .env and add your GitHub token (optional for local runs)
node index.js
```

Without a GitHub token, the scraper runs in "dry run" mode and saves locally to `data/uk-coupons.json`.

### 3. Set Up GitHub Actions (Automatic Daily Scraping)

1. Push this repo to GitHub
2. Go to repo Settings → Secrets and variables → Actions
3. The `GITHUB_TOKEN` is provided automatically by GitHub Actions
4. The workflow runs daily at 6am UTC

To trigger manually: Actions tab → "Scrape UK Coupons" → "Run workflow"

## 📁 File Structure

```
uk-coupon-bot/
├── .github/workflows/scrape.yml   # Daily cron job
├── data/uk-coupons.json           # The coupon database
├── scraper/
│   ├── index.js                   # Main scraper orchestrator
│   ├── sources/
│   │   ├── hotukdeals.js          # HotUKDeals RSS scraper
│   │   └── vouchercodes.js        # VoucherCodes.co.uk scraper
│   ├── lib/
│   │   ├── normalizer.js          # Code dedup + normalization
│   │   ├── github.js              # GitHub API writer
│   │   └── logger.js              # Scrape run logging
│   ├── package.json
│   └── .env.example
├── tampermonkey/
│   └── UK Coupon Checker.user.js  # Browser userscript
└── README.md
```

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

- **Auto-detect** — matches current store against database
- **Badge** — shows code count in bottom-right corner
- **Code panel** — click badge to see all codes with descriptions
- **Copy + Auto-fill** — click a code to copy it and auto-fill checkout input
- **Report Failed** — click "Not working" to report a bad code via GitHub Issue
- **Cached** — stores data locally for 6 hours to avoid hammering GitHub

## 🤝 Contributing

1. Fork the repo
2. Add codes or improve scrapers
3. Submit a PR

Or just report failed codes via the Tampermonkey script — it creates GitHub Issues automatically.

## 📊 Sources

| Source | Method | Coverage |
|--------|--------|----------|
| HotUKDeals | RSS feed | Community-voted UK deals |
| VoucherCodes.co.uk | HTML scrape | Major UK retailers |
| More sources planned | — | MyVoucherCodes, Savoo |

## ⚠️ Notes

- Codes are scraped from public sources — no warranty on validity
- Some codes may be targeted/expired — use the "Report Failed" button to help clean up
- The scraper respects rate limits (1-2s between requests)
- Codes older than 90 days are automatically pruned

## 📝 License

MIT — do what you want with it.
