# Baltimore Kosher Supermarket Price Checker

Compare grocery prices across two supermarkets, from one app: **search an
item, price a whole shopping list or recipe, scan a barcode, browse what's
on special and what's new, shop by aisle, and build a shopping list** — with
like-for-like comparisons only, per-unit pricing, multi-buy deals stated as
deals, and by-weight prices kept per pound end to end.

The example build compares **Market Maven** and **Seven Mile Market** in
Baltimore, Maryland. Both stores are configured in a single file,
`server/src/stores.ts` — retarget the app at any two other stores by
editing that config and the adapter notes in `docs/DESIGN.md`.

## Runs on Muse alone

No Apify. No extra API tokens. No secrets, no accounts, no sign-ins. The
only external endpoints are the two stores' own surfaces and Open Food
Facts (keyless, for barcode lookups). Everything — catalog building,
matching, pricing, background sweeps — runs on Muse itself.

How the two stores get in:

- **Market Maven** runs on MyCloudGrocer and exposes a public JSON product
  API, so the server crawls its whole catalog directly (a one-letter query
  returns everything, ~7,700 products in about a minute).
- **Seven Mile Market** runs on stor.ai/Selfpoint behind Cloudflare, which
  blocks direct fetch. Its catalog is indexed by background browser agents
  sweeping the store's own sitemap category tree, section by section —
  about 370 categories, over days, with coverage checked against the
  totals the store itself reports for each page. Every save chains the
  next batch, and an hourly watchdog reaps stalled sections.

## What it does

- **Search an item** — word-level matching with singular/plural folding,
  per-unit prices, and a verdict on the top directly-comparable pair only.
  Generic terms open a finder with *all* comparable pairs for that term.
- **Price a list or recipe** — paste a shopping list or a recipe; each line
  is quoted at both stores with the exact brand and product, per-store
  totals, and lines only counted where both stores priced a comparable
  product.
- **Scan a barcode** — camera, photo upload, or typed digits, resolved
  through a local cache then Open Food Facts. An unknown barcode is never
  guessed: the user names the product once and the mapping is cached.
- **Specials & What's new** — per-store or both, with links to each
  store's flyer / specials page (a flyer shows only part of a store's
  specials — the app says so).
- **Shop by aisle** — both stores' raw categories map onto 14 normal
  supermarket aisles, with a per-aisle store filter and
  "Seven Mile only" / "Market Maven only" badges.
- **Cart / shopping list** — prices come from the catalog only; a
  client-supplied price is never used. Multi-buy deals charge full
  bundles at the bundle total and leftovers at the regular price;
  by-weight items count in pounds.
- **Brand preferences** — remember preferred brands; they're quoted even
  when pricier, with what the preference costs versus the cheapest option.
- **Accuracy spot check** — samples the API store's catalog, re-fetches
  each item live, and heals mismatches from the live values.
- **Price history** — every observed price/sale change is recorded, never
  silently overwritten. Settings shows the count per store.

## Honesty rules

- Never invent a price, a sale, or a size. A sale shows only when the
  store itself marks it (badge, strikethrough, specials page, sale flag).
- Every price carries the date it was actually seen at the store.
- A comparison never crosses kinds, and a per-pound price never faces a
  package price; when no honest verdict exists, none is shown and the UI
  says why.

## How another Muse builds this

Tell your Muse to build the space from this repo, following `SKILL.md`:

1. Probe the two stores to confirm their platforms (see
   `docs/DESIGN.md` — adapter notes): POST the MyCloudGrocer-style API
   with `q=a` and check the count; expect a 403 on a plain fetch of a
   Cloudflare-fronted store's homepage and confirm `/sitemap` in a
   browser task.
2. Fill in `server/src/stores.ts` (keys, names, colours, homepages, flyer
   links, access mode, locale knobs) and replace `__SPACE_SLUG__` in
   `space.json` (and `client/index.html`) with the new space's slug.
3. Create the space through the web-artifact builder — **never
   `bun run build`**; the build only goes through the web-artifact tools.
4. First open auto-fires the catalog sync: expect the API store in
   ~1 minute and the browser store over days of chained sweeps.

`docs/DESIGN.md` has the full architecture, data flows, matching and
pricing rules, adapter notes, and rejected approaches.

## Repo contents

| Path | What it is |
|---|---|
| `client/src/` | React 19 client (App, API client, theme) |
| `client/index.html`, `client/build.mjs`, `client/tsconfig.json` | Client entry, SDK bundler, types |
| `server/src/` | Server actions, schema, store config, pure matching/pricing logic (`lib.ts`) + unit tests (`lib.test.ts`, `bun test`) |
| `drizzle/` | SQLite migrations 0001–0014 |
| `space.json` | Space template — replace `__SPACE_SLUG__` |
| `package.json`, `tsconfig.base.json`, `bunfig.toml`, `icon.webp` | Project wiring and icon |
| `docs/DESIGN.md` | Sanitised design doc (architecture, adapters, honesty rules) |
| `SKILL.md` | Step-by-step skill for a rebuilding Muse |

Not shipped, deliberately: any catalog data or prices, `app.db`, audit
notes, harness files, built bundles, `node_modules`, or `bun.lock`
(the SDK is a machine-local `file:` tarball whose path differs per
machine — the builder installs it from its own environment).
