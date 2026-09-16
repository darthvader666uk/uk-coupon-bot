# Coupon sources and apply strategies: research brief, 2026-09-16

Context: Coupert was found burning ~49% CPU in the Firefox extensions process on idle
tabs (it injects seven scripts into every http/https page). The Tampermonkey checker
already wins on cost. Where it loses is (1) code coverage and (2) knowing whether a
code worked. This brief covers what was found for both.

## 1. Caramel public coupon API (new source, no Playwright needed)

Caramel (github.com/DevinoSolutions/caramel, AGPL-3.0, 139 stars, pushed 2026-09-16) is
the open-source Honey alternative that is actually maintained. Syrup (769 stars) was
archived June 2025. OpenCoupon is a 13-star framework, last push April 2026.

Its coupon catalogue is served by an unauthenticated JSON endpoint:

```
GET https://grabcaramel.com/api/coupons?site=<registrable domain>&limit=50&page=1
```

Tested 2026-09-16: currys.co.uk 39 codes, boots.com 38, asos.com 22. Record shape:

```json
{
  "id": "17855",
  "code": "LKA10R",
  "site": "currys.co.uk",
  "title": "Currys Coupon: £10 Off At Checkout",
  "description": "Save £10 off on the Marked Price on All Large Kitchen Appliances £249 and Over",
  "rating": 4.1,
  "discount_type": "CASH",
  "discount_amount": 10,
  "expiry": "-",
  "expired": false,
  "timesUsed": 0,
  "status": "retry",
  "verificationMessage": "Verification timed out after 120s",
  "lastWorkedAt": null
}
```

Notes from reading `apps/caramel-app/src/app/api/coupons/route.ts`:

- `site` is resolved through the Public Suffix List, so `co.uk` stores work (they fixed
  a bug where `mymemory.co.uk` collapsed to `co.uk`). Pass the registrable domain.
- `limit` capped at 50, `page` capped at 500, `search` and `key_words` params exist.
- 60s edge cache, rate limit tier `read`. The page cap comment says it is there so
  "scrapers can't walk the catalog indefinitely": per-store queries at a polite rate
  are clearly the intended use, a full-catalogue walk is not.
- `status` / `verificationMessage` / `lastWorkedAt` come from their own verification
  pipeline and extension reports. `lastWorkedAt` non-null is the strongest signal in
  any source found.
- Other routes: `/api/coupons/stores` (list of sites, paged), `/api/coupons/[id]/report`
  and `/api/coupons/increment` (extension feedback, probably wants an extension token,
  not tested).

Recommended integration: a scraper source `caramel.js` that hits `?site=` for each domain
already in `data/index.json`, ~1 req/s, once a day. 955 stores is ~16 minutes. Keep it
scraper-side rather than calling from the userscript so no store visit is reported to a
third party. Map `discount_type` CASH / PERCENT and `discount_amount` straight into the
existing schema, and carry `lastWorkedAt` through as a trust field for the panel.

## 2. Awin Offers API (the codes retailers actually honour)

Awin is the largest UK affiliate network and Currys, Boots, Argos, ASOS, John Lewis
etc all publish their voucher codes through it. Publishers can pull promotions and
codes for advertisers they are NOT joined to as well as ones they are:

```
POST https://api.awin.com/publisher/{publisherId}/promotions
Authorization: Bearer <api token>
```

Docs: https://help.awin.com/apidocs/promotions. Needs a publisher account (free, needs a
site to be approved against, the GitHub Pages repo would do). These codes are
first-party, dated, and regioned, so they would be the highest-quality source in the
database by a wide margin. Worth the application form.

## 3. How Coupert applies codes (from its XPI, v6.50.58)

Pulled from `appledev@soarinfotech.com.xpi` in the Firefox profile.

Cost and permissions, for the README comparison:

- MV2 with a persistent background page. Content scripts `vendor.js, components.js,
  guide.js` at `document_start` and `vendor.js, components.js, contentFunc.js,
  content.js` at `document_end`, on `http://*/*` and `https://*/*`. 3.1 MB of JS per
  page load.
- Permissions: `cookies`, `webRequest`, `webRequestBlocking`, all hosts. That is the
  same capability set the Honey affiliate-cookie story was about.
- Code source is `POST https://www.coupert.com/api/v2/coupon/list` through a signed
  request helper. Not usable from outside without reversing the signing, and it would
  be their ToS. Scraping `uk.coupert.com/promo-code/{slug}` as now is the right route.

Apply strategy, two tiers. This is the part worth copying in spirit:

Tier A, per-merchant cart API recipes. For big platforms Coupert never touches the
DOM. Each merchant has a JSON recipe: endpoint, headers (with an `{{authToken}}`
placeholder pulled from the page), body template with `{{promoCode}}`, and a small
pipe language (`get path`, `find field eqVar`) to read `successCondition`, `startPrice`,
`endPrice` and `error` out of the JSON response. Examples seen in the bundle:

| Platform | Apply endpoint / body | Success and price paths |
|---|---|---|
| Salesforce Commerce Cloud | body `{"c_addCouponCode":"{{promoCode}}","c_isCheckout":true}` | success `basketId`, start `productSubTotal`, end `orderTotal`, error `statusMessage` |
| MediaMarkt GraphQL | `GetBasket` operation, `apollographql-client-name` headers | success `data.basket.coupons[].code == promoCode`, end `data.basket.payment.amountToPay.price` |
| Shopify | `/cart`, `/cart/add`, `cart_token`, `/checkout/promotion/add` | (cart JSON totals) |
| Generic paths seen | `/cart/apply-coupon`, `/cart/remove-coupon`, `/checkout/backend/coupons/apply-coupons`, `/api/account/basket/vouchers`, `/api/checkout/vouchers`, `/api/orders/ordersummary` | |

Because the result is read from the cart API response, not page text, there is no
"did it work" guessing and no risk of clicking the wrong button. That is the answer
to the problem that got auto-apply removed in v2: start with ONE platform recipe
(Shopify is the obvious one, it covers most UK indie stores and `/cart.js` is a stable
public JSON endpoint), apply through the cart API, compare `total_price` before and
after, and remove the code afterwards. Never touch a button.

Tier B, generic DOM fallback. A single multilingual regex over input, button and label
attributes:

```
coupon|promo|discount|voucher|gift.?card|redeem|apply|submit|remove|code|savings
```

plus French, Portuguese and Chinese equivalents. Checkout page detection is a keyword
list on URL and DOM: `cart`, `checkout`, `basket`, `payment-information`,
`order_total_amount`, `baskettotal`. Nothing cleverer than what v1 had, which is why
the recipes exist.

## 4. Caramel's extension code worth reading

`apps/caramel-extension/` (AGPL-3.0, so copy ideas freely, copy code only if the
userscript can be AGPL too):

- `cart-signals.js` (178 lines): `CART_ITEM_SELECTORS`, `ITEM_TITLE_SELECTORS`,
  `extractJsonLdProductNames()` (reads `application/ld+json` Product entries),
  `tryShopifyCart()` (fetches `/cart.js`). Clean, small, tested.
- `store-detect.js`: hostname to store resolution.
- `coupon-apply.js` (~800 lines): `applyCoupon()`, `removeAppliedCoupon()`,
  `detectCouponError()` with a baseline snapshot of the coupon area text before and
  after, `caramelPostNavigationVerdict()` for stores that reload on apply, and a
  15-minute `caramel_tried_codes` cache so it never re-tests a code. Their error
  detection is still page-text based but it diffs against a pre-apply snapshot rather
  than reading the whole page, which is what made v1 unreliable.
- `tests/*.test.mjs`: `empty-cart-guard`, `existing-cart-discount`, `spa-cart-rerun`,
  `cart-capability-gate`. A ready list of the edge cases that bite.
- `apps/caramel-app/src/lib/cartClassifier.ts` plus `evals/`: they use an LLM to
  classify whether a page is a cart at all. Overkill here, but it says the keyword
  approach was not good enough for them either.

## 5. What Reddit says (Sept 2026)

- r/UKPersonalFinance, Jan 2025, 277 pts, 124 comments: after Honey nobody trusts a
  coupon extension. Top advice is retailer newsletters and bank cashback (NatWest,
  Barclays, Airtime Rewards auto-activate). No open-source tool mentioned.
- r/RequestASite, Aug 2026: astroturfed (AutoModerator pushes Couponly). The only
  real replies, all scored 1, say the same three things: don't run on every page,
  actually find working codes, don't touch affiliate links. v2 already does all three.
- Caramel launched on r/firefox and r/Safari (mid 2025) and is the one people link.

## 6. Suggested order

1. `scraper/sources/caramel.js`: plain HTTP, no browser, biggest coverage gain for
   least code. Carry `lastWorkedAt` into the schema.
2. Apply for an Awin publisher account. Slow, but it is the only first-party source.
3. Shopify cart-API recipe in the userscript, gated to hosts where `/cart.js` returns
   JSON, compare totals, remove the code after. Log results back as 👍 / 👎.
4. Read Caramel's `tests/` list before writing the recipe. Empty cart, existing
   discount, and SPA re-run are the three that will bite first.
