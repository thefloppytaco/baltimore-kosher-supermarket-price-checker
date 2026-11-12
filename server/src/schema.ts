import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { STORE_KEYS } from "./stores";

// Every store column below takes its enum from the store config
// (stores.ts STORE_KEYS), so the set of stores the database knows is
// defined in exactly one place.

export const watchItems = sqliteTable("watch_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  query: text("query").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  watchItemId: integer("watch_item_id").notNull(),
  store: text("store", { enum: STORE_KEYS }).notNull(),
  status: text("status", { enum: ["ok", "pending", "error"] }).notNull(),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
  pendingSince: integer("pending_since", { mode: "timestamp_ms" }),
  error: text("error"),
  // JSON array of product rows for this (item, store).
  products: text("products").notNull().default("[]"),
});

// Persistent product catalog learned from both stores: every product the
// artifact has ever seen, under the exact name that store uses, with its
// size/category, sale flag, and last-seen price. Board lookups read this
// table first (instant, local) instead of re-checking the stores.
export const catalogProducts = sqliteTable("catalog_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  store: text("store", { enum: STORE_KEYS }).notNull(),
  // Store's own product id (Market Maven SKU); null for Seven Mile rows.
  externalId: text("external_id"),
  name: text("name").notNull(),
  // Lowercased, punctuation-stripped name used for token matching.
  nameNorm: text("name_norm").notNull(),
  category: text("category"),
  price: real("price").notNull(),
  // The package size exactly as the store shows it ("10 Oz", "0.75 Oz",
  // "48 ct"), when the store shows it separately from the product name
  // (migration 0013). Seven Mile prints it on every listing tile as a
  // small "Brand | size" line above the name — NOT in the name itself —
  // so for years it was never captured, and even when an indexing agent
  // did return it there was no column to keep it in. Per-unit math and
  // the size shown next to a product both read this column. Null when
  // the store showed no size for the product.
  sizeText: text("size_text"),
  // Display price text when the store prices by weight, e.g. "$2.49 / lb".
  priceText: text("price_text"),
  // Multi-buy deal pricing (migration 0011): when a store prices a
  // product as a bundle — Market Maven's "4 for $5.00", a Seven Mile
  // "buy 1 get 1 free" — `price` above holds the PER-ITEM price under
  // the deal (deal_total / deal_qty), never the bundle total, and these
  // columns keep the deal itself: dealText is the deal as the store
  // states it ("4 for $5.00"), dealQty how many items the deal covers,
  // dealTotal what those items cost together, and regularPrice the
  // single-item price when the store shows one (Maven's strikethrough
  // price; also the price of leftover items beyond full deal bundles
  // in cart totals). All null when the product has no multi-buy deal.
  dealText: text("deal_text"),
  dealQty: integer("deal_qty"),
  dealTotal: real("deal_total"),
  regularPrice: real("regular_price"),
  onSale: integer("on_sale", { mode: "boolean" }).notNull().default(false),
  imageUrl: text("image_url"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // When this product first entered the catalog. Preserved across price
  // re-checks (the Market Maven crawl upserts instead of replacing), so
  // the board can show genuinely new products. Rows that predate this
  // column were backfilled to a month before their last sighting, so
  // nothing already known counts as "new".
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }),
});

// One row per product sampled by a Market Maven accuracy spot check:
// the price/sale flag stored in the catalog next to what the store's
// live API returned for the same product (matched by SKU) at check
// time. Only the latest run is kept — each spot check replaces the
// previous run's rows.
export const spotChecks = sqliteTable("spot_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  store: text("store", { enum: [STORE_KEYS[0]] }).notNull().default(STORE_KEYS[0]),
  productName: text("product_name").notNull(),
  externalId: text("external_id"),
  catalogPrice: real("catalog_price").notNull(),
  livePrice: real("live_price"),
  catalogOnSale: integer("catalog_on_sale", { mode: "boolean" })
    .notNull()
    .default(false),
  liveOnSale: integer("live_on_sale", { mode: "boolean" }),
  result: text("result", {
    enum: ["match", "mismatch", "not_found", "error"],
  }).notNull(),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per store: state of the latest catalog build / indexing sweep.
export const catalogSync = sqliteTable("catalog_sync", {
  store: text("store", { enum: STORE_KEYS }).primaryKey(),
  status: text("status", { enum: ["ok", "running", "error", "none"] })
    .notNull()
    .default("none"),
  productCount: integer("product_count").notNull().default(0),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  // When the Seven Mile sweep last actually spawned an indexing agent;
  // opportunistic kicks from page loads respect a cooldown against this.
  lastKickAt: integer("last_kick_at", { mode: "timestamp_ms" }),
  error: text("error"),
});

// Barcode scan cache: a UPC/EAN the user scanned, resolved once to the
// product it belongs to (via Open Food Facts, or typed in by the user when
// the barcode isn't in any public database), so repeat scans resolve
// instantly and locally. The mapping is the scan history too — the board
// shows recent scans from this table.
export const barcodeMappings = sqliteTable("barcode_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  barcode: text("barcode").notNull().unique(),
  productName: text("product_name").notNull(),
  brand: text("brand"),
  quantityText: text("quantity_text"),
  imageUrl: text("image_url"),
  source: text("source", { enum: ["openfoodfacts", "manual"] })
    .notNull()
    .default("manual"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// The shopping list ("cart") the user builds while browsing: products
// picked from the finder, the shop, or a watchlist card, each pinned to
// the store they'd buy it from, with the catalog price at add time and
// a quantity. Totals are computed per store so the user can see what
// the same trip costs at each store. One row per (store, product).
export const cartItems = sqliteTable("cart_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  store: text("store", { enum: STORE_KEYS }).notNull(),
  // The product's name exactly as that store lists it.
  name: text("name").notNull(),
  nameNorm: text("name_norm").notNull(),
  price: real("price").notNull(),
  // The product's multi-buy deal at add time (see catalog_products):
  // price is the per-item deal price; line totals charge full bundles
  // at dealTotal and leftovers at regularPrice when known.
  dealText: text("deal_text"),
  dealQty: integer("deal_qty"),
  dealTotal: real("deal_total"),
  regularPrice: real("regular_price"),
  // How `price` is charged (migration 0012): "per_lb" / "per_oz" when
  // the store prices this product by weight — meat and chicken, above
  // all — in which case `qty` counts pounds (or ounces), not items,
  // and the line total is price × weight. Null/"each" = priced per
  // item or package, as before.
  priceBasis: text("price_basis"),
  category: text("category"),
  qty: integer("qty").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Brand preferences the user has taught the artifact: for a given item
// or category keyword ("milk", "olive oil"), the brand they want quoted
// even when it costs more ("Pride of the Farm"). List/recipe pricing
// looks for a matching product from this brand first at each store and
// only falls back to the cheapest match when that brand isn't carried.
// One row per (keyword, brand) pair; several brands may be saved, the
// first match at a store wins.
export const brandPreferences = sqliteTable("brand_preferences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Lowercased keyword the preference applies to (an item or category).
  keyword: text("keyword").notNull(),
  // Brand text as the user typed it; matched against product names.
  brand: text("brand").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Seven Mile indexing work queue: one row per store section / search term
// the background browser agent still has to sweep. The agent works through
// these in chained batches until none are left, so a full-store index
// finishes in the background however long it takes. Kinds: "discovery"
// (reads the store's own sitemap page and seeds one section per leaf
// category it finds), "category" (one leaf category page; term is the
// page path, e.g. "categories/78154/products"), "specials", "search"
// (staple keyword searches — a cross-check net under the category walk),
// and "watch" (one per watchlist item).
export const catalogSections = sqliteTable("catalog_sections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  store: text("store", { enum: STORE_KEYS }).notNull(),
  term: text("term").notNull(),
  // Display name of the section as the store itself shows it (the link
  // text on Seven Mile's sitemap page, e.g. "Milk"). For category
  // sections this is the product's aisle: products saved from the
  // section are stamped with it as their category, which the matcher
  // uses to keep lookalike products from other aisles (oatmeal named
  // "Dinosaur Eggs") out of an item's results. Null for sections seeded
  // before labels were kept, and for non-category sections.
  label: text("label"),
  kind: text("kind", {
    enum: ["search", "specials", "watch", "category", "discovery"],
  })
    .notNull()
    .default("search"),
  status: text("status", { enum: ["pending", "running", "done", "error"] })
    .notNull()
    .default("pending"),
  productCount: integer("product_count").notNull().default(0),
  // The total number of products the store itself reported for this
  // section (a result count on a search page, a total on a category
  // page), as read by the indexing agent. Null when the page showed no
  // total. A section is only "complete" when the distinct products
  // linked to it (catalog_section_products) reach this count.
  expectedCount: integer("expected_count"),
  // How many times an indexing agent has been dispatched for this section,
  // and the most recent failure/timeout reason. A section that keeps
  // timing out lands in "error" instead of silently blocking the sweep.
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

// Which catalog products each Seven Mile section has produced. This is
// what makes sweep completeness measurable: a section's coverage is the
// number of DISTINCT products linked to it, compared against the total
// the store itself reported (expected_count) — never the number of rows
// one pass happened to insert, which collapses to ~0 on re-passes
// because products upsert by name.
export const catalogSectionProducts = sqliteTable(
  "catalog_section_products",
  {
    sectionId: integer("section_id").notNull(),
    productId: integer("product_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sectionId, t.productId] })],
);

// Price history: one row per OBSERVED price change for a catalog
// product — the price (per-item, as in catalog_products), sale flag,
// and deal text in effect, stamped when the change was first seen.
// The catalog row itself always holds the CURRENT price; this table is
// the record of how it got there, so a price is never silently
// overwritten without a trace. Rows are written by the catalog write
// paths (Maven crawl, learned-product upserts, spot-check heals) only
// when the price or sale flag actually differs from the stored row.
export const priceHistory = sqliteTable("price_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The catalog product this observation belongs to. Kept even if the
  // product row is later removed — history outlives the listing.
  productId: integer("product_id").notNull(),
  store: text("store", { enum: STORE_KEYS }).notNull(),
  price: real("price").notNull(),
  onSale: integer("on_sale", { mode: "boolean" }).notNull().default(false),
  dealText: text("deal_text"),
  observedAt: integer("observed_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
