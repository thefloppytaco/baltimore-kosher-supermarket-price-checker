# Design: two-store grocery price compare

A Muse web artifact (TypeScript space) that keeps a persistent product
catalog for two grocery stores and answers, from that catalog: what an
item costs at each store (watchlist), what a whole shopping list or
recipe costs at each store, what a scanned barcode costs at each
store, what's on special, and what's new — with like-for-like
comparisons only (the same kind of product at both stores), per-unit
pricing, multi-buy deals stated as deals, and by-weight prices kept
per pound end to end.

Everything runs on Muse itself: no third-party scraping APIs, no
extra API tokens, no secrets. The only external endpoints are the two
stores' own surfaces and Open Food Facts (keyless).

## Retargeting this space at two other stores

All store identity lives in **`server/src/stores.ts`** — the single
store config. Each store entry carries: `key` (stored in the
database), display `name`, `short` label, `colorVar` (a CSS variable
in `client/src/theme.css`), `homepage`, `flyerUrl` + `flyerLabel`,
`access` mode (`"api"` or `"browser"`), and `spotCheck` support.

The config is consumed by:

- `server/src/schema.ts` — every store column's drizzle enum is
  `STORE_KEYS` from the config.
- `server/src/actions.ts` — every Zod schema names stores via
  `storeEnum`/`winnerEnum` derived from `STORE_KEYS`; internal code
  addresses stores as `API_STORE.key` / `BROWSER_STORE.key`, never by
  literal; verdict text and all prose derive names from `STORES`.
- `client/src/App.tsx` — imports the same config (names, colours,
  homepages, flyer links, suggestion chips, the example brand, the
  spot-check panel's store) and renders server-computed verdicts and
  pair winners verbatim; the client never re-derives a verdict.
- The browser-agent prompts in `actions.ts` name the artifact by
  `ctx.slug`, never by a hard-coded slug.

Locale knobs live in the same file: `LOCALE` (IANA `timeZone` —
must match the timezone written in the managed cron schedules in
`space.json`, which are platform data — `language`, `currency`,
`currencySymbol`), `SUGGESTION_CHIPS`, `EXAMPLE_BRAND`, and
`HOLIDAY_WORDS` (the holiday vocabulary the Shop's aisle mapping
treats as seasonal). To rebuild this space elsewhere: pick the two
stores, probe them (below), write their config entries and adapter
settings, and the rest follows.

## Architecture

- React client (`client/src/App.tsx`), Bun server actions
  (`server/src/actions.ts`, ~25 actions), Drizzle over the
  platform SQLite (`ctx.db`). Pure matching/pricing logic is split
  into `server/src/lib.ts` (no DB, no fetch) with unit tests in
  `server/src/lib.test.ts` (`bun test`).
- Tables: `watch_items`, `snapshots` (latest result set per
  item×store), `catalog_products` (both stores; per-item price
  invariant, deal fields, `size_text`, `price_text`, category,
  first/last seen), `price_history` (one row per observed price/sale
  change — prices are recorded, never silently overwritten),
  `catalog_sync` (per-store build state), `catalog_sections` +
  `catalog_section_products` (the browser store's sweep queue and its
  coverage join), `spot_checks` (latest accuracy check), 
  `barcode_mappings` (scan cache/history), `cart_items` (the shopping
  list), `brand_preferences` (item keyword → preferred brand).
- Managed crons (space.json): catalog sync daily 06:30, watchlist
  refresh daily 07:15, browser-sweep watchdog hourly — all in the
  `LOCALE.timeZone` zone.

## Data flows and cadence

- **API store** (direct fetch): a full-catalog crawl through the
  store's own JSON API (see adapter notes). Upserts by SKU preserve
  first-seen dates and log price changes to `price_history`. SKUs a
  crawl doesn't see are **not** deleted — a short page must never
  silently discontinue products; unseen rows age out of the serve
  window (32 days) on their own. Live per-query fetches serve catalog
  misses and forced re-checks.
- **Browser store** (agent sweep): the store is bot-walled for direct
  fetch, so background browser agents (`ctx.agent.spawnTask`) sweep a
  section queue: one sitemap-discovery section seeds one section per
  leaf category, plus specials, staple searches, and one watch
  section per watchlist item. Agents save each section as they finish
  it via `saveCatalogResults`/`saveDiscoveredCategories`, and every
  save chains the next batch. Agents are always told the artifact's
  slug from `ctx.slug`.
- **Sweep completeness contract**: a section is complete only when
  the DISTINCT products linked to it (`catalog_section_products`)
  reach the total the store itself reported for that page
  (`expectedCount`). Short-but-still-gaining sections re-queue (max
  passes); a stall finishes the section WITH the shortfall recorded
  and surfaced — a short sweep never reads as a complete one. Stale
  claims (>10 min without a save) are reaped; after 3 timed-out
  attempts a section lands in `error` and retries on the next sync.
  Removing a watchlist item also removes its watch section and its
  section-product links from the queue.
- **Cadence**: specials re-check weekly at both stores (the API
  crawl carries sale flags; the browser store resets its specials +
  discovery sections weekly); ordinary prices roll through a monthly
  re-check (the browser store resets the oldest quarter of its
  remaining sections weekly, sections whose products still lack a
  package size first — that's also the size backfill order); new
  products/categories are picked up by the weekly passes.
- **Serving**: board lookups read the catalog first (token match,
  relevance-scored — see below); snapshots re-pick headline products
  and verdicts at read time, so matching fixes apply to saved cards
  without a re-check.
- **Accuracy**: a spot check samples the API store's catalog
  (spread + on-sale + deal products), re-fetches each live, records
  stored-vs-live price and sale flag, and heals mismatches from the
  live values (logging the correction to `price_history`).
- **Barcodes**: decoded in the browser (ZXing; camera, photo, or
  typed digits as fallbacks) → local `barcode_mappings` cache → Open
  Food Facts `api/v2/product/<digits>.json` (keyless; returns
  product_name/brands/quantity/image_url) → priced from the catalog.
  An unknown barcode is never guessed: the user names the product
  once and the mapping is cached as `manual`.
- **List/recipe pricing**: pasted text is parsed into buyable items
  by `ctx.inference.complete` (bounded transformation over
  user-supplied text; local line-parser fallback). Each item is
  quoted per store from the catalog machinery; saved brand
  preferences are quoted first, even when pricier, with the cheaper
  alternative and its cost shown; a store that doesn't carry the
  preferred brand says so. Totals sum only lines both stores priced
  with directly comparable products.

## Matching and pricing rules (lib.ts)

- **Per-item invariant**: a stored `price` is always the price of ONE
  item. A multi-buy deal is kept in `deal_text/deal_qty/deal_total/
  regular_price`; per-unit math runs on the per-item price; cart
  totals charge full bundles at the bundle total and leftovers at the
  regular price when known.
- **Deals** (`parseDealText`): "N for $X" / "N/$X" (displayed price =
  bundle total), "Buy X get Y free", "BOGO", "% off" variants
  (displayed price = single-item price). Unparseable wording is
  dropped, never guessed.
- **By-weight pricing** (`priceBasisOf`): a price is per-lb/per-oz
  ONLY from per-weight wording in the store's price text (or an
  explicit "/ lb" / "per lb" in size text/name). A bare package size
  in a name ("Family Pack Chicken 3 Lb") never makes a product
  per-pound. Weight-priced products display "$X/lb", compare via $/oz,
  get per-pound verdict speech, and are NEVER compared against a
  package price. List lines cost per-lb quotes at the pounds asked
  for (1 lb when unstated) and packaged quotes at whole packages;
  cart quantities for weight-priced rows count pounds/ounces.
- **Sizes** (`parseSize`): oz/lb/gal/qt/pt/L/ml/ct families, fractions
  ("1/2 Gal"), multipacks ("12×12 Oz" = 144 oz total). Per-unit =
  per-item price ÷ parsed size.
- **Relevance** (`scoreMatch`/`scoredEntries`): word-level matching
  with singular/plural folding ("egg" ≠ "eggplant"); the query words
  should be the product's head noun — content words trailing the
  match cost score; name purity (share of the name that is the item
  itself) sinks products that merely end with the query phrase; an
  "in/with" penalty demotes packing-medium mentions ("tuna in olive
  oil"); variant words (chocolate, spray…) demote variants not asked
  for; category agreement votes the item's aisle from mostly-pure
  candidates and adjusts scores. `pickBest` lets only the top
  relevance tier compete for a headline slot, and when the tier's
  most relevant product has no unit price, the tier's lowest LISTED
  price represents the store (plainly-named standard products often
  carry no size).
- **Catalog matching** (`catalogMatch` in actions.ts): the SQL stage
  fetches every row matching the query tokens with NO pre-scoring row
  cap — scoring sees all candidates, then the result is sliced.
  (A limit applied before scoring lets a popular token crowd out the
  right product.)
- **Comparable pairing** (`pairSignature`/`pairProducts`): a kind
  signature = query words + grade descriptors + variant words +
  vocabulary both stores share for the query (sizes, glue, "(Brand)"
  notes, and one-store-only brand words drop out; "organic" is a
  production method, not a kind). Only kinds present at BOTH stores
  compare; watchlist verdicts run on the top pair only. Junk guards:
  a bare signature needs a mostly-pure name, and an off-aisle impure
  product is vetoed. The finder returns all pairs and nothing else;
  the Shop shows everything, badging unpaired products
  "<Store> only".
- **Verdicts** (`verdictFor`): same unit family → per-unit compare;
  weight-priced on either side → per-pound speech, or no verdict when
  the two can't be compared unit-for-unit; otherwise listed price.
  Verdict strings derive store names from the config. Pair winners on
  cards and in the finder are computed by this same function on the
  server and shipped in the response — the client renders them.
- **Shop aisles** (`aisleForCategory`): both stores' raw category
  names map onto 14 shared supermarket aisles by word-level,
  plural-folded keyword rules (staple rules before Dairy & Eggs, so
  "peanut butter"/"egg noodles" land in Pantry; "ice cream" in
  Frozen; holiday words from `HOLIDAY_WORDS`). Unrecognized/missing
  categories land in Pantry & Grocery, the catch-all. Products keep
  displaying their store's own category name; only the browse
  structure is normalized.
- **Cart prices come from the catalog only**: `addToCart` re-resolves
  name/price/category/deal/basis from the catalog row and REFUSES a
  product the catalog doesn't know — a caller-supplied price is never
  used.

## Adapter notes

### MyCloudGrocer stores (access: "api") — e.g. Market Maven

- Product API: `POST https://www.marketmavenmd.com/api/AjaxFilter/JsonProductsList?pageNumber=N&q=<query>`
  with body `[]`, header `Content-Type: application/json`,
  `x-requested-with: XMLHttpRequest`. No auth, no ZIP. ~2s per query.
  Response: `productsCount` plus `productsJson` (a JSON string of
  rows). 120 products per page.
- **Whole-catalog trick**: a single-letter query (`q=a`) returns the
  ENTIRE catalog (~7,700 products, ~65 pages, no SKU overlap between
  pages; the search is effectively unfiltered at one character). A
  nonsense query returns count −1. The crawl pages through all of it
  with a small worker pool (~30s) — this one pass is the store's
  weekly specials check, monthly price check, and new-product
  detection at once.
- Row fields: `N` name (sizes embedded, e.g. "…, 24 Oz"), `P` price
  text ("$5.00", or "$2.49 / lb" for weighted items), `P_v` numeric
  price, `O` regular single-item price when on special ("$1.45";
  weighted: "$9.49 / lb"), `PQ` how many items `P` covers — PQ=4 with
  P="$5.00" renders on the storefront as "4 for $5.00" and `P` is the
  BUNDLE total, so per-item = P_v ÷ PQ (a full-catalog audit found 33
  PQ>1 products; every bundle total divided to an exact-cent per-item
  price), `SP` on-special flag, `SKU`, `CN` category name, `CatId`,
  `iU` image filename (served from
  `https://marketmavenmd.com/api/content/images/thumbs/<iU>`),
  `BOGO_BuyQty`/`BOGO_GetQty`/`BOGO_OfferPercentage` (present in
  every row, empty across the whole catalog at audit time; parsed
  defensively). `SPR`/`SPRDN` on a few rows is a weekday marker, not
  pricing.
- Probing a candidate MyCloudGrocer store: POST the endpoint with
  `q=a` and check `productsCount` ≈ the store's full catalog; POST a
  nonsense query and expect −1.

### stor.ai / Selfpoint stores behind Cloudflare (access: "browser") — e.g. Seven Mile

- Direct fetch is blocked (Cloudflare managed challenge, HTTP 403
  from server egress; `/sitemap.xml` and `/api/products` close the
  connection). A real browser session is the only route — exactly
  what the spawned indexing agent provides. Search snippets cannot
  supply shelf prices.
- Coverage map: the store's own sitemap page
  `https://www.shopsevenmilemarket.com/sitemap` lists the full
  category tree (~370 leaf links of the form
  `/categories/<id>/products`, e.g. Milk =
  `/categories/78154/products`). Search and category pages display
  totals (result counts; facet counts that sum to the page total) —
  those are the `expectedCount` targets coverage is checked against.
- **Tile anatomy**: every listing tile prints a small grey
  **"Brand | size" line directly ABOVE the product name** ("Paskesz |
  10 Oz" over "Mini White Chips"). The size is NOT in the name, and
  the product detail modal repeats the same line and adds nothing.
  Size variants are separate tiles, never selectable variants (one
  name at 1 Oz and 2.75 Oz is two products — dedupe is name+size).
  A few tiles genuinely show no size line; those stay honestly
  size-less. The indexing prompt makes recording that line's size
  into `sizeText` mandatory per product — omitting it is how a
  catalog ends up 75% size-less.
- The indexing prompt also requires: per-weight prices recorded with
  their full displayed price text ("$7.99 / Lb") in `priceText`, with
  `price` as the per-pound amount; multi-buy wording copied verbatim
  into `dealText` with `price` as the displayed amount (the server
  does the deal arithmetic); the page's displayed total as
  `expectedCount`; NO per-assignment product cap; and a separate save
  per assignment as soon as it finishes.
- Probing a candidate store: expect 403 on a plain fetch of the
  homepage; confirm `/sitemap` renders in a browser task and exposes
  `/categories/<id>/products` links.

### Flyers

- Market Maven's weekly flyer is a stable circular page,
  `https://marketmavenmd.com/Baltimore/circular` (content rotates,
  URL stable; verified live, dated ranges shown on the page). Its
  shoppable specials category is
  `https://marketmavenmd.com/Baltimore/category/specials`.
- Seven Mile's stable specials address is its specials department,
  `https://www.shopsevenmilemarket.com/specials` (verified live). Its
  weekly flyer PDF is linked from the site footer via a rotating
  hosted-file URL that could not be verified as stable week-to-week,
  so the specials page is the permanent link. Both links live in the
  store config (`flyerUrl`); the UI notes a flyer shows only part of
  a store's specials.

## Honesty rules

- Never invent a price, a sale, or a size. A sale shows only when the
  store itself marks it (badge, strikethrough, specials page, `SP`
  flag). A size shows only when the store prints one.
- Every price carries the date it was actually seen at the store
  ("Checked …"), rendered in `LOCALE.timeZone`; stale data is
  labeled, never presented as current.
- When a store can't be checked, the surface says so ("couldn't
  check", "pending", an honest empty state) instead of filling the
  gap with plausible rows.
- A comparison never crosses kinds, and a per-pound price never
  faces a package price; when no honest verdict exists, none is
  shown and the UI says why.

## Rejected approaches

- **Direct fetch / curl to the browser store** (both hostnames, plus
  stor.ai subdomain guesses): Cloudflare 403/closed from server
  egress. Only a real browser session passes.
- **Web search for the browser store's prices**: returns generic web
  results with no shelf prices — would force invented numbers.
- **Third-party scraping APIs** (an earlier project read this store
  through a scraping service over search snippets): explicitly out —
  the artifact must run on Muse alone so it can be packaged for
  other people's Claudes with no tokens.
- **Scraping the API store's HTML**: it's a JS SPA with an empty
  shell; its own JSON API returns structured prices in ~2s.
- **Native BarcodeDetector** for scanning: unsupported on Safari;
  ZXing in the browser works everywhere, with photo upload and typed
  digits as fallbacks.

## Packaging for a public repo

Ship source only: `client/src`, `server/src` (including
`lib.test.ts`), `drizzle/`, `space.json` (slug templated), 
`package.json`, `tsconfig*.json`, `bunfig.toml`, this file, a README,
and a SKILL.md for the rebuilding Muse (probe both stores per the
adapter notes → fill `stores.ts` → create the space through the
web-artifact builder → first open auto-builds the catalog: the API
store in ~a minute, the browser store over days of chained sweeps —
set that expectation). Exclude: `app.db*`, `audits/`, `.harness/`,
`.space-build*`, `client/dist*`, `server/dist`, `node_modules`,
`bun.lock` (the SDK is a `file:` tarball whose path differs per
machine).
