# Build a two-store supermarket price checker

> If you were given only this repo's link and told "build this", start
> here. This file is the whole build skill — follow it start to finish.
> The README's one-line install is the only instruction the user needs
> to give; everything else you need is in this repo (`docs/DESIGN.md`
> for architecture and adapter notes, `server/src/stores.ts` for the
> single store config). Do not ask the user for anything the repo
> already answers.

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
  HTTP 403 on a plain fetch of the homepage from server egress — the
  storefront is browser-only, but its catalog tree is not. Find the
  retailer id (`r-<number>`) in a script tag of the storefront's HTML
  shell (a browser task, or a Wayback raw snapshot), then fetch
  `https://htmlcache.blob.core.windows.net/html-production-env/r-<rid>/desktop/multi-true/data.js`
  **from the server** — it is keyless, it answers 200, and it holds the
  whole category tree (`frontendData.tree.categories`, nested by
  `subCategories`) plus `retailer.branches[].id`. Confirm both, and put
  the retailer id, branch id and blob URL in the store config. Then
  confirm in a **browser task** that `/categories/<id>/products`
  renders, and that listing tiles print a small grey "Brand | size"
  line directly above the product name (that line — not the name — is
  where the size lives). Keep `/sitemap` as the fallback coverage map
  for a store whose blob can't be found.

If a store fits neither pattern, stop and say so — do not force it into
an adapter.

## Step 2 — Fill the store config

All store identity lives in **`server/src/stores.ts`** — the single
store config. Each entry carries: `key` (stored in the database),
display `name`, `short` label, `colorVar` (a CSS variable in
`client/src/theme.css`), `homepage`, `flyerUrl` + `flyerLabel`,
`access` mode (`"api"` or `"browser"`), and `spotCheck` support
(API stores only). A browser store identified in Step 1 also carries
`platform`, `retailerId`, `branchId` and `catalogBlobUrl` (what the
sweep queue is seeded from) and `catalogRead`, which stays `"tiles"`
unless the JSON read has been proven against the tile read on that
store — see the adapter notes.

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
in `server/src/lib.test.ts` — 46 tests over the pure matching/pricing
functions and the catalog-tree parser: `parseSize`, `priceBasisOf`,
`withUnit`, `parseDealText`, `scoreMatch`, `pickBest`, `verdictFor`,
`pairProducts`, `aisleForCategory`, `listLineCost`,
`extractFrontendData`, `storAiLeafCategories`,
`storAiCategoryProductsUrl`, `jsonPageProblem`).

## Step 4 — First run: build the catalog

The first open auto-fires `syncCatalog`. Set expectations honestly:

- **API store:** full catalog in ~1 minute (the one-letter query,
  paged, a small worker pool).
- **Browser store:** hours, not days. The server reads the store's
  catalog blob and seeds one section per visible leaf category that
  has products (sitemap discovery runs only if the blob is
  unreachable). Up to three background browser agents then sweep
  different parts of the store at once, each holding a batch of
  sections, saving each section as it finishes it; every save tops the
  sweep back up to its concurrency limit. An hourly watchdog reaps
  batches whose agent died.

## The sweep contract (background_sweep_completeness)

The browser store's sweep is a work queue (`catalog_sections`), and a
section is complete only when the DISTINCT products linked to it reach
the total the store itself reported for that page
(`expectedCount`):

- Record an attempt count, a claim time, a batch id and a last save
  time for every section before starting it. **Every save heartbeats
  its whole batch**: one agent is handed several sections and works
  them one at a time over 15–25 minutes, so staleness has to be
  measured per batch, and a batch is presumed dead only after ten
  minutes with no save from ANY of its sections. Judging each row by
  its own clock marks a live agent's unreached sections dead and hands
  them to a second agent — duplicated work that looks like flaky
  sections. When a batch really is dead, requeue it with the reason
  recorded and keep later sections moving. Mark a section as a visible
  error after three failed attempts, and keep the error from blocking
  the rest of the sweep.
- Walk the source category tree instead of a fixed list of search
  terms, so coverage does not depend on keywords guessed. Take the
  tree from the source itself — a published catalog file where there
  is one, its sitemap otherwise — and keep the keyword searches as a
  fallback only: once the real tree is known, re-sweeping search terms
  re-reads the same products through a worse view of the store. Remove any
  per-search cap on saved items, or record the cap in the section
  status when a cap must stay. Never mark a section done only because
  it reached a cap, and never report a sweep complete while any
  section sits at a cap. Save each section as soon as it finishes, so
  a later stall cannot lose finished work.
- Compare the saved count with the source total and record any
  shortfall in the section status. Requeue a short section while it is
  still gaining items, and stop when a fresh pass adds nothing, when
  the pass cap is reached, or when the shortfall is too small to be
  worth another agent (a couple of products, or a few percent) — in
  every one of those cases the shortfall is still recorded and still
  counted on the board. Treat the source total as a cross check rather
  than gospel, since a source can overstate its own total.
- Show attempts, last failure, and shortfalls on the board instead of
  a single running or done label. Say which sections are done, which
  are still running, and which errored, with counts for each. Report
  the final total only after every section is done, errored, or
  recorded as an unclosable shortfall. **Never invent a missing item
  or price to close a shortfall.**

## Cadence once built

- Specials re-check weekly at both stores; ordinary prices roll
  through a monthly re-check (the browser store resets the oldest
  quarter of its category and watch sections weekly, sections whose
  products still lack a package size first — that's also the size
  backfill order). New products/categories are picked up by the weekly
  passes, which re-read the store's catalog tree: new leaves become
  sections, leaves the store un-hides become work again, leaves it
  hides are parked rather than deleted.
- When a product drops off the specials page, put back the regular
  price the store itself printed beside the sale price. With no known
  regular price, leave the row alone and re-queue the pages that
  produced it — a sale price with the flag cleared would read as the
  ordinary price, which is inventing one.
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
- A seeding run creates one section per visible leaf category with
  products, read from the store's own catalog tree (Seven Mile: ~374
  of 1,046 nodes), each carrying its department and breadcrumb;
  discovery runs only when that tree can't be fetched.
- Several sections sit `running` under different batch ids at once,
  and a save on one section of a batch moves its siblings' last-save
  time too — no section is reaped while its agent is still saving.
- The hourly watchdog re-kicks after a killed agent.

## What not to ship

Source only. Never include catalog data or prices, `app.db*`,
`audits/`, `.harness/`, `.space-build*`, `client/dist*`,
`server/dist`, `node_modules`, or `bun.lock`.
