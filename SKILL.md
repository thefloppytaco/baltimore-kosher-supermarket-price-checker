# Build a two-store supermarket price checker

Build a Muse web artifact (TypeScript space) that keeps a persistent
product catalog for two grocery stores and answers, from that catalog:
what an item costs at each store, what a whole shopping list or recipe
costs at each store, what a scanned barcode costs at each store, what's
on special, and what's new — with like-for-like comparisons only.

The repo ships the working example (Market Maven vs Seven Mile Market,
Baltimore) as the template. Retarget it at any two stores by changing
the config — the code never names a store anywhere else.

## Constraints — read first

- **Everything runs on Muse alone.** No Apify, no third-party scraping
  APIs, no extra API tokens, no secrets. The only external endpoints are
  the two stores' own surfaces and Open Food Facts (keyless).
- **Build only through the web-artifact tools. Never `bun run build`.**
  Do not hand-edit anything under `.space-build/`.
- **Never invent a price, a sale, or a size.** A sale shows only when the
  store itself marks it (badge, strikethrough, specials page, sale flag).
  A size shows only when the store prints one. Every price carries the
  date it was actually seen at the store ("Checked …"). When a store
  can't be checked, the surface says so instead of filling the gap with
  plausible rows.
- A comparison never crosses kinds, and a per-pound price never faces a
  package price; when no honest verdict exists, none is shown and the UI
  says why.

## Step 1 — Confirm the two stores and their platforms

Probe each candidate store before writing any config. The adapter notes
in `docs/DESIGN.md` describe both platform patterns:

- **MyCloudGrocer-style store (direct API):** `POST
  https://<store>/api/AjaxFilter/JsonProductsList?pageNumber=1&q=a`
  with body `[]` and header `Content-Type: application/json`. A
  one-letter query should return the store's whole catalog
  (`productsCount` in the thousands); a nonsense query should return
  count −1. Confirm the row fields: `N` name, `P` price text, `P_v`
  numeric price, `O` regular price, `PQ` how many items `P` covers
  (PQ=4 with P="$5.00" is "4 for $5.00" — the bundle total, not one
  item's price), `SP` on-special flag, `SKU`, `CN` category, `iU`
  image filename.
- **stor.ai / Selfpoint store behind Cloudflare (browser only):** expect
  HTTP 403 on a plain fetch of the homepage from server egress. Confirm
  in a **browser task** that `/sitemap` renders and exposes the full
  category tree as `/categories/<id>/products` links, and that listing
  tiles print a small grey "Brand | size" line directly above the
  product name (that line — not the name — is where the size lives).

If a store fits neither pattern, stop and say so — do not force it into
an adapter.

## Step 2 — Fill the store config

All store identity lives in **`server/src/stores.ts`** — the single
store config. Each entry carries: `key` (stored in the database),
display `name`, `short` label, `colorVar` (a CSS variable in
`client/src/theme.css`), `homepage`, `flyerUrl` + `flyerLabel`,
`access` mode (`"api"` or `"browser"`), and `spotCheck` support
(API stores only).

Also set the locale knobs in the same file: `LOCALE` (`timeZone` —
must match the timezone written in the managed cron schedules in
`space.json` — `language`, `currency`, `currencySymbol`),
`SUGGESTION_CHIPS`, `EXAMPLE_BRAND`, and `HOLIDAY_WORDS` (the
holiday vocabulary the Shop's aisle mapping treats as seasonal).

Replace `__SPACE_SLUG__` in `space.json` (slug and cron-job ids) and in
`client/index.html` with the new space's slug, and rename the space
(`name` in `space.json`, `<title>` in `client/index.html`).

## Step 3 — Create the space from this repo

Create the space through the web-artifact builder using this repo's
source (`client/src`, `server/src`, `drizzle/`, `space.json`,
`package.json`, `tsconfig*.json`, `bunfig.toml`, `icon.webp`). The
builder installs dependencies (the SDK is a machine-local `file:`
tarball — never ship or hand-edit `bun.lock`) and runs the migrations.
Typecheck both projects (`bun x tsc --noEmit -p client/tsconfig.json`
and `-p server/tsconfig.json`) and run the unit tests (`bun test`
in `server/src/lib.test.ts` — 32 tests over the pure matching/pricing
functions: `parseSize`, `priceBasisOf`, `withUnit`, `parseDealText`,
`scoreMatch`, `pickBest`, `verdictFor`, `pairProducts`,
`aisleForCategory`, `listLineCost`).

## Step 4 — First run: build the catalog

The first open auto-fires `syncCatalog`. Set expectations honestly:

- **API store:** full catalog in ~1 minute (the one-letter query,
  paged, a small worker pool).
- **Browser store:** days. A sitemap-discovery section seeds one
  section per leaf category; background browser agents sweep them,
  saving each section as they finish it, and every save chains the
  next batch. An hourly watchdog reaps stalled sections.

## The sweep contract (background_sweep_completeness)

The browser store's sweep is a work queue (`catalog_sections`), and a
section is complete only when the DISTINCT products linked to it reach
the total the store itself reported for that page
(`expectedCount`):

- Record an attempt count, a start time, and a last save time for
  every section before starting it. Treat a section with no save for
  ten minutes as presumed dead, requeue it with the reason recorded,
  and keep later sections moving. Mark a section as a visible error
  after three failed attempts, and keep the error from blocking the
  rest of the sweep.
- Walk the source category tree instead of a fixed list of search
  terms, so coverage does not depend on keywords guessed. Remove any
  per-search cap on saved items, or record the cap in the section
  status when a cap must stay. Never mark a section done only because
  it reached a cap, and never report a sweep complete while any
  section sits at a cap. Save each section as soon as it finishes, so
  a later stall cannot lose finished work.
- Compare the saved count with the source total and record any
  shortfall in the section status. Requeue a short section while it is
  still gaining items, and stop when a fresh pass adds nothing. Treat
  the source total as a cross check rather than gospel, since a source
  can overstate its own total.
- Show attempts, last failure, and shortfalls on the board instead of
  a single running or done label. Say which sections are done, which
  are still running, and which errored, with counts for each. Report
  the final total only after every section is done, errored, or
  recorded as an unclosable shortfall. **Never invent a missing item
  or price to close a shortfall.**

## Cadence once built

- Specials re-check weekly at both stores; ordinary prices roll
  through a monthly re-check (the browser store resets the oldest
  quarter of its remaining sections weekly, sections whose products
  still lack a package size first — that's also the size backfill
  order). New products/categories are picked up by the weekly passes.
- The API store's accuracy spot check samples the catalog, re-fetches
  each item live, and heals mismatches from the live values.

## Verification (sandbox checks before calling it done)

- "eggs" → the plain standard eggs win the headline at each store
  (no oatmeal, no flavoured variant), and the finder shows only
  directly comparable pairs.
- "olive oil" → every headline/finder row is a real olive-oil bottle.
- A "4 for $5.00" deal stores as $1.25 per item with the deal kept.
- A per-pound price never gets a verdict against a package price.
- A barcode scan resolves a known UPC and never guesses an unknown one.
- A list/recipe totals only lines both stores priced with comparable
  products; brand preferences are honoured even when pricier, with the
  cheaper alternative shown.
- A discovery run seeds roughly one section per leaf category from the
  sitemap; the hourly watchdog re-kicks after a killed agent.

## What not to ship

Source only. Never include catalog data or prices, `app.db*`,
`audits/`, `.harness/`, `.space-build*`, `client/dist*`,
`server/dist`, `node_modules`, or `bun.lock`.
