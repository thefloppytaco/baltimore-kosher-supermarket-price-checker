// Price-compare actions backed by a persistent product catalog.
//
// The catalog (catalog_products) holds every product the artifact has
// seen at either store — the exact name that store uses, size and
// category, sale flag, deal fields, and last-seen price — and every
// price CHANGE is appended to price_history, so a price is never
// overwritten without a record. Board lookups are served from the
// catalog first: instant, local, no store round-trip.
//
// Which stores are compared, how each is reached (direct JSON API vs
// browser-agent sweep), and every locale knob live in stores.ts; the
// pure matching/pricing rules (sizes, per-unit math, deals, relevance
// scoring, comparable pairing, verdicts, list costing) live in lib.ts
// with unit tests in lib.test.ts. Adapter notes for the two store
// platforms (API field codes, the whole-catalog query trick, the
// sitemap/category sweep, the listing-tile anatomy) and the rejected
// approaches are in DESIGN.md.
//
// Recheck cadence: specials re-check weekly at both stores; ordinary
// prices roll through a monthly re-check (a slice of the catalog each
// week); new products are picked up by the weekly passes. The API
// store's weekly pass is a full crawl whose upserts preserve each
// product's first-seen date; SKUs missing from a crawl are NOT
// deleted — a short or partial page must never silently discontinue
// products, so unseen rows simply stop being served once they age
// past the serve window. The browser store's catalog is indexed by
// background agents (spawnTask) sweeping a section queue
// (catalog_sections): a section is complete only when the distinct
// products linked to it reach the total the store itself reported
// for that page, and coverage is measured in linked products, never
// in rows one pass happened to insert.
//
// Accuracy is verified, not assumed: the spot check samples catalog
// products across the API store, re-fetches each live, and records
// stored-vs-live price and sale flag (a mismatch also corrects the
// catalog row from the live values and logs the change to history).

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import {
  API_STORE,
  BROWSER_STORE,
  STORES,
  STORE_KEYS,
  type StoreKey,
} from "./stores";
import {
  aisleForCategory,
  AISLE_ORDER,
  contentWords,
  dealPerItem,
  DEFAULT_AISLE,
  foldWord,
  isWeightPriced,
  listLineCost,
  normalizeName,
  pairMatchTwo,
  pairProducts,
  pairSignature,
  parseDealText,
  parseSize,
  pickBest,
  priceBasisOf,
  queryTokens,
  roundMoney,
  scoreMatch,
  scoredEntries,
  verdictFor,
  withUnit,
  type DealInfo,
  type PairGroup,
} from "./lib";

/** Zod enum over the configured store keys — every request/response
 *  schema that names a store derives from the store config. */
const storeEnum = z.enum(STORE_KEYS);
const winnerEnum = z.enum([...STORE_KEYS, "tie", "none"] as const);

// ---------- shared product shape ----------

const productSchema = z.object({
  name: z.string(),
  price: z.number(),
  sizeText: z.string().nullable(),
  unitPrice: z.number().nullable(),
  unitLabel: z.string().nullable(),
  unitFamily: z.string().nullable(),
  // What `price` buys: "each" (one item/package), "per_lb" (one
  // pound — the price IS a per-pound price, as with meat and
  // chicken), or "per_oz". Derived from the store's own price text,
  // never from a package size in the name. Defaults keep snapshots
  // saved before per-weight pricing existed parseable.
  priceBasis: z.enum(["each", "per_lb", "per_oz"]).default("each"),
  // The price exactly as the store displays it ("$7.99 / lb",
  // "$5.00"), when known — the source priceBasis is derived from.
  priceText: z.string().nullable().default(null),
  onSale: z.boolean(),
  // Multi-buy deal, when the store prices this product as a bundle
  // ("4 for $5.00", "Buy 1, get 1 free"): `price` is the per-item
  // price under the deal, dealText states the deal as the store does,
  // dealQty/dealTotal are the bundle size and its total price, and
  // regularPrice is the single-item price when the store shows one.
  // Defaults keep snapshots saved before deals existed parseable.
  dealText: z.string().nullable().default(null),
  dealQty: z.number().nullable().default(null),
  dealTotal: z.number().nullable().default(null),
  regularPrice: z.number().nullable().default(null),
  imageUrl: z.string().nullable(),
  // The aisle the store itself shelves this product in, when known
  // (Market Maven's catalog API sends one per product; Seven Mile
  // products are stamped with the category section they were indexed
  // from). Defaults keep snapshots saved before categories existed
  // parseable.
  category: z.string().nullable().default(null),
});
type Product = z.infer<typeof productSchema>;

const snapSchema = z.object({
  status: z.enum(["ok", "pending", "error", "none"]),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
  products: z.array(productSchema),
  best: productSchema.nullable(),
});
type SnapView = z.infer<typeof snapSchema>;

const verdictSchema = z.object({
  winner: winnerEnum,
  basis: z.enum(["unit", "price"]).nullable(),
  diff: z.number().nullable(),
  text: z.string(),
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
// Serve catalog prices without a store re-check while they are within
// the rolling monthly window: specials re-check weekly, but an ordinary
// product's price may legitimately be up to ~a month old under the
// rolling cycle, so the serve window matches that instead of forcing
// constant re-queues.
const CATALOG_SERVE_MS = MONTH_MS + 2 * 24 * 60 * 60 * 1000;
const REBUILD_GATE_MS = 6 * 24 * 60 * 60 * 1000;
// "New this week": products whose first-seen date falls in this window.
const NEW_PRODUCT_MS = WEEK_MS;

// ---------- catalog helpers ----------

type Store = StoreKey;
type CatalogRow = typeof schema.catalogProducts.$inferSelect;

/** Weighted items carry prices like "$2.49 / lb" — treat as a 1-unit size. */
function sizeTextFromPriceText(priceText: string | null): string | null {
  if (!priceText) return null;
  const m = priceText.match(/\/\s*(lb|oz)\b/i);
  if (!m) return null;
  return m[1]!.toLowerCase() === "lb" ? "1 lb" : "1 oz";
}

function catalogRowToProduct(r: CatalogRow): Product {
  return withUnit({
    name: r.name,
    price: r.price,
    priceText: r.priceText,
    // The stored package size (Seven Mile's tile size line) wins; a
    // per-weight price text still synthesizes its "1 lb" / "1 oz".
    sizeText: r.sizeText ?? sizeTextFromPriceText(r.priceText),
    onSale: r.onSale,
    dealText: r.dealText,
    dealQty: r.dealQty,
    dealTotal: r.dealTotal,
    regularPrice: r.regularPrice,
    imageUrl: r.imageUrl,
    category: r.category,
  });
}

type CatalogMatch = { products: Product[]; newestSeenAt: Date | null; total: number };

type ScoredRow = { r: CatalogRow; score: number; coverage: number };

/** Score catalog rows for a query (see scoredEntries), best first. */
function scoreCatalogRows(query: string, rows: CatalogRow[]): ScoredRow[] {
  const scored = scoredEntries(query, rows)
    .filter((e) => e.coverage > 0)
    .map((e) => ({ r: e.item, score: e.score, coverage: e.coverage }));
  scored.sort((a, b) => b.score - a.score || a.r.nameNorm.length - b.r.nameNorm.length);
  return scored;
}

/** Match a query against one store's catalog, best matches first. */
async function catalogMatch(
  ctx: Ctx,
  store: Store,
  query: string,
  limit = 8,
): Promise<CatalogMatch> {
  const db = ctx.db<typeof schema>();
  const tokens = queryTokens(query);
  if (tokens.length === 0) return { products: [], newestSeenAt: null, total: 0 };
  const fetchCandidates = (toks: string[]) =>
    db
      .select()
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.store, store),
          ...toks.map((t) => like(schema.catalogProducts.nameNorm, `%${t}%`)),
        ),
      )
      // Deliberately NO row cap here: scoring must see every
      // candidate before anything is cut. A SQL limit applied before
      // relevance scoring let a popular token's first 250 rows crowd
      // out the product the query actually means; the scored result
      // is sliced to `limit` only after scoreCatalogRows ranks it.
  // The SQL stage is a wide substring net; the real matching happens
  // in scoreCatalogRows (word-level, head-noun aware). Word-level
  // filtering can empty the net even when the substring net caught
  // rows (e.g. every hit was "eggplant" for "egg"), so the relaxation
  // keys off the SCORED result, not the raw row count.
  let rows = await fetchCandidates(tokens);
  let scored = scoreCatalogRows(query, rows);
  if (scored.length === 0 && tokens.length > 1) {
    // Relax: match on the most distinctive (longest) token only.
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0]!;
    rows = await fetchCandidates([longest]);
    scored = scoreCatalogRows(query, rows);
  }
  const newest = scored.reduce<Date | null>(
    (acc, s) => (!acc || s.r.lastSeenAt > acc ? s.r.lastSeenAt : acc),
    null,
  );
  return {
    products: scored.slice(0, limit).map((s) => catalogRowToProduct(s.r)),
    newestSeenAt: newest,
    total: scored.length,
  };
}

type LearnedProduct = {
  name: string;
  price: number;
  sizeText?: string | null;
  onSale?: boolean;
  category?: string | null;
  imageUrl?: string | null;
  externalId?: string | null;
  priceText?: string | null;
  // Multi-buy deal fields. Callers that price a product pass these
  // explicitly (null = no deal) so a re-save can CLEAR a deal that
  // ended; omitting them leaves a stored deal untouched.
  dealText?: string | null;
  dealQty?: number | null;
  dealTotal?: number | null;
  regularPrice?: number | null;
};

/** Two size texts name the same package when they parse to the same amount. */
function sameSize(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = parseSize(a);
  const pb = parseSize(b);
  if (pa && pb) return pa.family === pb.family && Math.abs(pa.qty - pb.qty) < 0.01;
  return normalizeName(a) === normalizeName(b);
}

/**
 * Insert or refresh catalog rows, deduped by normalized name AND size
 * per store: Seven Mile sells the same name at several sizes as
 * separate listings, and those are different products with different
 * prices — matching on name alone collapsed them into one row. A
 * stored row whose size is still unknown adopts the size an incoming
 * product carries (that is how the size backfill heals old rows);
 * a stored row with a DIFFERENT known size is left alone and the
 * incoming product becomes its own row. Returns a map from
 * normalized name to catalog product id, so callers (the Seven Mile
 * sweep) can link products back to the section that produced them.
 */
/**
 * Append price-history observations. Callers pass only rows whose
 * price or sale flag actually changed (plus first sightings), so the
 * table stays a record of changes, not a copy of the catalog.
 */
async function recordPriceHistory(
  ctx: Ctx,
  rows: {
    productId: number;
    store: Store;
    price: number;
    onSale: boolean;
    dealText: string | null;
    observedAt: Date;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = ctx.db<typeof schema>();
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    if (chunk.length > 0) {
      await db.insert(schema.priceHistory).values(chunk);
    }
  }
}

async function upsertLearnedProducts(
  ctx: Ctx,
  store: Store,
  list: LearnedProduct[],
): Promise<Map<string, number>> {
  const db = ctx.db<typeof schema>();
  const ids = new Map<string, number>();
  const clean = list.filter((p) => p.name && p.price > 0);
  if (clean.length === 0) return ids;
  const norms = [...new Set(clean.map((p) => normalizeName(p.name)))];
  const existing = await db
    .select()
    .from(schema.catalogProducts)
    .where(
      and(eq(schema.catalogProducts.store, store), inArray(schema.catalogProducts.nameNorm, norms)),
    );
  const byNorm = new Map<string, CatalogRow[]>();
  for (const r of existing) {
    const arr = byNorm.get(r.nameNorm) ?? [];
    arr.push(r);
    byNorm.set(r.nameNorm, arr);
    if (!ids.has(r.nameNorm)) ids.set(r.nameNorm, r.id);
  }
  const now = new Date();
  const inserts: (typeof schema.catalogProducts.$inferInsert)[] = [];
  const history: Parameters<typeof recordPriceHistory>[1] = [];
  for (const p of clean) {
    const norm = normalizeName(p.name);
    const size = p.sizeText ?? null;
    const rows = byNorm.get(norm) ?? [];
    // Prefer a row whose size matches; fall back to a size-less row
    // (it adopts this size); a row with a different known size is a
    // different product and must not be overwritten.
    const row =
      rows.find((r) => size != null && sameSize(r.sizeText, size)) ??
      rows.find((r) => r.sizeText == null) ??
      (size == null ? rows[0] : undefined);
    if (row) {
      ids.set(norm, row.id);
      const nextOnSale = p.onSale ?? row.onSale;
      const nextDealText =
        p.dealText === undefined ? row.dealText : p.dealText;
      if (
        row.price !== p.price ||
        row.onSale !== nextOnSale ||
        (row.dealText ?? null) !== (nextDealText ?? null)
      ) {
        history.push({
          productId: row.id,
          store,
          price: p.price,
          onSale: nextOnSale,
          dealText: nextDealText ?? null,
          observedAt: now,
        });
      }
      await db
        .update(schema.catalogProducts)
        .set({
          name: p.name,
          price: p.price,
          priceText: p.priceText ?? row.priceText,
          sizeText: size ?? row.sizeText,
          onSale: p.onSale ?? row.onSale,
          category: p.category ?? row.category,
          imageUrl: p.imageUrl ?? row.imageUrl,
          externalId: p.externalId ?? row.externalId,
          dealText: p.dealText === undefined ? row.dealText : p.dealText,
          dealQty: p.dealQty === undefined ? row.dealQty : p.dealQty,
          dealTotal: p.dealTotal === undefined ? row.dealTotal : p.dealTotal,
          regularPrice:
            p.regularPrice === undefined ? row.regularPrice : p.regularPrice,
          lastSeenAt: now,
        })
        .where(eq(schema.catalogProducts.id, row.id));
    } else if (
      !inserts.some(
        (i) => i.nameNorm === norm && sameSize(i.sizeText ?? null, size),
      ) &&
      !(size == null && inserts.some((i) => i.nameNorm === norm))
    ) {
      inserts.push({
        store,
        externalId: p.externalId ?? null,
        name: p.name,
        nameNorm: norm,
        category: p.category ?? null,
        price: p.price,
        priceText: p.priceText ?? null,
        sizeText: size,
        onSale: p.onSale ?? false,
        imageUrl: p.imageUrl ?? null,
        dealText: p.dealText ?? null,
        dealQty: p.dealQty ?? null,
        dealTotal: p.dealTotal ?? null,
        regularPrice: p.regularPrice ?? null,
        lastSeenAt: now,
        firstSeenAt: now,
      });
    }
  }
  for (let i = 0; i < inserts.length; i += 400) {
    const chunk = inserts.slice(i, i + 400);
    if (chunk.length > 0) {
      const returned = await db
        .insert(schema.catalogProducts)
        .values(chunk)
        .returning({
          id: schema.catalogProducts.id,
          nameNorm: schema.catalogProducts.nameNorm,
        });
      for (const r of returned) {
        ids.set(r.nameNorm, r.id);
        const srcItem = chunk.find((i) => i.nameNorm === r.nameNorm);
        if (srcItem) {
          history.push({
            productId: r.id,
            store,
            price: srcItem.price,
            onSale: srcItem.onSale ?? false,
            dealText: srcItem.dealText ?? null,
            observedAt: now,
          });
        }
      }
    }
  }
  await recordPriceHistory(ctx, history);
  return ids;
}

async function getSyncRow(ctx: Ctx, store: Store) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.catalogSync)
    .where(eq(schema.catalogSync.store, store));
  return rows[0];
}

async function setSyncRow(
  ctx: Ctx,
  store: Store,
  values: Partial<{
    status: "ok" | "running" | "error" | "none";
    productCount: number;
    lastSyncAt: Date | null;
    lastKickAt: Date | null;
    error: string | null;
  }>,
) {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.catalogSync)
    .values({ store, status: values.status ?? "none", productCount: values.productCount ?? 0, lastSyncAt: values.lastSyncAt ?? null, error: values.error ?? null })
    .onConflictDoUpdate({ target: schema.catalogSync.store, set: values });
}

async function catalogCount(ctx: Ctx, store: Store): Promise<number> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.store, store));
  return rows[0]?.n ?? 0;
}

// ---------- Market Maven direct API ----------

type MavenRaw = {
  N?: string;
  P_v?: number;
  P?: string;
  SP?: boolean;
  iU?: string;
  SKU?: string;
  CN?: string;
  // PQ: how many items the listed price P covers — the storefront
  // renders PQ=4, P="$5.00" as "4 for $5.00". 0/empty = plain price,
  // 1 = priced singly (the usual case for weighted sale items).
  PQ?: number | string;
  // O: the regular single-item price when the product is on special
  // ("$1.45"; weighted items carry the unit, "$9.49 / lb").
  O?: string;
  // BOGO offer fields — present in every row but empty across the
  // whole catalog as of the 2026-11-12 audit; parsed defensively so a
  // future BOGO offer is priced correctly the day one appears.
  BOGO_BuyQty?: number | string;
  BOGO_GetQty?: number | string;
  BOGO_OfferPercentage?: number | string;
};

// MyCloudGrocer adapter endpoints (see DESIGN.md adapter notes):
// the product-list API and its image CDN base for the API store.
const API_PRODUCTS_URL = "https://www.marketmavenmd.com/api/AjaxFilter/JsonProductsList";
const API_IMAGE_BASE = "https://marketmavenmd.com/api/content/images/thumbs/";
// Products per API page, and the single-letter query that makes the
// API return the store's whole catalog for the full crawl.
const API_PAGE_SIZE = 120;
const API_WHOLE_CATALOG_QUERY = "a";

async function fetchMavenPage(
  query: string,
  page: number,
): Promise<{ count: number; rows: MavenRaw[] }> {
  const url = `${API_PRODUCTS_URL}?pageNumber=${page}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0",
    },
    body: "[]",
  });
  if (!res.ok) throw new Error(`Market Maven returned ${res.status}`);
  const data = (await res.json()) as { productsJson?: string; productsCount?: number };
  const rows = JSON.parse(data.productsJson || "[]") as MavenRaw[];
  return { count: typeof data.productsCount === "number" ? data.productsCount : rows.length, rows };
}

/** The price exactly as listed (a bundle total when a deal applies). */
function mavenListedPrice(r: MavenRaw): number {
  return typeof r.P_v === "number"
    ? r.P_v
    : Number(String(r.P ?? "").replace(/[^0-9.]/g, "")) || 0;
}

/** The regular single-item price from the feed's O field, if shown. */
function mavenRegularPrice(r: MavenRaw): number | null {
  if (!r.O) return null;
  const m = String(r.O).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The product's multi-buy deal, if the feed carries one: PQ > 1 means
 * the listed price buys PQ items ("4 for $5.00"), and the feed's BOGO
 * fields describe a buy-X-get-Y offer priced off the single-item
 * listed price. PQ of 0/1 is a plain price, not a deal.
 */
function mavenDeal(r: MavenRaw): DealInfo | null {
  const listed = mavenListedPrice(r);
  if (!(listed > 0)) return null;
  const pq = typeof r.PQ === "number" ? r.PQ : Number(r.PQ);
  if (Number.isFinite(pq) && pq > 1) {
    return { qty: Math.round(pq), total: listed, text: `${Math.round(pq)} for $${listed.toFixed(2)}` };
  }
  const buy = Number(r.BOGO_BuyQty);
  const get = Number(r.BOGO_GetQty);
  if (Number.isFinite(buy) && buy > 0 && Number.isFinite(get) && get > 0) {
    const pct = Number(r.BOGO_OfferPercentage);
    if (Number.isFinite(pct) && pct > 0 && pct < 100) {
      return {
        qty: buy + get,
        total: roundMoney(listed * (buy + get * (1 - pct / 100))),
        text:
          pct >= 99
            ? `Buy ${buy}, get ${get} free`
            : `Buy ${buy}, get ${get} ${pct}% off`,
      };
    }
    return {
      qty: buy + get,
      total: roundMoney(listed * buy),
      text: `Buy ${buy}, get ${get} free`,
    };
  }
  return null;
}

/**
 * Everything the artifact needs to price one Maven product: the
 * per-item price (the deal's per-item price when a deal applies —
 * never the bundle total), the deal itself, and the regular price.
 */
function mavenPricing(r: MavenRaw): {
  price: number;
  deal: DealInfo | null;
  regularPrice: number | null;
} {
  const listed = mavenListedPrice(r);
  const deal = mavenDeal(r);
  return {
    price: deal ? dealPerItem(deal) : listed,
    deal,
    regularPrice: mavenRegularPrice(r),
  };
}

function mavenPrice(r: MavenRaw): number {
  return mavenPricing(r).price;
}

function mavenImage(r: MavenRaw): string | null {
  return r.iU ? `${API_IMAGE_BASE}${r.iU}` : null;
}

async function fetchMaven(query: string): Promise<Product[]> {
  const { rows } = await fetchMavenPage(query, 1);
  // Same relevance rules as the catalog matcher: word-level matches,
  // head-noun aware, best first. If word matching empties the list
  // (the store's own search is fuzzy), fall back to its ranking with
  // a loose substring filter rather than showing nothing.
  const scored = rows
    .map((r) => ({ r, s: scoreMatch(query, r.N ?? "") }))
    .filter((x) => x.s.coverage > 0)
    .sort((a, b) => b.s.score - a.s.score);
  let picked = scored.map((x) => x.r);
  if (picked.length === 0) {
    const tokens = queryTokens(query);
    picked = rows.filter((r) => {
      const n = (r.N ?? "").toLowerCase();
      return tokens.some((t) => n.includes(t));
    });
  }
  return picked.slice(0, 6).map((r) => {
    const pricing = mavenPricing(r);
    return withUnit({
      name: r.N ?? "Unknown product",
      price: pricing.price,
      // The feed's price text carries per-weight pricing ("$7.99 /
      // lb") — pass it through so the product is marked per-pound
      // instead of losing the "/ lb" on the way in.
      priceText: r.P ?? null,
      sizeText: sizeTextFromPriceText(r.P ?? null),
      onSale: r.SP === true,
      dealText: pricing.deal?.text ?? null,
      dealQty: pricing.deal?.qty ?? null,
      dealTotal: pricing.deal?.total ?? null,
      regularPrice: pricing.regularPrice,
      imageUrl: mavenImage(r),
      category: r.CN ?? null,
    });
  });
}

/**
 * Full Market Maven catalog crawl. A single-letter query makes the store
 * API return its entire catalog (verified: ~7,700 products, 120 per
 * page, no overlap between pages), so page through all of it with a
 * small worker pool. The crawl UPSERTS by SKU instead of replacing the
 * Maven side wholesale: existing products keep their row (and their
 * first-seen date) with price/sale flag refreshed, SKUs the catalog has
 * never seen are inserted and counted as new products, and catalog rows
 * Rows whose SKU a crawl does not see are left in place — a short
 * or partial page must never silently discontinue products; unseen
 * rows simply age out of the serve window on their own. This
 * one weekly pass is Market Maven's whole recheck story — specials
 * (the SP flag rides on every row), the rolling monthly price check
 * (it exceeds it), and new-product detection.
 */
async function crawlMavenCatalog(
  ctx: Ctx,
): Promise<{ count: number; newCount: number }> {
  const first = await fetchMavenPage(API_WHOLE_CATALOG_QUERY, 1);
  const total = first.count > 0 ? first.count : first.rows.length;
  const pageCount = Math.max(1, Math.ceil(total / API_PAGE_SIZE));
  const byKey = new Map<string, MavenRaw>();
  const add = (rows: MavenRaw[]) => {
    for (const r of rows) {
      const key = r.SKU || r.N;
      if (key) byKey.set(key, r);
    }
  };
  add(first.rows);
  const queue: number[] = [];
  for (let p = 2; p <= pageCount; p++) queue.push(p);
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const p = queue.shift();
      if (p === undefined) return;
      const page = await fetchMavenPage(API_WHOLE_CATALOG_QUERY, p);
      add(page.rows);
    }
  });
  await Promise.all(workers);

  const now = new Date();
  const crawled = [...byKey.values()].filter((r) => r.N && mavenPrice(r) > 0);
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.store, API_STORE.key));
  const bySku = new Map<string, CatalogRow>();
  const byNorm = new Map<string, CatalogRow>();
  for (const r of existing) {
    if (r.externalId) bySku.set(r.externalId, r);
    if (!byNorm.has(r.nameNorm)) byNorm.set(r.nameNorm, r);
  }
  const matchedIds = new Set<number>();
  const inserts: (typeof schema.catalogProducts.$inferInsert)[] = [];
  // Changed rows are collected and written in ONE batched statement —
  // a per-row awaited UPDATE per product (~7,700 round trips) pushed a
  // forced sync past the two-minute action limit in testing.
  const updateStmts: BatchItem<"sqlite">[] = [];
  const history: Parameters<typeof recordPriceHistory>[1] = [];
  let newCount = 0;
  for (const r of crawled) {
    const norm = normalizeName(r.N!);
    const row =
      (r.SKU ? bySku.get(r.SKU) : undefined) ?? byNorm.get(norm);
    if (row) {
      matchedIds.add(row.id);
      const pricing = mavenPricing(r);
      const price = pricing.price;
      const onSale = r.SP === true;
      const imageUrl = mavenImage(r);
      // Skip the write entirely when nothing the board shows changed —
      // on a typical week that's most of the catalog. lastSeenAt still
      // advances via the single sweep UPDATE below. The deal fields
      // are part of the comparison, so a product whose deal starts or
      // ends (same listed total, different per-item price) rewrites.
      const unchanged =
        row.price === price &&
        row.onSale === onSale &&
        row.name === r.N &&
        row.priceText === (r.P ?? null) &&
        (row.category ?? null) === (r.CN ?? row.category ?? null) &&
        (row.dealText ?? null) === (pricing.deal?.text ?? null) &&
        (row.dealQty ?? null) === (pricing.deal?.qty ?? null) &&
        (row.dealTotal ?? null) === (pricing.deal?.total ?? null) &&
        (row.regularPrice ?? null) === pricing.regularPrice &&
        (imageUrl == null || row.imageUrl === imageUrl) &&
        row.firstSeenAt != null;
      if (!unchanged) {
        if (
          row.price !== price ||
          row.onSale !== onSale ||
          (row.dealText ?? null) !== (pricing.deal?.text ?? null)
        ) {
          history.push({
            productId: row.id,
            store: API_STORE.key,
            price,
            onSale,
            dealText: pricing.deal?.text ?? null,
            observedAt: now,
          });
        }
        updateStmts.push(
          db
            .update(schema.catalogProducts)
            .set({
              externalId: r.SKU ?? row.externalId,
              name: r.N!,
              nameNorm: norm,
              category: r.CN ?? row.category,
              price,
              priceText: r.P ?? null,
              onSale,
              dealText: pricing.deal?.text ?? null,
              dealQty: pricing.deal?.qty ?? null,
              dealTotal: pricing.deal?.total ?? null,
              regularPrice: pricing.regularPrice,
              imageUrl: imageUrl ?? row.imageUrl,
              // Rows from before the first_seen_at column keep the
              // migration's backfill; only a null gets stamped, so a
              // long-known product never turns "new" on a re-crawl.
              firstSeenAt: row.firstSeenAt ?? now,
            })
            .where(eq(schema.catalogProducts.id, row.id)),
        );
      }
    } else if (!inserts.some((i) => i.nameNorm === norm)) {
      const pricing = mavenPricing(r);
      inserts.push({
        store: API_STORE.key,
        externalId: r.SKU ?? null,
        name: r.N!,
        nameNorm: norm,
        category: r.CN ?? null,
        price: pricing.price,
        priceText: r.P ?? null,
        onSale: r.SP === true,
        dealText: pricing.deal?.text ?? null,
        dealQty: pricing.deal?.qty ?? null,
        dealTotal: pricing.deal?.total ?? null,
        regularPrice: pricing.regularPrice,
        imageUrl: mavenImage(r),
        lastSeenAt: now,
        firstSeenAt: now,
      });
      newCount++;
    }
  }
  for (let i = 0; i < updateStmts.length; i += 400) {
    const chunk = updateStmts.slice(i, i + 400);
    const [firstStmt, ...restStmts] = chunk;
    if (firstStmt) await db.batch([firstStmt, ...restStmts]);
  }
  for (let i = 0; i < inserts.length; i += 400) {
    const chunk = inserts.slice(i, i + 400);
    if (chunk.length > 0) {
      const returned = await db
        .insert(schema.catalogProducts)
        .values(chunk)
        .returning({
          id: schema.catalogProducts.id,
          nameNorm: schema.catalogProducts.nameNorm,
        });
      for (const r of returned) {
        const srcItem = chunk.find((i) => i.nameNorm === r.nameNorm);
        if (srcItem) {
          history.push({
            productId: r.id,
            store: API_STORE.key,
            price: srcItem.price,
            onSale: srcItem.onSale ?? false,
            dealText: srcItem.dealText ?? null,
            observedAt: now,
          });
        }
      }
    }
  }
  await recordPriceHistory(ctx, history);
  // One sweep statement advances lastSeenAt for everything the store
  // still lists (matched above), instead of stamping it row by row.
  if (matchedIds.size > 0) {
    const matched = [...matchedIds];
    for (let i = 0; i < matched.length; i += 400) {
      const chunk = matched.slice(i, i + 400);
      if (chunk.length > 0) {
        await db
          .update(schema.catalogProducts)
          .set({ lastSeenAt: now })
          .where(inArray(schema.catalogProducts.id, chunk));
      }
    }
  }
  // SKUs this crawl did not see are deliberately NOT deleted: a
  // short or partial page would otherwise silently discontinue
  // products the store still sells. Unseen rows keep their old
  // lastSeenAt, so they age out of the serve window
  // (CATALOG_SERVE_MS) and stop being quoted, while price_history
  // keeps the record of what they cost.
  const count = await catalogCount(ctx, API_STORE.key);
  await setSyncRow(ctx, API_STORE.key, {
    status: "ok",
    productCount: count,
    lastSyncAt: now,
    error: null,
  });
  return { count, newCount };
}

// ---------- Market Maven accuracy spot checks ----------

type SpotResult = "match" | "mismatch" | "not_found" | "error";

type SpotRow = {
  productName: string;
  externalId: string | null;
  catalogPrice: number;
  livePrice: number | null;
  catalogOnSale: boolean;
  liveOnSale: boolean | null;
  result: SpotResult;
};

/** Find one product in the live store API by SKU (name match as fallback). */
async function fetchMavenLiveRow(sample: CatalogRow): Promise<MavenRaw | null> {
  for (let page = 1; page <= 4; page++) {
    const { rows } = await fetchMavenPage(sample.name, page);
    const hit =
      rows.find((r) => sample.externalId != null && r.SKU === sample.externalId) ??
      rows.find((r) => normalizeName(r.N ?? "") === sample.nameNorm);
    if (hit) return hit;
    if (rows.length < API_PAGE_SIZE) return null;
  }
  return null;
}

/**
 * Spot-check the Market Maven catalog against the live store API:
 * sample products spread evenly across the whole catalog plus extra
 * on-sale ones (sale flags are the volatile part), re-fetch each one
 * live, and compare stored vs live price and sale flag. Mismatches are
 * corrected in the catalog from the live values, so a check also heals
 * the rows it sampled. Results replace the previous run in spot_checks.
 */
async function runMavenSpotCheck(ctx: Ctx): Promise<{
  checkedAt: string;
  total: number;
  matched: number;
  mismatched: number;
  notFound: number;
  errors: number;
  results: SpotRow[];
}> {
  const db = ctx.db<typeof schema>();
  const all = await db
    .select()
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.store, API_STORE.key))
    .orderBy(asc(schema.catalogProducts.id));
  const sample: CatalogRow[] = [];
  const SAMPLE_N = 10;
  if (all.length > 0) {
    const stride = Math.max(1, Math.floor(all.length / SAMPLE_N));
    for (let i = 0; i < all.length && sample.length < SAMPLE_N; i += stride) {
      const row = all[i];
      if (row) sample.push(row);
    }
  }
  const inSample = new Set(sample.map((r) => r.id));
  for (const r of all) {
    if (sample.length >= SAMPLE_N + 3) break;
    if (r.onSale && !inSample.has(r.id)) {
      sample.push(r);
      inSample.add(r.id);
    }
  }
  // Multi-buy deal products get sampled deliberately too: their
  // stored price is a computed per-item price, so the check verifies
  // the deal math against the live feed, not just plain prices.
  for (const r of all) {
    if (sample.length >= SAMPLE_N + 6) break;
    if (r.dealQty != null && r.dealQty > 1 && !inSample.has(r.id)) {
      sample.push(r);
      inSample.add(r.id);
    }
  }

  const now = new Date();
  const results: SpotRow[] = [];
  for (const s of sample) {
    const base: SpotRow = {
      productName: s.name,
      externalId: s.externalId,
      catalogPrice: s.price,
      livePrice: null,
      catalogOnSale: s.onSale,
      liveOnSale: null,
      result: "error",
    };
    try {
      const live = await fetchMavenLiveRow(s);
      if (!live) {
        results.push({ ...base, result: "not_found" });
        continue;
      }
      const livePricing = mavenPricing(live);
      const livePrice = livePricing.price;
      const liveOnSale = live.SP === true;
      const liveDealText = livePricing.deal?.text ?? null;
      const result: SpotResult =
        Math.abs(livePrice - s.price) < 0.005 &&
        liveOnSale === s.onSale &&
        liveDealText === (s.dealText ?? null)
          ? "match"
          : "mismatch";
      if (result === "mismatch") {
        // Heal the catalog row from the live values — and record the
        // corrected price in history, like every other price change.
        if (Math.abs(livePrice - s.price) >= 0.005 || liveOnSale !== s.onSale) {
          await recordPriceHistory(ctx, [
            {
              productId: s.id,
              store: API_STORE.key,
              price: livePrice,
              onSale: liveOnSale,
              dealText: liveDealText,
              observedAt: now,
            },
          ]);
        }
        await db
          .update(schema.catalogProducts)
          .set({
            price: livePrice,
            priceText: live.P ?? s.priceText,
            onSale: liveOnSale,
            dealText: liveDealText,
            dealQty: livePricing.deal?.qty ?? null,
            dealTotal: livePricing.deal?.total ?? null,
            regularPrice: livePricing.regularPrice,
            lastSeenAt: now,
          })
          .where(eq(schema.catalogProducts.id, s.id));
      }
      results.push({ ...base, livePrice, liveOnSale, result });
    } catch {
      results.push(base);
    }
  }

  await db.delete(schema.spotChecks);
  if (results.length > 0) {
    await db.insert(schema.spotChecks).values(
      results.map((r) => ({
        store: STORE_KEYS[0],
        productName: r.productName,
        externalId: r.externalId,
        catalogPrice: r.catalogPrice,
        livePrice: r.livePrice,
        catalogOnSale: r.catalogOnSale,
        liveOnSale: r.liveOnSale,
        result: r.result,
        checkedAt: now,
      })),
    );
  }
  return {
    checkedAt: now.toISOString(),
    total: results.length,
    matched: results.filter((r) => r.result === "match").length,
    mismatched: results.filter((r) => r.result === "mismatch").length,
    notFound: results.filter((r) => r.result === "not_found").length,
    errors: results.filter((r) => r.result === "error").length,
    results,
  };
}

// ---------- snapshot helpers ----------

async function upsertSnapshot(
  ctx: Ctx,
  watchItemId: number,
  store: Store,
  values: Partial<{
    status: "ok" | "pending" | "error";
    checkedAt: Date | null;
    pendingSince: Date | null;
    error: string | null;
    products: string;
  }>,
) {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.snapshots)
    .where(eq(schema.snapshots.watchItemId, watchItemId));
  const row = existing.find((r) => r.store === store);
  if (row) {
    await db
      .update(schema.snapshots)
      .set(values)
      .where(eq(schema.snapshots.id, row.id));
  } else {
    await db.insert(schema.snapshots).values({
      watchItemId,
      store,
      status: values.status ?? "pending",
      checkedAt: values.checkedAt ?? null,
      pendingSince: values.pendingSince ?? null,
      error: values.error ?? null,
      products: values.products ?? "[]",
    });
  }
}

/** Fill a watch item's snapshot from the catalog when the data is fresh enough. */
async function fillSnapshotFromCatalog(
  ctx: Ctx,
  item: { id: number; query: string },
  store: Store,
  maxAgeMs: number,
): Promise<boolean> {
  const m = await catalogMatch(ctx, store, item.query);
  if (m.products.length === 0 || !m.newestSeenAt) return false;
  if (Date.now() - m.newestSeenAt.getTime() > maxAgeMs) return false;
  await upsertSnapshot(ctx, item.id, store, {
    status: "ok",
    checkedAt: m.newestSeenAt,
    error: null,
    pendingSince: null,
    products: JSON.stringify(m.products),
  });
  return true;
}

async function refreshMavenFor(ctx: Ctx, items: { id: number; query: string }[]) {
  await Promise.all(
    items.map(async (item) => {
      // Catalog first: the weekly full crawl keeps Maven prices current
      // enough that a live fetch is only needed for items the catalog
      // doesn't know yet.
      if (await fillSnapshotFromCatalog(ctx, item, API_STORE.key, CATALOG_SERVE_MS)) return;
      try {
        const products = await fetchMaven(item.query);
        await upsertSnapshot(ctx, item.id, API_STORE.key, {
          status: "ok",
          checkedAt: new Date(),
          error: null,
          products: JSON.stringify(products),
        });
        await upsertLearnedProducts(ctx, API_STORE.key, products);
      } catch (e) {
        await upsertSnapshot(ctx, item.id, API_STORE.key, {
          status: "error",
          error: e instanceof Error ? e.message : "Market Maven check failed",
        });
      }
    }),
  );
}

/** Resolve any still-pending Seven Mile snapshots from catalog data. */
async function fillPendingSevenSnapshots(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const snaps = await db.select().from(schema.snapshots);
  const pending = snaps.filter((s) => s.store === BROWSER_STORE.key && s.status === "pending");
  if (pending.length === 0) return;
  const items = await db.select().from(schema.watchItems);
  for (const s of pending) {
    const item = items.find((i) => i.id === s.watchItemId);
    if (item) await fillSnapshotFromCatalog(ctx, item, BROWSER_STORE.key, CATALOG_SERVE_MS);
  }
}

// ---------- Seven Mile background indexing ----------

// Store sections the indexing agent sweeps, on top of the specials page
// and one section per watchlist item.
const STAPLE_TERMS = [
  "milk", "eggs", "butter", "cheese", "yogurt", "cream cheese", "sour cream",
  "bread", "bagels", "rolls", "challah", "pita",
  "chicken", "ground beef", "steak", "turkey", "salmon", "tuna",
  "pasta", "rice", "cereal", "flour", "sugar",
  "olive oil", "vegetable oil", "coffee", "tea", "orange juice", "soda",
  "chips", "cookies", "crackers", "candy", "ice cream",
  "frozen vegetables", "french fries",
  "apples", "bananas", "potatoes", "onions", "tomatoes", "lettuce", "carrots",
  "ketchup", "mayonnaise", "peanut butter", "jam", "honey", "canned soup", "canned beans",
  "paper towels", "toilet paper", "dish soap", "laundry detergent",
];

async function seedSevenSections(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.catalogSections)
    .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
  const have = new Set(existing.map((s) => `${s.kind}:${s.term.toLowerCase()}`));
  const toAdd: (typeof schema.catalogSections.$inferInsert)[] = [];
  // The discovery section reads the store's own sitemap page and seeds
  // one "category" section per leaf category (via
  // saveDiscoveredCategories), so the sweep walks the store's real
  // category tree instead of only keyword searches.
  if (!have.has("discovery:sitemap")) {
    toAdd.push({ store: BROWSER_STORE.key, term: "Sitemap", kind: "discovery", status: "pending" });
  }
  if (!have.has("specials:specials")) {
    toAdd.push({ store: BROWSER_STORE.key, term: "Specials", kind: "specials", status: "pending" });
  }
  for (const term of STAPLE_TERMS) {
    if (!have.has(`search:${term}`)) {
      toAdd.push({ store: BROWSER_STORE.key, term, kind: "search", status: "pending" });
    }
  }
  const items = await db.select().from(schema.watchItems);
  for (const item of items) {
    if (!have.has(`watch:${item.query.toLowerCase()}`)) {
      toAdd.push({ store: BROWSER_STORE.key, term: item.query, kind: "watch", status: "pending" });
    }
  }
  if (toAdd.length > 0) await db.insert(schema.catalogSections).values(toAdd);
}

/** Make sure a watch query has a Seven Mile section queued; re-queue it if asked to. */
async function ensureWatchSection(ctx: Ctx, query: string, requeue: boolean) {
  const db = ctx.db<typeof schema>();
  const sections = await db
    .select()
    .from(schema.catalogSections)
    .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
  const row = sections.find(
    (s) => s.kind === "watch" && s.term.toLowerCase() === query.toLowerCase(),
  );
  if (!row) {
    await db.insert(schema.catalogSections).values({
      store: BROWSER_STORE.key,
      term: query,
      kind: "watch",
      status: "pending",
    });
  } else if (requeue && (row.status === "done" || row.status === "error")) {
    await db
      .update(schema.catalogSections)
      .set({ status: "pending", attempts: 0, lastError: null, updatedAt: new Date() })
      .where(eq(schema.catalogSections.id, row.id));
  }
}

const KIND_RANK = { discovery: 0, watch: 1, specials: 2, category: 3, search: 4 } as const;

// A claimed section whose agent never saves is presumed dead after this
// long. The agent saves each section as it finishes it, and every save
// stamps updatedAt — so a live batch heartbeats well inside this window.
const SEVEN_STALE_RUNNING_MS = 10 * 60 * 1000;
// A section gets this many dispatches; if every one times out or fails,
// it lands in "error" (visible on the board, retried on the next sync or
// manual refresh) instead of silently blocking the sweep forever.
const SEVEN_MAX_ATTEMPTS = 3;
// A section whose saves keep coming back short of the total the store
// itself reported is re-queued while each pass still adds new products
// (a stall — a pass that adds nothing — stops it sooner). After this
// many total dispatches a still-short section is accepted as done with
// the shortfall recorded, so one stubborn page can't loop forever.
const SEVEN_MAX_PASSES = 6;
// Page loads may kick the sweep opportunistically, but at most this often.
const SEVEN_KICK_COOLDOWN_MS = 60 * 1000;

/**
 * Start the next Seven Mile indexing batch if none is running. Each save
 * (saveCatalogResults) calls this again, so batches chain until every
 * section is indexed. Dead batches are reaped here: a section claimed
 * SEVEN_STALE_RUNNING_MS ago with no save since is re-queued with the
 * timeout recorded, or moved to "error" once its attempts run out — a
 * stall can no longer wedge the sweep the way the first batch did when
 * its agent died without calling back.
 */
async function kickSevenCrawl(
  ctx: Ctx,
  opts?: { opportunistic?: boolean },
): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const sections = await db
    .select()
    .from(schema.catalogSections)
    .where(eq(schema.catalogSections.store, BROWSER_STORE.key))
    .orderBy(asc(schema.catalogSections.id));
  const now = Date.now();
  const nowDate = new Date(now);

  for (const s of sections) {
    if (s.status !== "running") continue;
    const claimedAt = s.updatedAt ? s.updatedAt.getTime() : 0;
    if (now - claimedAt <= SEVEN_STALE_RUNNING_MS) continue;
    const exhausted = s.attempts >= SEVEN_MAX_ATTEMPTS;
    await db
      .update(schema.catalogSections)
      .set({
        status: exhausted ? "error" : "pending",
        lastError: exhausted
          ? `Indexing timed out ${s.attempts} times without saving — will retry on the next sync or refresh.`
          : "Indexing timed out before any results were saved — re-queued.",
        updatedAt: nowDate,
      })
      .where(eq(schema.catalogSections.id, s.id));
    s.status = exhausted ? "error" : "pending";
  }
  if (sections.some((s) => s.status === "running")) return false;

  // Opportunistic kicks (page loads) respect a cooldown so a burst of
  // board polls can't each reap-and-claim; deliberate kicks (sync,
  // refresh, save-chains, the hourly watchdog) always go through.
  if (opts?.opportunistic) {
    const sync = await getSyncRow(ctx, BROWSER_STORE.key);
    if (
      sync?.lastKickAt &&
      now - sync.lastKickAt.getTime() < SEVEN_KICK_COOLDOWN_MS
    ) {
      return false;
    }
  }

  const pending = sections
    .filter((s) => s.status === "pending")
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id - b.id);
  const top = pending[0];
  if (!top) return false;
  // Discovery runs alone (its save seeds the category sections the rest
  // of the sweep then works through). Leaf-category sections are small
  // and bounded, so they batch wider; everything else keeps the narrow
  // batch that bounds how much work a dead agent can lose.
  const limit =
    top.kind === "discovery" ? 1 : top.kind === "category" ? 8 : 4;
  const candidates = pending.slice(0, limit);
  if (candidates.length === 0) return false;

  // Claim atomically: each conditional update lands only while the
  // section is still pending, so two kicks racing each other can never
  // both dispatch an agent for the same section — the loser claims
  // nothing and spawns nothing.
  const batch: typeof candidates = [];
  for (const s of candidates) {
    const claimed = await db
      .update(schema.catalogSections)
      .set({
        status: "running",
        attempts: sql`${schema.catalogSections.attempts} + 1`,
        updatedAt: nowDate,
      })
      .where(
        and(
          eq(schema.catalogSections.id, s.id),
          eq(schema.catalogSections.status, "pending"),
        ),
      )
      .returning({ id: schema.catalogSections.id });
    if (claimed.length > 0) batch.push(s);
  }
  if (batch.length === 0) return false;

  await setSyncRow(ctx, BROWSER_STORE.key, {
    status: "running",
    error: null,
    lastKickAt: nowDate,
  });
  const isDiscovery = batch[0]?.kind === "discovery";
  const lines = batch
    .map((s) => {
      if (s.kind === "specials")
        return `- sectionId ${s.id}: SPECIALS — open the store's specials / weekly deals page (look for a "Specials", "Weekly Ad", or "Deals" link) and record every product on it.`;
      if (s.kind === "category")
        return `- sectionId ${s.id}: CATEGORY — open ${BROWSER_STORE.homepage}${s.term} and record every product listed on that category page.`;
      return `- sectionId ${s.id}: use the store search for "${s.term}" and record the results.`;
    })
    .join("\n");
  const taskText = isDiscovery
    ? `You are mapping Seven Mile Market's online store so a price-comparison database can index every category it sells.

1. Open ${BROWSER_STORE.homepage}sitemap in the browser (it may show a brief Cloudflare check — wait for the real page to load).
2. That page lists the store's categories as links whose URLs look like /categories/12345/products. Collect EVERY category link on the page: the visible link text and the URL path (path only, starting with /categories/). There are several hundred — work through the whole page top to bottom; do not sample or stop early.
3. Save them with ONE call to the artifact action "saveDiscoveredCategories" on the artifact with slug "${ctx.slug}", with arguments:
{ "sectionId": ${batch[0]?.id}, "categories": [ { "name": "...", "path": "/categories/12345/products" } ], "error": null }
If the store cannot be reached, still make the call with "categories": [] and a short "error" string describing what went wrong.`
    : `You are indexing Seven Mile Market's online store into a price-comparison database. Work through the assignments below, saving EACH assignment as soon as you finish it — do not wait until the end to save.

1. Open ${BROWSER_STORE.homepage} in the browser (it may show a brief Cloudflare check — wait for the real store to load).
2. Assignments:
${lines}
For each assignment, page or scroll through the results until the store shows no more products, and record EVERY product shown — there is NO per-assignment limit. (An earlier version of this sweep capped assignments at 40 products and silently truncated the index; that cap is the bug being fixed. Do not stop early, do not sample.) If the page displays a total for the assignment — a result count like "123 products" on a search or category page, or a set of facet/subcategory counts that add up to the total — report that number as "expectedCount" in your save; if the page shows no total, report null. For each product record, exactly as displayed: the full product name (including any size in the name), the listed price as a number, the size (see SIZES below — required), the category/department if the page shows one (otherwise null), and whether the product shows a sale / special badge or a strikethrough original price (onSale true/false). Products from the SPECIALS page are all onSale: true.
SIZES — REQUIRED FOR EVERY PRODUCT: each product tile on this store shows a small grey line directly ABOVE the product name in the form "Brand | size" — for example "Paskesz | 10 Oz" above "Mini White Chips", or "Lieber's | 0.75 Oz" above "Barbecue Potato Chips". That size is NOT part of the product name, and an earlier version of this sweep recorded only the name, which is why most of the database has no sizes — do not repeat that. For EVERY product, copy the size part of that line (everything after the "|") exactly as shown into the product's "sizeText" field — e.g. "10 Oz", "0.75 Oz", "5.2 Oz", "18 Oz", "48 ct", "12×12 Oz". Keep the product "name" as the tile's name text only (do not fold the brand or size into it). If a tile genuinely shows no such line, use "sizeText": null — never guess a size, and never copy a size from a neighboring product. Tiles with the SAME name but different sizes are DIFFERENT products (the store sells e.g. a 1 Oz bag and a 2.75 Oz bag under one name) — record each tile separately with its own size and price; do not merge them. You do NOT need to open a product's detail view for its size: it repeats the same line and adds nothing.
PER-POUND PRICES: meat, chicken, fish, and deli are often priced BY WEIGHT — the page shows the price with a unit, like "Sale price $7.99 / Lb" or "$7.99/Lb". When a price is shown per lb or per oz, copy the FULL displayed price text, including the "/ Lb", into the product's "priceText" field (e.g. "$7.99 / Lb"), and still record "price" as the dollar amount (7.99 — the price of ONE pound). A size in the name like "3 Lb" is just the pack size and does NOT by itself mean the price is per pound — only record priceText when the PRICE itself is displayed with "/ Lb" or "/ Oz" (or "per lb" / "per oz"). Products whose price has no per-weight unit get "priceText": null.
MULTI-BUY DEALS: if a product's price is a bundle deal — the page shows wording like "4 for $5.00", "2/$5", "Buy 1 Get 1 Free", or "BOGO 50% off" — copy that wording EXACTLY as shown into the product's "dealText" field, and still record "price" as the dollar amount displayed with the deal (for "4 for $5.00" that is 5.00, the bundle total; for a buy-get deal it is the single-item price shown). Do NOT do the division yourself — the server converts the deal into a per-item price. A product with no multi-buy wording gets "dealText": null. Do not put ordinary sale prices or strikethrough prices in dealText — only multi-buy wording.
3. As soon as you finish EACH assignment, save it with its own call to the artifact action "saveCatalogResults" on the artifact with slug "${ctx.slug}", with arguments:
{ "results": [ { "sectionId": <id>, "expectedCount": <number or null>, "products": [ { "name": "...", "price": 0.00, "sizeText": "10 Oz", "priceText": null, "onSale": false, "category": null, "dealText": null } ], "error": null } ] }
Send the entry for an assignment even if it found nothing ("products": []). If the store cannot be reached or an assignment fails, send "products": [] and a short "error" string for that assignment, then move on to the next one. Saving each assignment separately means finished work is never lost if a later assignment stalls. Never invent a price you did not see on the page.`;
  try {
    await ctx.agent.spawnTask(taskText, {
      expectsAction: isDiscovery ? "saveDiscoveredCategories" : "saveCatalogResults",
    });
    return true;
  } catch {
    // Task could not start; hand the sections back to the queue.
    for (const s of batch) {
      await db
        .update(schema.catalogSections)
        .set({
          status: "pending",
          lastError: "Indexing agent could not be started — re-queued.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.catalogSections.id, s.id),
            eq(schema.catalogSections.status, "running"),
          ),
        );
    }
    return false;
  }
}

/** Serve Seven Mile for the given items from the catalog; queue indexing for the rest. */
async function refreshSevenFor(
  ctx: Ctx,
  items: { id: number; query: string }[],
  force: boolean,
) {
  let queuedAny = false;
  for (const item of items) {
    if (!force && (await fillSnapshotFromCatalog(ctx, item, BROWSER_STORE.key, CATALOG_SERVE_MS))) {
      continue;
    }
    // No usable catalog data: show as checking and let the indexing
    // sweep pick the item up (watch sections sweep first).
    const db = ctx.db<typeof schema>();
    const snaps = await db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.watchItemId, item.id));
    const snap = snaps.find((s) => s.store === BROWSER_STORE.key);
    if (!snap || snap.status !== "pending") {
      await upsertSnapshot(ctx, item.id, BROWSER_STORE.key, {
        status: "pending",
        pendingSince: new Date(),
        error: null,
      });
    }
    await ensureWatchSection(ctx, item.query, force);
    queuedAny = true;
  }
  if (queuedAny) {
    await seedSevenSections(ctx);
    await kickSevenCrawl(ctx);
  }
}

// ---------- board ----------

const catalogStoreSchema = z.object({
  count: z.number(),
  status: z.enum(["ok", "running", "error", "none"]),
  lastSyncAt: z.string().nullable(),
  sectionsDone: z.number(),
  sectionsTotal: z.number(),
  sectionsErrored: z.number(),
  // Finished sections that still hold fewer distinct products than the
  // total the store itself reported for them — surfaced on the board so
  // a short sweep never reads as a complete one.
  sectionsShort: z.number(),
  lastError: z.string().nullable(),
  // Products whose first-seen date falls in the last week — genuinely
  // new to the catalog, not re-priced old ones.
  newThisWeek: z.number(),
  // Products currently flagged on special at this store — the true
  // total, not the (longer) list the board returns for the specials view.
  specialsCount: z.number(),
  // Price changes recorded for this store in price_history — the
  // standing proof prices are being tracked, not just overwritten.
  historyPoints: z.number(),
  // Products whose package size is known — a stored size_text, or a
  // size parseable from the name itself. This is the standing proof
  // that sizes are being captured (and, for Seven Mile, how much of
  // the pre-0013 catalog still awaits its size backfill).
  withSize: z.number(),
});

const spotCheckSchema = z.object({
  checkedAt: z.string(),
  total: z.number(),
  matched: z.number(),
  mismatched: z.number(),
  notFound: z.number(),
  errors: z.number(),
  results: z.array(
    z.object({
      productName: z.string(),
      catalogPrice: z.number(),
      livePrice: z.number().nullable(),
      catalogOnSale: z.boolean(),
      liveOnSale: z.boolean().nullable(),
      result: z.enum(["match", "mismatch", "not_found", "error"]),
    }),
  ),
});

async function loadBoard(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const items = await db
    .select()
    .from(schema.watchItems)
    .orderBy(asc(schema.watchItems.id));
  const snaps = await db.select().from(schema.snapshots);
  const view = items.map((item) => {
    const parseSide = (store: Store) => {
      const s = snaps.find((r) => r.watchItemId === item.id && r.store === store);
      if (!s) {
        return {
          status: "none" as SnapView["status"],
          checkedAt: null as string | null,
          error: null as string | null,
          products: [] as Product[],
        };
      }
      let products: Product[] = [];
      try {
        products = z.array(productSchema).parse(JSON.parse(s.products || "[]"));
      } catch {
        products = [];
      }
      // Snapshots saved before per-weight pricing was tracked carry
      // the synthetic "1 lb" / "1 oz" sizeText that only a per-weight
      // price ever produced — restore the basis from it so an old
      // card shows "/lb" (and its verdict stays honest) without
      // waiting for a re-check.
      products = products.map((p) =>
        p.priceBasis === "each" && (p.sizeText === "1 lb" || p.sizeText === "1 oz")
          ? {
              ...p,
              priceBasis:
                p.sizeText === "1 lb" ? ("per_lb" as const) : ("per_oz" as const),
            }
          : p,
      );
      // Re-sort by current relevance rules at read time, so snapshots
      // saved under older matching rank their alternates correctly too
      // (stable sort — equal scores keep the order they were saved in).
      products = scoredEntries(item.query, products)
        .map((e, i) => ({ p: e.item, i, s: e.score }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.p);
      return {
        status: s.status as SnapView["status"],
        checkedAt: s.checkedAt ? s.checkedAt.toISOString() : null,
        error: s.error,
        products,
      };
    };
    const mRaw = parseSide(API_STORE.key);
    const sRaw = parseSide(BROWSER_STORE.key);
    // Only directly comparable products speak for a store on the card:
    // when both sides have products, pair them up by kind and let the
    // paired products (and only they) drive the display and verdict.
    // Products with no counterpart at the other store are counted as
    // one-store-only instead of being lined up against a random
    // product from the other store.
    let mProds = mRaw.products;
    let sProds = sRaw.products;
    let pairsOut: {
      maven: Product;
      seven: Product;
      mavenMore: number;
      sevenMore: number;
      winner: StoreKey | "tie" | "none";
    }[] = [];
    let comparable = 0;
    let onlyCount = 0;
    let suppressVerdict = false;
    // When kinds pair up, the headline best/verdict come from the TOP
    // pair (the most relevant comparable kind) — comparing one store's
    // cheapest paired product against the other store's cheapest
    // paired product would still cross kinds (potato chips against
    // baking chips) and recreate the random-vs-random problem in the
    // verdict even with the pairs themselves correct.
    let bestM: Product | null = null;
    let bestS: Product | null = null;
    if (mRaw.products.length > 0 && sRaw.products.length > 0) {
      const pairing = pairProducts(item.query, mRaw.products, sRaw.products);
      if (pairing.pairs.length > 0) {
        comparable = pairing.pairs.length;
        onlyCount = pairing.mavenOnly.length + pairing.sevenOnly.length;
        mProds = pairing.pairs.flatMap((g) => g.maven);
        sProds = pairing.pairs.flatMap((g) => g.seven);
        pairsOut = pairing.pairs.slice(0, 6).map((g) => ({
          maven: g.maven[0]!,
          seven: g.seven[0]!,
          mavenMore: g.maven.length - 1,
          sevenMore: g.seven.length - 1,
          // The pair's winner is computed HERE, by the same verdict
          // rules as the card's header pill — the client renders it
          // and never re-derives it, so the two can't disagree.
          winner: verdictFor(
            { best: pickBest(g.maven, item.query) },
            { best: pickBest(g.seven, item.query) },
          ).winner,
        }));
        const top = pairing.pairs[0]!;
        bestM = pickBest(top.maven, item.query);
        bestS = pickBest(top.seven, item.query);
      } else {
        // No kind-level overlap in the full lists: the two headline
        // picks may still be the same product (a specific item the
        // user watches) — pair just those if they truly match.
        const bm = pickBest(mRaw.products, item.query);
        const bs = pickBest(sRaw.products, item.query);
        if (bm && bs && pairMatchTwo(item.query, bm, bs)) {
          comparable = 1;
          onlyCount =
            Math.max(0, mRaw.products.length - 1) +
            Math.max(0, sRaw.products.length - 1);
          mProds = [bm];
          sProds = [bs];
          pairsOut = [
            {
              maven: bm,
              seven: bs,
              mavenMore: 0,
              sevenMore: 0,
              winner: verdictFor({ best: bm }, { best: bs }).winner,
            },
          ];
        } else {
          onlyCount = mRaw.products.length + sRaw.products.length;
          suppressVerdict = true;
        }
      }
    }
    const maven: SnapView = {
      status: mRaw.status,
      checkedAt: mRaw.checkedAt,
      error: mRaw.error,
      products: mProds,
      best: bestM ?? (mProds.length > 0 ? pickBest(mProds, item.query) : null),
    };
    const seven: SnapView = {
      status: sRaw.status,
      checkedAt: sRaw.checkedAt,
      error: sRaw.error,
      products: sProds,
      best: bestS ?? (sProds.length > 0 ? pickBest(sProds, item.query) : null),
    };
    const verdict = suppressVerdict
      ? { winner: "none" as const, basis: null, diff: null, text: "" }
      : verdictFor(maven, seven);
    return {
      id: item.id,
      query: item.query,
      createdAt: item.createdAt.toISOString(),
      maven,
      seven,
      verdict,
      pairs: pairsOut,
      comparable,
      onlyCount,
    };
  });

  // Catalog summary + current specials across both stores.
  const syncRows = await db.select().from(schema.catalogSync);
  const sevenSections = await db
    .select()
    .from(schema.catalogSections)
    .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
  const summaryFor = async (store: Store) => {
    const sync = syncRows.find((r) => r.store === store);
    const errored =
      store === BROWSER_STORE.key ? sevenSections.filter((s) => s.status === "error") : [];
    const latestError = [...sevenSections]
      .filter((s) => s.lastError)
      .sort(
        (a, b) =>
          (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
      )[0];
    const newCutoff = new Date(Date.now() - NEW_PRODUCT_MS);
    const newRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.store, store),
          sql`${schema.catalogProducts.firstSeenAt} >= ${newCutoff.getTime()}`,
        ),
      );
    const saleCountRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.store, store),
          eq(schema.catalogProducts.onSale, true),
        ),
      );
    const historyRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.priceHistory)
      .where(eq(schema.priceHistory.store, store));
    const sizeRows = await db
      .select({ name: schema.catalogProducts.name, sizeText: schema.catalogProducts.sizeText })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.store, store));
    const withSize = sizeRows.filter(
      (r) => parseSize(r.sizeText ?? "") != null || parseSize(r.name) != null,
    ).length;
    return {
      count: await catalogCount(ctx, store),
      status: (sync?.status ?? "none") as "ok" | "running" | "error" | "none",
      lastSyncAt: sync?.lastSyncAt ? sync.lastSyncAt.toISOString() : null,
      sectionsDone:
        store === BROWSER_STORE.key ? sevenSections.filter((s) => s.status === "done").length : 0,
      sectionsTotal: store === BROWSER_STORE.key ? sevenSections.length : 0,
      sectionsErrored: errored.length,
      sectionsShort:
        store === BROWSER_STORE.key
          ? sevenSections.filter(
              (s) =>
                s.status === "done" &&
                s.expectedCount != null &&
                s.productCount < s.expectedCount,
            ).length
          : 0,
      lastError: store === BROWSER_STORE.key ? (latestError?.lastError ?? null) : null,
      newThisWeek: newRows[0]?.n ?? 0,
      specialsCount: saleCountRows[0]?.n ?? 0,
      historyPoints: historyRows[0]?.n ?? 0,
      withSize,
    };
  };
  // The specials view (opened from the front page, filtered by store)
  // shows up to 40 per store — the front page itself no longer rolls
  // these out, so the list can afford to be the full picture.
  const saleRows = await db
    .select()
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.onSale, true))
    .orderBy(sql`${schema.catalogProducts.lastSeenAt} desc`)
    .limit(200);
  const specials = [
    ...saleRows.filter((r) => r.store === API_STORE.key).slice(0, 40),
    ...saleRows.filter((r) => r.store === BROWSER_STORE.key).slice(0, 40),
  ]
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .map((r) => ({
      ...catalogRowToProduct(r),
      store: r.store,
      seenAt: r.lastSeenAt.toISOString(),
    }));

  // Products first seen in the last week at either store.
  const newCutoff = new Date(Date.now() - NEW_PRODUCT_MS);
  const freshRows = await db
    .select()
    .from(schema.catalogProducts)
    .where(sql`${schema.catalogProducts.firstSeenAt} >= ${newCutoff.getTime()}`)
    .orderBy(sql`${schema.catalogProducts.firstSeenAt} desc`)
    .limit(200);
  const newProducts = [
    ...freshRows.filter((r) => r.store === API_STORE.key).slice(0, 40),
    ...freshRows.filter((r) => r.store === BROWSER_STORE.key).slice(0, 40),
  ]
    .sort(
      (a, b) =>
        (b.firstSeenAt?.getTime() ?? 0) - (a.firstSeenAt?.getTime() ?? 0),
    )
    .map((r) => ({
      ...catalogRowToProduct(r),
      store: r.store,
      seenAt: (r.firstSeenAt ?? r.lastSeenAt).toISOString(),
    }));

  // Latest Market Maven accuracy spot check, if one has run.
  const spotRows = await db
    .select()
    .from(schema.spotChecks)
    .orderBy(asc(schema.spotChecks.id));
  const spotCheck =
    spotRows.length > 0
      ? {
          checkedAt: (spotRows[0]!.checkedAt).toISOString(),
          total: spotRows.length,
          matched: spotRows.filter((r) => r.result === "match").length,
          mismatched: spotRows.filter((r) => r.result === "mismatch").length,
          notFound: spotRows.filter((r) => r.result === "not_found").length,
          errors: spotRows.filter((r) => r.result === "error").length,
          results: spotRows.map((r) => ({
            productName: r.productName,
            catalogPrice: r.catalogPrice,
            livePrice: r.livePrice,
            catalogOnSale: r.catalogOnSale,
            liveOnSale: r.liveOnSale,
            result: r.result,
          })),
        }
      : null;

  return {
    items: view,
    catalog: { maven: await summaryFor(API_STORE.key), seven: await summaryFor(BROWSER_STORE.key) },
    specials,
    newProducts,
    spotCheck,
  };
}

const boardResponse = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      query: z.string(),
      createdAt: z.string(),
      maven: snapSchema,
      seven: snapSchema,
      verdict: verdictSchema,
      // Directly comparable product pairs for this item (representative
      // product per store per kind, plus how many more products of that
      // kind each store carries), how many kinds pair up at all, and
      // how many matched products have no counterpart at the other
      // store and are therefore left out of the comparison.
      pairs: z.array(
        z.object({
          maven: productSchema,
          seven: productSchema,
          mavenMore: z.number(),
          sevenMore: z.number(),
          // Server-computed winner for this pair (same verdict rules
          // as the header pill) — the client renders it as-is.
          winner: winnerEnum,
        }),
      ),
      comparable: z.number(),
      onlyCount: z.number(),
    }),
  ),
  catalog: z.object({ maven: catalogStoreSchema, seven: catalogStoreSchema }),
  specials: z.array(
    productSchema.extend({ store: storeEnum, seenAt: z.string() }),
  ),
  newProducts: z.array(
    productSchema.extend({ store: storeEnum, seenAt: z.string() }),
  ),
  spotCheck: spotCheckSchema.nullable(),
});

// ---------- barcode scan ----------

// A scanned barcode is resolved to a product once, then priced from the
// same catalog the board uses. Resolution order: the local barcode cache
// (barcode_mappings — every earlier scan, whether it came from Open Food
// Facts or was typed in by the user), then Open Food Facts
// (world.openfoodfacts.org/api/v2/product/<code>.json — free, no key,
// verified 2026-11-11: returns product_name / brands / quantity /
// image_url for most packaged groceries). A barcode no database knows is
// NOT guessed at: the UI asks what the product is, saves that answer as a
// manual mapping, and every later scan of the same barcode is instant.

function barcodeDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** The same product shows up as UPC-A (12 digits), EAN-13 (leading 0), etc. */
function barcodeVariants(digits: string): string[] {
  const set = new Set<string>([digits]);
  const stripped = digits.replace(/^0+/, "");
  if (stripped) {
    set.add(stripped);
    set.add(stripped.padStart(12, "0"));
    set.add(stripped.padStart(13, "0"));
  }
  return [...set];
}

async function findBarcodeMapping(ctx: Ctx, digits: string) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.barcodeMappings)
    .where(inArray(schema.barcodeMappings.barcode, barcodeVariants(digits)));
  return rows[0] ?? null;
}

async function saveBarcodeMapping(
  ctx: Ctx,
  values: {
    barcode: string;
    productName: string;
    brand: string | null;
    quantityText: string | null;
    imageUrl: string | null;
    source: "openfoodfacts" | "manual";
  },
) {
  const db = ctx.db<typeof schema>();
  const existing = await findBarcodeMapping(ctx, values.barcode);
  const now = new Date();
  if (existing) {
    await db
      .update(schema.barcodeMappings)
      .set({
        productName: values.productName,
        brand: values.brand ?? existing.brand,
        quantityText: values.quantityText ?? existing.quantityText,
        imageUrl: values.imageUrl ?? existing.imageUrl,
        source: values.source,
        lastSeenAt: now,
      })
      .where(eq(schema.barcodeMappings.id, existing.id));
    return;
  }
  await db.insert(schema.barcodeMappings).values({ ...values, lastSeenAt: now });
}

type OffProduct = {
  productName: string;
  brand: string | null;
  quantityText: string | null;
  imageUrl: string | null;
};

async function fetchOpenFoodFacts(ctx: Ctx, digits: string): Promise<OffProduct | null> {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(digits)}.json?fields=product_name,brands,quantity,image_url`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": `${ctx.slug} (personal grocery price tool)` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: number;
      product?: {
        product_name?: string;
        brands?: string;
        quantity?: string;
        image_url?: string;
      };
    };
    const name = data.product?.product_name?.trim();
    if (data.status !== 1 || !name) return null;
    return {
      productName: name,
      brand: data.product?.brands?.trim() || null,
      quantityText: data.product?.quantity?.trim() || null,
      imageUrl: data.product?.image_url ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function emptySnap(status: SnapView["status"]): SnapView {
  return { status, checkedAt: null, error: null, products: [], best: null };
}

function snapFromCatalogMatch(m: CatalogMatch, query?: string): SnapView {
  if (m.products.length === 0) return emptySnap("ok");
  return {
    status: "ok",
    checkedAt: m.newestSeenAt ? m.newestSeenAt.toISOString() : null,
    error: null,
    products: m.products,
    best: pickBest(m.products, query),
  };
}

/**
 * Price one identified product at both stores from the catalog. Tries the
 * product name, then brand + name, then a shortened name, and keeps the
 * candidate with the most matches per store. Market Maven also gets a
 * live API check when the catalog misses (its API searches by relevance).
 * A Seven Mile miss queues that product for the background indexing sweep
 * and reports "pending" so the result fills in on its own.
 */
async function priceIdentifiedProduct(
  ctx: Ctx,
  productName: string,
  brand: string | null,
): Promise<{ maven: SnapView; seven: SnapView; searchQuery: string }> {
  const firstBrand = brand?.split(",")[0]?.trim() || null;
  const nameWords = productName.split(/\s+/).filter(Boolean);
  const candidates = [
    ...new Set(
      [
        productName,
        firstBrand && firstBrand.toLowerCase() !== productName.toLowerCase()
          ? `${firstBrand} ${productName}`
          : null,
        nameWords.length > 2 ? nameWords.slice(0, 2).join(" ") : null,
      ].filter((c): c is string => !!c),
    ),
  ];

  const bestMatch = async (store: Store) => {
    let best: (CatalogMatch & { query: string }) | null = null;
    for (const q of candidates) {
      const m = await catalogMatch(ctx, store, q);
      if (m.products.length > 0 && (!best || m.products.length > best.products.length)) {
        best = { ...m, query: q };
        if (best.products.length >= 4) break;
      }
    }
    return best;
  };

  const mavenMatch = await bestMatch(API_STORE.key);
  let maven: SnapView;
  let searchQuery = mavenMatch?.query ?? productName;
  if (mavenMatch && mavenMatch.products.length > 0) {
    maven = snapFromCatalogMatch(mavenMatch, mavenMatch.query);
  } else {
    try {
      const live = await fetchMaven(productName);
      if (live.length > 0) {
        maven = {
          status: "ok",
          checkedAt: new Date().toISOString(),
          error: null,
          products: live,
          best: pickBest(live, productName),
        };
        await upsertLearnedProducts(ctx, API_STORE.key, live);
      } else {
        maven = emptySnap("ok");
      }
    } catch {
      maven = emptySnap("ok");
    }
  }

  const sevenMatch = await bestMatch(BROWSER_STORE.key);
  if (!mavenMatch && sevenMatch) searchQuery = sevenMatch.query;
  let seven: SnapView;
  if (sevenMatch && sevenMatch.products.length > 0) {
    seven = snapFromCatalogMatch(sevenMatch, sevenMatch.query);
  } else {
    await ensureWatchSection(ctx, productName, false);
    await seedSevenSections(ctx);
    await kickSevenCrawl(ctx);
    seven = emptySnap("pending");
  }
  return { maven, seven, searchQuery };
}

const barcodeLookupResponse = z.object({
  barcode: z.string(),
  resolved: z.boolean(),
  productName: z.string().nullable(),
  brand: z.string().nullable(),
  quantityText: z.string().nullable(),
  imageUrl: z.string().nullable(),
  source: z.enum(["cache", "openfoodfacts", "manual"]).nullable(),
  searchQuery: z.string().nullable(),
  maven: snapSchema,
  seven: snapSchema,
  verdict: verdictSchema,
});
type BarcodeLookup = z.infer<typeof barcodeLookupResponse>;

async function buildBarcodeResult(
  ctx: Ctx,
  digits: string,
  product: {
    productName: string;
    brand: string | null;
    quantityText: string | null;
    imageUrl: string | null;
  },
  source: BarcodeLookup["source"],
): Promise<BarcodeLookup> {
  const { maven, seven, searchQuery } = await priceIdentifiedProduct(
    ctx,
    product.productName,
    product.brand,
  );
  return {
    barcode: digits,
    resolved: true,
    productName: product.productName,
    brand: product.brand,
    quantityText: product.quantityText,
    imageUrl: product.imageUrl,
    source,
    searchQuery,
    maven,
    seven,
    verdict: verdictFor(maven, seven),
  };
}

// ---------- shopping list / recipe compare + brand preferences ----------

// The user pastes a shopping list or a whole recipe; the artifact prices
// the whole thing at both stores and names the exact product (brand,
// size) behind every quote — never just a store total with the products
// hidden. Brand preferences (brand_preferences) bend the picking: when
// the user has a preferred brand for an item, that brand's product is
// quoted at each store that carries it, even when a different brand is
// cheaper, and the quote says so (with what the cheapest option would
// have cost). Parsing a recipe into buyable items is a bounded
// transformation over text the user supplied, so it runs through
// ctx.inference; plain line-by-line lists also fall back to a local
// line parser if inference is unavailable.

type BrandPref = { keyword: string; brand: string };

async function loadBrandPrefs(ctx: Ctx): Promise<BrandPref[]> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.brandPreferences)
    .orderBy(asc(schema.brandPreferences.id));
  return rows.map((r) => ({ keyword: r.keyword, brand: r.brand }));
}

/** Does a saved preference apply to this ingredient name? */
function prefApplies(prefKeyword: string, ingredient: string): boolean {
  const kw = queryTokens(prefKeyword);
  const ing = queryTokens(ingredient);
  if (kw.length === 0 || ing.length === 0) return false;
  // "milk" applies to "whole milk"; "olive oil" applies to "olive oil".
  if (kw.every((t) => ing.includes(t))) return true;
  // A preference saved for a specific phrasing ("whole milk") also
  // applies to the plainer list line ("milk").
  if (ing.every((t) => kw.includes(t))) return true;
  return false;
}

function prefsFor(prefs: BrandPref[], ingredient: string): BrandPref[] {
  return prefs.filter((p) => prefApplies(p.keyword, ingredient));
}

/** Distinctive brand tokens (drop glue words) for matching product names. */
function brandTokens(brand: string): string[] {
  return queryTokens(brand).filter(
    (t) => !["of", "the", "a", "an", "and"].includes(t) && t.length > 1,
  );
}

/** Local fallback parser: one item per line, quantity prefix split off. */
function parseListLines(text: string): { name: string; quantityText: string | null }[] {
  const out: { name: string; quantityText: string | null }[] = [];
  for (const rawLine of text.split(/\n|;/)) {
    let line = rawLine.trim().replace(/^[-*•\d.)\s]+/, "").trim();
    if (!line) continue;
    // "milk x2" / "2 x milk"
    let quantityText: string | null = null;
    const lead = line.match(
      /^(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?\s*(?:x|×)?\s*(?:cups?|tbsp\.?|tablespoons?|tsp\.?|teaspoons?|oz|lb|lbs|g|kg|ml|l|pack|packs|can|cans|bag|bags|box|boxes|bunch|bunches|cloves?|heads?)?)\s+(.+)$/i,
    );
    if (lead && lead[2]) {
      quantityText = (lead[1] ?? "").trim() || null;
      line = lead[2].trim();
    }
    const trail = line.match(/^(.+?)\s*[x×]\s*(\d+)$/i);
    if (trail && trail[1]) {
      line = trail[1].trim();
      quantityText = `×${trail[2]}`;
    }
    // Drop parenthetical notes and trailing preparation words from recipes.
    line = line
      .replace(/\(.*?\)/g, " ")
      .replace(/,.*$/, "")
      .replace(/\s+(chopped|diced|minced|sliced|peeled|grated|crushed|melted|softened|divided|to taste|for serving|for garnish)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length >= 2 && line.length <= 80) {
      out.push({ name: line, quantityText });
    }
    if (out.length >= 30) break;
  }
  // Dedupe by normalized name, keeping the first quantity seen.
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = normalizeName(i.name);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Parse pasted text (shopping list or recipe) into buyable items. */
async function parseListText(
  ctx: Ctx,
  text: string,
): Promise<{ name: string; quantityText: string | null }[]> {
  try {
    const parsed = await ctx.inference.complete(
      `Extract the grocery items someone needs to BUY from the shopping list or recipe below. Return one entry per distinct buyable grocery item: ignore cooking instructions, equipment, and items a home kitchen already has (water, salt and pepper unless listed as a shopping item with a quantity to buy — include them if the text is a shopping list). Combine duplicate mentions of the same item. In "name", give just the item to search for in a grocery store (e.g. "chicken breast", "olive oil", "cheddar cheese") without quantities, brands mentioned in the text go in the name too if the text names one (e.g. "Gold's horseradish"). In "quantityText", copy the amount as written (e.g. "2 lb", "1/2 cup", "x3") or null when no amount is given.\n\nTEXT:\n${text.slice(0, 6000)}`,
      {
        schema: z.object({
          items: z.array(
            z.object({
              name: z.string(),
              quantityText: z.string().nullable(),
            }),
          ),
        }),
      },
    );
    const clean = parsed.items
      .map((i) => ({
        name: i.name.trim().replace(/\s+/g, " "),
        quantityText: i.quantityText?.trim() || null,
      }))
      .filter((i) => i.name.length >= 2 && i.name.length <= 80)
      .slice(0, 30);
    const seen = new Set<string>();
    const deduped = clean.filter((i) => {
      const k = normalizeName(i.name);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (deduped.length > 0) return deduped;
  } catch {
    // Inference unavailable — fall through to the line parser.
  }
  return parseListLines(text);
}

const listQuoteSchema = z.object({
  status: z.enum(["ok", "pending", "error", "none"]),
  checkedAt: z.string().nullable(),
  // The exact product this quote is for — brand and size are in the name.
  product: productSchema.nullable(),
  // True when the quoted product is the user's preferred brand, chosen
  // over a cheaper option on purpose.
  preferenceApplied: z.boolean(),
  preferenceBrand: z.string().nullable(),
  // Name/brand the user prefers but this store doesn't seem to carry.
  preferenceMissing: z.string().nullable(),
  // What the cheapest non-preferred match would have cost, when the
  // preference made this quote pricier — so the trade-off is visible.
  cheapestAltName: z.string().nullable(),
  cheapestAltPrice: z.number().nullable(),
  // What this line actually costs for the amount the list asks for:
  // a per-pound product's price × the pounds requested (1 lb when the
  // list gives no amount), or a packaged product × the whole packages
  // the requested weight takes. Null when there is no product, or
  // when the list asks for a weight the package size can't answer —
  // such a line stays out of the totals rather than guessing.
  cost: z.number().nullable().default(null),
});
type ListQuote = z.infer<typeof listQuoteSchema>;

function emptyQuote(status: ListQuote["status"]): ListQuote {
  return {
    status,
    checkedAt: null,
    product: null,
    preferenceApplied: false,
    preferenceBrand: null,
    preferenceMissing: null,
    cheapestAltName: null,
    cheapestAltPrice: null,
    cost: null,
  };
}


/**
 * Quote one ingredient at one store for a list compare: preferred-brand
 * products first (when the user has a preference for this item), the
 * catalog's best regular match otherwise. Market Maven gets a live API
 * check on a catalog miss; a Seven Mile miss queues indexing and reads
 * back as "pending".
 */
async function quoteListItemAtStore(
  ctx: Ctx,
  store: Store,
  ingredient: string,
  prefs: BrandPref[],
): Promise<ListQuote> {
  const generic = await catalogMatch(ctx, store, ingredient);
  const genericBest = pickBest(generic.products, ingredient);
  let chosen: Product | null = genericBest;
  let checkedAt: Date | null = generic.newestSeenAt;
  let preferenceApplied = false;
  let preferenceBrand: string | null = null;
  let preferenceMissing: string | null = null;
  let cheapestAltName: string | null = null;
  let cheapestAltPrice: number | null = null;

  for (const pref of prefs) {
    const tokens = brandTokens(pref.brand);
    if (tokens.length === 0) continue;
    const brandMatch = await catalogMatch(ctx, store, `${pref.brand} ${ingredient}`);
    const brandProducts = brandMatch.products.filter((p) => {
      const norm = normalizeName(p.name);
      return tokens.some((t) => norm.includes(t));
    });
    const brandBest = pickBest(brandProducts, ingredient);
    if (brandBest) {
      chosen = brandBest;
      preferenceApplied = true;
      preferenceBrand = pref.brand;
      if (brandMatch.newestSeenAt) checkedAt = brandMatch.newestSeenAt;
      if (genericBest && genericBest.name !== brandBest.name) {
        cheapestAltName = genericBest.name;
        cheapestAltPrice = genericBest.price;
      }
      break;
    }
    if (!preferenceMissing) preferenceMissing = pref.brand;
  }

  if (!chosen && store === API_STORE.key) {
    // Live check: the catalog may simply not know this item yet. When a
    // preference exists, ask the live API for the branded item first.
    const liveQueries = [
      ...(preferenceMissing ? [`${preferenceMissing} ${ingredient}`] : []),
      ingredient,
    ];
    for (const q of liveQueries) {
      try {
        const live = await fetchMaven(q);
        if (live.length === 0) continue;
        await upsertLearnedProducts(ctx, API_STORE.key, live);
        if (q !== ingredient) {
          const tokens = brandTokens(preferenceMissing ?? "");
          const branded = live.filter((p) =>
            tokens.some((t) => normalizeName(p.name).includes(t)),
          );
          const pick = pickBest(branded, ingredient);
          if (pick) {
            chosen = pick;
            preferenceApplied = true;
            preferenceBrand = preferenceMissing;
            preferenceMissing = null;
            checkedAt = new Date();
            break;
          }
          continue;
        }
        chosen = pickBest(live, ingredient);
        checkedAt = new Date();
        break;
      } catch {
        break;
      }
    }
  }

  if (!chosen) {
    if (store === BROWSER_STORE.key) {
      await ensureWatchSection(ctx, ingredient, false);
      return {
        ...emptyQuote("pending"),
        preferenceMissing,
      };
    }
    return { ...emptyQuote("ok"), preferenceMissing };
  }
  return {
    status: "ok",
    checkedAt: checkedAt ? checkedAt.toISOString() : null,
    product: chosen,
    preferenceApplied,
    preferenceBrand,
    preferenceMissing: preferenceApplied ? null : preferenceMissing,
    cheapestAltName:
      preferenceApplied && cheapestAltPrice != null && cheapestAltPrice < chosen.price
        ? cheapestAltName
        : null,
    cheapestAltPrice:
      preferenceApplied && cheapestAltPrice != null && cheapestAltPrice < chosen.price
        ? cheapestAltPrice
        : null,
    // Filled in by compareList, which knows the line's quantity.
    cost: null,
  };
}

const compareListResponse = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      quantityText: z.string().nullable(),
      preferences: z.array(z.string()),
      maven: listQuoteSchema,
      seven: listQuoteSchema,
      // True when both stores priced the line AND the two quoted
      // products are directly comparable (the same kind of product).
      // A line both stores priced with different products (a plain
      // milk against a chocolate milk) is NOT comparable and stays out
      // of the totals — adding its prices together would compare
      // random products against random products.
      comparable: z.boolean(),
      winner: winnerEnum,
    }),
  ),
  // Totals are summed over the items BOTH stores could price with a
  // directly comparable product — the only apples-to-apples comparison
  // when one side is missing an item or quoted a different product.
  commonCount: z.number(),
  mavenTotal: z.number().nullable(),
  sevenTotal: z.number().nullable(),
  winner: winnerEnum,
  diff: z.number().nullable(),
  mavenPriced: z.number(),
  sevenPriced: z.number(),
});
type CompareListResult = z.infer<typeof compareListResponse>;

// ---------- actions ----------

export const Actions = {
  getBoard: defineAction({
    description: "Returns the watchlist with the latest prices and verdicts from both stores, plus the product-catalog status and current specials. Also self-heals the Seven Mile indexing sweep: a batch whose agent died without saving is reaped and the next batch kicked from here (cooldown-guarded), so opening the page unsticks a stalled sweep.",
    request: z.object({}),
    response: boardResponse,
    async handler(ctx) {
      try {
        await seedSevenSections(ctx);
        await kickSevenCrawl(ctx, { opportunistic: true });
      } catch {
        // Board reads must never fail because the sweep kick did.
      }
      return loadBoard(ctx);
    },
  }),

  compareList: defineAction({
    description:
      "Prices a pasted shopping list or recipe at both stores: parses the text into buyable items, quotes the exact product (brand/size in the name) for each item at Market Maven and Seven Mile from the product catalog, applies the user's saved brand preferences (quoting the preferred brand even when pricier, and showing the cheaper alternative it beat), and totals the items both stores could price to say which store is cheaper overall. Per-pound products (meat, chicken) are costed by the pounds the list asks for — 1 lb when no amount is given — and packaged products by the whole packages that weight takes.",
    request: z.object({ text: z.string().min(2).max(8000) }),
    response: compareListResponse,
    async handler(ctx, args): Promise<CompareListResult> {
      const prefs = await loadBrandPrefs(ctx);
      const parsed = await parseListText(ctx, args.text);
      const items = await Promise.all(
        parsed.map(async (item) => {
          const itemPrefs = prefsFor(prefs, item.name);
          const [maven, seven] = await Promise.all([
            quoteListItemAtStore(ctx, API_STORE.key, item.name, itemPrefs),
            quoteListItemAtStore(ctx, BROWSER_STORE.key, item.name, itemPrefs),
          ]);
          const comparable = !!(
            maven.product &&
            seven.product &&
            pairMatchTwo(item.name, maven.product, seven.product)
          );
          // Quantity-aware line costs: a per-pound quote is priced by
          // the pounds the line asks for, a packaged quote by the
          // packages that weight takes (see listLineCost).
          const mavenCost = listLineCost(maven.product, item.quantityText);
          const sevenCost = listLineCost(seven.product, item.quantityText);
          let winner: StoreKey | "tie" | "none" = "none";
          if (maven.product && seven.product && comparable) {
            if (mavenCost != null && sevenCost != null) {
              winner =
                Math.abs(mavenCost - sevenCost) < 0.005
                  ? "tie"
                  : mavenCost < sevenCost
                    ? API_STORE.key
                    : BROWSER_STORE.key;
            } else if (
              !isWeightPriced(maven.product) &&
              !isWeightPriced(seven.product)
            ) {
              // No weight was asked for (or it could be answered):
              // fall back to the per-unit / listed-price comparison —
              // but never for a weight-priced product, where a bare
              // per-lb price against a package price means nothing.
              const useUnit =
                maven.product.unitPrice != null &&
                seven.product.unitPrice != null &&
                maven.product.unitFamily != null &&
                maven.product.unitFamily === seven.product.unitFamily;
              const a = useUnit ? (maven.product.unitPrice ?? 0) : maven.product.price;
              const b = useUnit ? (seven.product.unitPrice ?? 0) : seven.product.price;
              winner =
                Math.abs(a - b) < 0.005 ? "tie" : a < b ? API_STORE.key : BROWSER_STORE.key;
            }
          }
          return {
            name: item.name,
            quantityText: item.quantityText,
            preferences: itemPrefs.map((p) => p.brand),
            maven: { ...maven, cost: mavenCost },
            seven: { ...seven, cost: sevenCost },
            comparable,
            winner,
          };
        }),
      );
      // If anything queued Seven Mile indexing, make sure the sweep runs.
      if (items.some((i) => i.seven.status === "pending")) {
        await seedSevenSections(ctx);
        await kickSevenCrawl(ctx);
      }
      // Totals sum the quantity-aware line costs, and only over
      // lines where BOTH stores produced one — a line whose packaged
      // side can't answer the requested weight stays out rather than
      // comparing a per-pound total against one package.
      const common = items.filter(
        (i) =>
          i.maven.product &&
          i.seven.product &&
          i.comparable &&
          i.maven.cost != null &&
          i.seven.cost != null,
      );
      const mavenTotal =
        common.length > 0
          ? Math.round(common.reduce((s, i) => s + (i.maven.cost ?? 0), 0) * 100) / 100
          : null;
      const sevenTotal =
        common.length > 0
          ? Math.round(common.reduce((s, i) => s + (i.seven.cost ?? 0), 0) * 100) / 100
          : null;
      let winner: StoreKey | "tie" | "none" = "none";
      let diff: number | null = null;
      if (mavenTotal != null && sevenTotal != null) {
        diff = Math.round(Math.abs(mavenTotal - sevenTotal) * 100) / 100;
        winner = diff < 0.005 ? "tie" : mavenTotal < sevenTotal ? API_STORE.key : BROWSER_STORE.key;
      }
      ctx.invalidateQueries();
      return {
        items,
        commonCount: common.length,
        mavenTotal,
        sevenTotal,
        winner,
        diff,
        mavenPriced: items.filter((i) => i.maven.product).length,
        sevenPriced: items.filter((i) => i.seven.product).length,
      };
    },
  }),

  listBrandPreferences: defineAction({
    description:
      "Returns the user's saved brand preferences (item keyword → preferred brand) that list/recipe pricing applies.",
    request: z.object({}),
    response: z.object({
      preferences: z.array(
        z.object({ id: z.number(), keyword: z.string(), brand: z.string() }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.brandPreferences)
        .orderBy(asc(schema.brandPreferences.id));
      return {
        preferences: rows.map((r) => ({
          id: r.id,
          keyword: r.keyword,
          brand: r.brand,
        })),
      };
    },
  }),

  saveBrandPreference: defineAction({
    description:
      "Saves (or keeps) a brand preference: for the given item/category keyword, list and recipe pricing will quote this brand's product at each store that carries it, even when another brand is cheaper.",
    request: z.object({
      keyword: z.string().min(2).max(60),
      brand: z.string().min(2).max(80),
    }),
    response: z.object({ ok: z.literal(true), id: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; id: number }> {
      const db = ctx.db<typeof schema>();
      const keyword = args.keyword.trim().toLowerCase().replace(/\s+/g, " ");
      const brand = args.brand.trim().replace(/\s+/g, " ");
      const existing = await db.select().from(schema.brandPreferences);
      const dup = existing.find(
        (r) =>
          r.keyword.toLowerCase() === keyword &&
          r.brand.toLowerCase() === brand.toLowerCase(),
      );
      if (dup) return { ok: true, id: dup.id };
      const inserted = await db
        .insert(schema.brandPreferences)
        .values({ keyword, brand })
        .returning({ id: schema.brandPreferences.id });
      const row = inserted[0];
      if (!row) throw new Error("saveBrandPreference: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, id: row.id };
    },
  }),

  removeBrandPreference: defineAction({
    description: "Removes one saved brand preference by id.",
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.brandPreferences)
        .where(eq(schema.brandPreferences.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  kickSevenSweep: defineAction({
    description:
      "Watchdog for the Seven Mile indexing sweep, run hourly on a schedule so recovery never depends on someone opening the page: reaps batches whose agent died without saving (re-queueing them, or marking them errored once their attempts run out) and kicks the next batch.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true), started: z.boolean() }),
    async handler(ctx): Promise<{ ok: true; started: boolean }> {
      await seedSevenSections(ctx);
      const started = await kickSevenCrawl(ctx);
      ctx.invalidateQueries();
      return { ok: true, started };
    },
  }),

  addWatchItem: defineAction({
    description: "Adds an item to the price watchlist and immediately prices it from the product catalog (checking a store live only when the catalog doesn't know the item yet).",
    request: z.object({ query: z.string().min(1).max(80) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const q = args.query.trim();
      const existing = await db.select().from(schema.watchItems);
      const dup = existing.find((i) => i.query.toLowerCase() === q.toLowerCase());
      if (dup) return { id: dup.id };
      const inserted = await db
        .insert(schema.watchItems)
        .values({ query: q })
        .returning({ id: schema.watchItems.id });
      const row = inserted[0];
      if (!row) throw new Error("addWatchItem: insert returned no rows");
      await refreshMavenFor(ctx, [{ id: row.id, query: q }]);
      await refreshSevenFor(ctx, [{ id: row.id, query: q }], false);
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  removeWatchItem: defineAction({
    description: "Removes an item and its saved prices from the watchlist.",
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.watchItems)
        .where(eq(schema.watchItems.id, args.id));
      const item = rows[0];
      await db.delete(schema.watchItems).where(eq(schema.watchItems.id, args.id));
      await db.delete(schema.snapshots).where(eq(schema.snapshots.watchItemId, args.id));
      if (item) {
        // The item's browser-store watch section leaves the sweep
        // queue with it — left behind, it would keep re-indexing a
        // product nobody watches, forever. Its section-product links
        // go too; the catalog products themselves stay (other items
        // and the shop use them).
        const sections = await db
          .select()
          .from(schema.catalogSections)
          .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
        const watch = sections.find(
          (s) =>
            s.kind === "watch" &&
            s.term.toLowerCase() === item.query.toLowerCase(),
        );
        if (watch) {
          await db
            .delete(schema.catalogSectionProducts)
            .where(eq(schema.catalogSectionProducts.sectionId, watch.id));
          await db
            .delete(schema.catalogSections)
            .where(eq(schema.catalogSections.id, watch.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  refreshAll: defineAction({
    description:
      "Re-prices every watchlist item from the product catalog, queueing background Seven Mile indexing for anything the catalog doesn't cover yet.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true), items: z.number() }),
    async handler(ctx): Promise<{ ok: true; items: number }> {
      const db = ctx.db<typeof schema>();
      const items = await db
        .select()
        .from(schema.watchItems)
        .orderBy(asc(schema.watchItems.id));
      await refreshMavenFor(ctx, items);
      await refreshSevenFor(ctx, items, false);
      // Also nudge the Seven Mile indexing chain in case it stalled.
      await kickSevenCrawl(ctx);
      ctx.invalidateQueries();
      return { ok: true, items: items.length };
    },
  }),

  refreshItem: defineAction({
    description: "Forces a fresh check of one watchlist item at both stores, bypassing the catalog.",
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.watchItems)
        .where(eq(schema.watchItems.id, args.id));
      const item = rows[0];
      if (item) {
        try {
          const products = await fetchMaven(item.query);
          await upsertSnapshot(ctx, item.id, API_STORE.key, {
            status: "ok",
            checkedAt: new Date(),
            error: null,
            products: JSON.stringify(products),
          });
          await upsertLearnedProducts(ctx, API_STORE.key, products);
        } catch (e) {
          await upsertSnapshot(ctx, item.id, API_STORE.key, {
            status: "error",
            error: e instanceof Error ? e.message : "Market Maven check failed",
          });
        }
        await refreshSevenFor(ctx, [item], true);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  syncCatalog: defineAction({
    description:
      "Builds/refreshes the product catalog on the standing cadence: Market Maven is re-crawled in full through its store API when its data is over ~6 days old (or forced) — that weekly pass refreshes sale flags and prices and picks up new products; Seven Mile's background indexing sweep continues where it left off, and once a sweep completes, each weekly cycle resets only the specials + sitemap-discovery sections plus a quarter of the remaining sections — sections whose products still lack a package size first, then the oldest — so Seven Mile prices roll through a full re-check about once a month while specials and new categories/products are caught weekly, and the pre-size-column catalog backfills its missing package sizes ahead of ordinary re-checks.",
    request: z.object({ force: z.boolean().optional() }),
    response: z.object({
      mavenCount: z.number(),
      mavenNew: z.number(),
      mavenSkipped: z.boolean(),
      sevenStarted: z.boolean(),
      sevenSectionsPending: z.number(),
    }),
    async handler(ctx, args) {
      const force = args.force ?? false;
      const db = ctx.db<typeof schema>();
      const now = Date.now();

      // Market Maven: full crawl on a weekly gate. The API hands back
      // the entire catalog in one cheap pass and the sale flags ride on
      // every row, so this single pass covers the weekly specials
      // check, the price re-check, and new-product detection at once.
      const mavenSync = await getSyncRow(ctx, API_STORE.key);
      const mavenAge = mavenSync?.lastSyncAt ? now - mavenSync.lastSyncAt.getTime() : Infinity;
      let mavenCount = await catalogCount(ctx, API_STORE.key);
      let mavenNew = 0;
      let mavenSkipped = false;
      if (force || mavenAge > REBUILD_GATE_MS) {
        await setSyncRow(ctx, API_STORE.key, { status: "running", error: null });
        try {
          const crawled = await crawlMavenCatalog(ctx);
          mavenCount = crawled.count;
          mavenNew = crawled.newCount;
        } catch (e) {
          await setSyncRow(ctx, API_STORE.key, {
            status: "error",
            error: e instanceof Error ? e.message : "Market Maven catalog crawl failed",
          });
        }
      } else {
        mavenSkipped = true;
      }

      // Seven Mile: seed the section queue, retire failed sections back
      // into the queue, and — once a sweep has fully completed — start
      // the next rolling cycle when the last one is a week old: the
      // specials and discovery sections always reset (fresh sale flags;
      // new categories and the products in them), plus the oldest
      // quarter of the remaining sections, so the whole store is
      // re-checked about once a month instead of all at once.
      await seedSevenSections(ctx);
      const sections = await db
        .select()
        .from(schema.catalogSections)
        .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
      for (const s of sections) {
        if (s.status === "error") {
          await db
            .update(schema.catalogSections)
            .set({ status: "pending", attempts: 0, lastError: null, updatedAt: new Date() })
            .where(eq(schema.catalogSections.id, s.id));
          s.status = "pending";
        }
      }
      const allDone =
        sections.length > 0 && sections.every((s) => s.status === "done");
      if (allDone) {
        const lastDone = sections.reduce<number>(
          (acc, s) => Math.max(acc, s.updatedAt ? s.updatedAt.getTime() : 0),
          0,
        );
        if (force || now - lastDone > REBUILD_GATE_MS) {
          const weeklyKinds = sections.filter(
            (s) => s.kind === "specials" || s.kind === "discovery",
          );
          // Sections whose linked products still have no known size
          // (no stored size_text and no digit in the name — a stored
          // name with a digit may still be size-less, but digit-less
          // is the certain signal) re-queue FIRST within the slice:
          // the size backfill (migration 0013) should not wait behind
          // sections whose products already carry sizes.
          const sizelessRows = await db.all<{ section_id: number }>(sql`
            SELECT DISTINCT sp.section_id AS section_id
            FROM catalog_section_products sp
            JOIN catalog_products p ON p.id = sp.product_id
            WHERE p.store = '${BROWSER_STORE.key}'
              AND p.size_text IS NULL
              AND p.name NOT GLOB '*[0-9]*'
          `);
          const sizelessSections = new Set(sizelessRows.map((r) => r.section_id));
          const rest = sections
            .filter((s) => s.kind !== "specials" && s.kind !== "discovery")
            .sort(
              (a, b) =>
                Number(sizelessSections.has(b.id)) -
                  Number(sizelessSections.has(a.id)) ||
                (a.updatedAt?.getTime() ?? 0) - (b.updatedAt?.getTime() ?? 0),
            );
          const quarter = Math.max(1, Math.ceil(rest.length / 4));
          const toReset = [...weeklyKinds, ...rest.slice(0, quarter)];
          for (const s of toReset) {
            await db
              .update(schema.catalogSections)
              .set({ status: "pending", attempts: 0, updatedAt: new Date() })
              .where(eq(schema.catalogSections.id, s.id));
          }
          if (toReset.length > 0) {
            await setSyncRow(ctx, BROWSER_STORE.key, { status: "running", error: null });
          }
        }
      }
      const started = await kickSevenCrawl(ctx);
      const after = await db
        .select()
        .from(schema.catalogSections)
        .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
      const pendingCount = after.filter(
        (s) => s.status === "pending" || s.status === "running",
      ).length;
      ctx.invalidateQueries();
      return {
        mavenCount,
        mavenNew,
        mavenSkipped,
        sevenStarted: started,
        sevenSectionsPending: pendingCount,
      };
    },
  }),

  spotCheckMaven: defineAction({
    description:
      "Runs an accuracy spot check of the Market Maven catalog against the store's live API: samples products spread across the whole catalog plus extra on-sale and multi-buy-deal ones, re-fetches each live, records stored-vs-live price and sale flag per product (correcting the catalog from live values — including deal fields — on a mismatch), and returns the summary. The board shows the latest run.",
    request: z.object({}),
    response: spotCheckSchema,
    async handler(ctx) {
      const result = await runMavenSpotCheck(ctx);
      ctx.invalidateQueries();
      return result;
    },
  }),

  saveCatalogResults: defineAction({
    description:
      "Saves one batch of Seven Mile indexing results from the background browser agent, links the products to their section, checks the section's coverage against the total the store itself reported (re-queueing it for another pass while it is short and still gaining products), then chains the next indexing batch until the store sweep is complete. A product whose page showed multi-buy wording carries it as dealText (with price as the displayed dollar amount); the server parses the deal and stores the per-item price, never the bundle total. A product priced by weight carries the displayed price text as priceText (\"$7.99 / Lb\"), which is how the catalog knows its price is per pound. Each product's package size — the size half of the tile's \"Brand | size\" line above its name — arrives as sizeText and is stored in the catalog's size_text column (dedupe is name+size, since one name sells at several sizes); before this, sizeText was accepted and silently dropped, which is why most Seven Mile products had no size.",
    request: z.object({
      results: z.array(
        z.object({
          sectionId: z.number(),
          // Total products the store itself reported for this section
          // (result count / facet sum on the page), when it showed one.
          expectedCount: z.number().nullable().optional(),
          products: z.array(
            z.object({
              name: z.string(),
              price: z.number(),
              sizeText: z.string().nullable().optional(),
              // The price exactly as displayed, when it is priced by
              // weight ("$7.99 / Lb"); null for ordinary prices.
              priceText: z.string().max(80).nullable().optional(),
              onSale: z.boolean().optional(),
              category: z.string().nullable().optional(),
              // Multi-buy wording exactly as displayed ("4 for
              // $5.00", "Buy 1 Get 1 Free"), with price holding the
              // displayed dollar amount; null when there is no deal.
              dealText: z.string().max(120).nullable().optional(),
            }),
          ),
          error: z.string().nullable().optional(),
        }),
      ),
    }),
    response: z.object({ saved: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let saved = 0;
      for (const r of args.results) {
        const [section] = await db
          .select()
          .from(schema.catalogSections)
          .where(eq(schema.catalogSections.id, r.sectionId));
        // Products indexed from a category page belong to that aisle
        // whether or not the page repeated the department name on
        // every product — stamp the section's own label as their
        // category (an explicit per-product category from the agent
        // still wins). The matcher uses these categories to sort
        // lookalike products from other aisles out of an item's way.
        const sectionCategory =
          section?.kind === "category" ? (section.label ?? null) : null;
        const ids = await upsertLearnedProducts(
          ctx,
          BROWSER_STORE.key,
          r.products.map((p) => {
            // Multi-buy deal: the agent recorded the wording and the
            // displayed amount; the server does the arithmetic and
            // stores the per-item price plus the deal itself. An
            // unparseable dealText is dropped rather than guessed at —
            // the product keeps its displayed price and no deal.
            const deal = parseDealText(p.dealText, p.price);
            return {
              name: p.name,
              price: deal ? dealPerItem(deal) : p.price,
              sizeText: p.sizeText ?? null,
              // Per-weight pricing ("$7.99 / Lb") is kept as the
              // product's price text — catalogRowToProduct derives
              // the per-pound basis from it, so the price is never
              // later mistaken for a whole-package price.
              priceText: p.priceText ?? null,
              onSale: p.onSale ?? false,
              category: p.category ?? sectionCategory,
              dealText: deal?.text ?? null,
              dealQty: deal?.qty ?? null,
              dealTotal: deal?.total ?? null,
              regularPrice: null,
            };
          }),
        );
        if (!section) continue;

        // Link this pass's products to the section and measure coverage
        // in distinct linked products — a re-pass mostly re-saves
        // products the catalog already has, so counting inserts would
        // read ~0 and misjudge a healthy continuation as stalled.
        const before = await db
          .select({ n: sql<number>`count(*)` })
          .from(schema.catalogSectionProducts)
          .where(eq(schema.catalogSectionProducts.sectionId, r.sectionId));
        const linkedBefore = before[0]?.n ?? 0;
        const linkRows = [...new Set(ids.values())].map((productId) => ({
          sectionId: r.sectionId,
          productId,
        }));
        for (let i = 0; i < linkRows.length; i += 400) {
          const chunk = linkRows.slice(i, i + 400);
          if (chunk.length > 0) {
            await db
              .insert(schema.catalogSectionProducts)
              .values(chunk)
              .onConflictDoNothing();
          }
        }
        const after = await db
          .select({ n: sql<number>`count(*)` })
          .from(schema.catalogSectionProducts)
          .where(eq(schema.catalogSectionProducts.sectionId, r.sectionId));
        const linked = after[0]?.n ?? 0;
        const added = linked - linkedBefore;
        const expected = r.expectedCount ?? section.expectedCount ?? null;

        let status: "done" | "pending" | "error";
        let lastError: string | null = null;
        if (r.error && r.products.length === 0) {
          status = "error";
          lastError = r.error;
        } else if (expected != null && linked < expected) {
          // Short of the store's own total: keep going while passes
          // still add products; stop on a stall or the dispatch cap,
          // recording the shortfall either way — never silently "done".
          if (added > 0 && section.attempts < SEVEN_MAX_PASSES) {
            status = "pending";
            lastError = `Saved ${linked} of the ${expected} products the store lists for this section — re-queued for another pass.`;
          } else {
            status = "done";
            lastError = `Saved ${linked} of the ${expected} products the store lists for this section; repeat passes stopped adding more, so the shortfall is recorded here and retried when the section's turn comes in the rolling monthly re-check.`;
          }
        } else {
          status = "done";
          if (expected != null && linked > expected) {
            lastError = `Saved ${linked} products; the store's page reported ${expected} — its count looks off, the saved products are what's on the page.`;
          }
        }
        await db
          .update(schema.catalogSections)
          .set({
            status,
            productCount: linked,
            expectedCount: expected,
            lastError,
            updatedAt: new Date(),
          })
          .where(eq(schema.catalogSections.id, r.sectionId));
        saved++;
      }
      // Refresh the Seven Mile sync summary, fill any watch items that
      // were waiting on this data, then chain the next batch.
      const remaining = await db
        .select()
        .from(schema.catalogSections)
        .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
      const stillWorking = remaining.some(
        (s) => s.status === "pending" || s.status === "running",
      );
      await setSyncRow(ctx, BROWSER_STORE.key, {
        status: stillWorking ? "running" : "ok",
        productCount: await catalogCount(ctx, BROWSER_STORE.key),
        lastSyncAt: new Date(),
        error: null,
      });
      await fillPendingSevenSnapshots(ctx);
      await kickSevenCrawl(ctx);
      ctx.invalidateQueries();
      return { saved };
    },
  }),

  saveDiscoveredCategories: defineAction({
    description:
      "Saves the Seven Mile category links the discovery agent read off the store's own sitemap page, seeding one pending category section per leaf category the sweep doesn't have yet and recording each category's display name as the section's label (existing sections get their label filled in, and Seven Mile products already linked to a labeled category section are backfilled with that aisle as their category), then chains the indexing sweep.",
    request: z.object({
      sectionId: z.number(),
      categories: z.array(
        z.object({ name: z.string(), path: z.string() }),
      ),
      error: z.string().nullable().optional(),
    }),
    response: z.object({ added: z.number(), total: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Normalize to the path form sections use as their term and keep
      // only real category-page paths — anything else the page linked
      // to is not a sweep target.
      const paths = new Map<string, string>();
      for (const c of args.categories) {
        let pathname = c.path.trim();
        try {
          pathname = new URL(pathname, BROWSER_STORE.homepage).pathname;
        } catch {
          continue;
        }
        const term = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
        if (!/^categories\/\d+\/products$/.test(term)) continue;
        if (!paths.has(term)) paths.set(term, c.name.trim());
      }
      const existing = await db
        .select()
        .from(schema.catalogSections)
        .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
      const existingCats = existing.filter((s) => s.kind === "category");
      const have = new Set(existingCats.map((s) => s.term.toLowerCase()));
      const toAdd: (typeof schema.catalogSections.$inferInsert)[] = [];
      for (const [term, name] of paths) {
        if (!have.has(term.toLowerCase())) {
          toAdd.push({
            store: BROWSER_STORE.key,
            term,
            kind: "category",
            status: "pending",
            label: name || null,
          });
        }
      }
      for (let i = 0; i < toAdd.length; i += 400) {
        const chunk = toAdd.slice(i, i + 400);
        if (chunk.length > 0) await db.insert(schema.catalogSections).values(chunk);
      }
      // Keep the aisle name on sections that already existed — they
      // were seeded before labels were kept, and the name is what lets
      // products indexed from the section carry a category.
      for (const s of existingCats) {
        const name = paths.get(s.term) ?? paths.get(s.term.toLowerCase());
        if (name && name !== s.label) {
          await db
            .update(schema.catalogSections)
            .set({ label: name })
            .where(eq(schema.catalogSections.id, s.id));
        }
      }
      // Backfill: every Seven Mile product already linked to a
      // category section gets that section's aisle as its category
      // (first labeled section wins), so the existing catalog gains
      // categories without waiting for a re-sweep.
      await db.run(sql`
        UPDATE catalog_products
        SET category = (
          SELECT s.label
          FROM catalog_section_products sp
          JOIN catalog_sections s ON s.id = sp.section_id
          WHERE sp.product_id = catalog_products.id
            AND s.label IS NOT NULL AND s.label <> ''
          LIMIT 1
        )
        WHERE store = '${BROWSER_STORE.key}'
          AND (category IS NULL OR category = '')
          AND EXISTS (
            SELECT 1
            FROM catalog_section_products sp
            JOIN catalog_sections s ON s.id = sp.section_id
            WHERE sp.product_id = catalog_products.id
              AND s.label IS NOT NULL AND s.label <> ''
          )
      `);
      const failed = !!args.error && paths.size === 0;
      await db
        .update(schema.catalogSections)
        .set({
          status: failed ? "error" : "done",
          productCount: paths.size,
          lastError: failed ? (args.error ?? null) : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.catalogSections.id, args.sectionId));
      const remaining = await db
        .select()
        .from(schema.catalogSections)
        .where(eq(schema.catalogSections.store, BROWSER_STORE.key));
      const stillWorking = remaining.some(
        (s) => s.status === "pending" || s.status === "running",
      );
      await setSyncRow(ctx, BROWSER_STORE.key, {
        status: stillWorking ? "running" : "ok",
        productCount: await catalogCount(ctx, BROWSER_STORE.key),
        lastSyncAt: new Date(),
        error: null,
      });
      await kickSevenCrawl(ctx);
      ctx.invalidateQueries();
      return { added: toAdd.length, total: paths.size };
    },
  }),

  lookupBarcode: defineAction({
    description:
      "Looks up a scanned product barcode (UPC/EAN digits): resolves it to a product from the local scan cache or Open Food Facts, then prices that product at Market Maven and Seven Mile from the product catalog (queueing Seven Mile indexing and reporting pending when that side doesn't know it yet). Returns resolved=false when no database knows the barcode — never guesses a product.",
    request: z.object({ barcode: z.string().min(6).max(20) }),
    response: barcodeLookupResponse,
    async handler(ctx, args): Promise<BarcodeLookup> {
      const digits = barcodeDigits(args.barcode);
      const cached = await findBarcodeMapping(ctx, digits);
      if (cached) {
        const db = ctx.db<typeof schema>();
        await db
          .update(schema.barcodeMappings)
          .set({ lastSeenAt: new Date() })
          .where(eq(schema.barcodeMappings.id, cached.id));
        return buildBarcodeResult(
          ctx,
          digits,
          {
            productName: cached.productName,
            brand: cached.brand,
            quantityText: cached.quantityText,
            imageUrl: cached.imageUrl,
          },
          "cache",
        );
      }
      const off = await fetchOpenFoodFacts(ctx, digits);
      if (off) {
        await saveBarcodeMapping(ctx, {
          barcode: digits,
          productName: off.productName,
          brand: off.brand,
          quantityText: off.quantityText,
          imageUrl: off.imageUrl,
          source: "openfoodfacts",
        });
        ctx.invalidateQueries();
        return buildBarcodeResult(ctx, digits, off, "openfoodfacts");
      }
      return {
        barcode: digits,
        resolved: false,
        productName: null,
        brand: null,
        quantityText: null,
        imageUrl: null,
        source: null,
        searchQuery: null,
        maven: emptySnap("none"),
        seven: emptySnap("none"),
        verdict: { winner: "none", basis: null, diff: null, text: "" },
      };
    },
  }),

  linkBarcode: defineAction({
    description:
      "Saves what product a barcode belongs to (typed in by the user when no database knows that barcode) and immediately prices it at both stores; the mapping is cached so future scans of the same barcode resolve instantly.",
    request: z.object({
      barcode: z.string().min(6).max(20),
      productName: z.string().min(2).max(120),
    }),
    response: barcodeLookupResponse,
    async handler(ctx, args): Promise<BarcodeLookup> {
      const digits = barcodeDigits(args.barcode);
      const name = args.productName.trim();
      await saveBarcodeMapping(ctx, {
        barcode: digits,
        productName: name,
        brand: null,
        quantityText: null,
        imageUrl: null,
        source: "manual",
      });
      ctx.invalidateQueries();
      return buildBarcodeResult(
        ctx,
        digits,
        { productName: name, brand: null, quantityText: null, imageUrl: null },
        "manual",
      );
    },
  }),

  listRecentScans: defineAction({
    description:
      "Returns the most recent barcode scans (barcode, product name, brand) so the page can offer one-tap re-lookups of products scanned before.",
    request: z.object({}),
    response: z.object({
      scans: z.array(
        z.object({
          barcode: z.string(),
          productName: z.string(),
          brand: z.string().nullable(),
          lastSeenAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.barcodeMappings)
        .orderBy(desc(schema.barcodeMappings.lastSeenAt))
        .limit(10);
      return {
        scans: rows.map((r) => ({
          barcode: r.barcode,
          productName: r.productName,
          brand: r.brand,
          lastSeenAt: r.lastSeenAt.toISOString(),
        })),
      };
    },
  }),

  searchProducts: defineAction({
    description:
      "The product finder: for a generic term (chips, eggs), returns every DIRECTLY COMPARABLE product pair across the two stores — products paired by kind (same item/variant under each store's own naming) — plus how many matched products exist at only one store and so are left out of the comparison. Market Maven gets a live API check on a catalog miss; a Seven Mile miss queues background indexing and reports sevenPending.",
    request: z.object({ query: z.string().min(2).max(80) }),
    response: z.object({
      query: z.string(),
      pairs: z.array(
        z.object({
          key: z.string(),
          maven: z.array(productSchema),
          seven: z.array(productSchema),
          // Server-computed winner for the pair's representatives —
          // the client renders it, never re-derives it.
          winner: winnerEnum,
        }),
      ),
      comparable: z.number(),
      mavenOnly: z.number(),
      sevenOnly: z.number(),
      mavenTotal: z.number(),
      sevenTotal: z.number(),
      sevenPending: z.boolean(),
    }),
    async handler(ctx, args) {
      const query = args.query.trim();
      let m = await catalogMatch(ctx, API_STORE.key, query, 60);
      if (m.products.length === 0) {
        // Live check: the catalog may simply not know this term yet.
        try {
          const live = await fetchMaven(query);
          if (live.length > 0) {
            await upsertLearnedProducts(ctx, API_STORE.key, live);
            const again = await catalogMatch(ctx, API_STORE.key, query, 60);
            m =
              again.products.length > 0
                ? again
                : { products: live, newestSeenAt: new Date(), total: live.length };
          }
        } catch {
          // Catalog answer (empty) stands.
        }
      }
      const s = await catalogMatch(ctx, BROWSER_STORE.key, query, 60);
      let sevenPending = false;
      if (s.products.length === 0) {
        await ensureWatchSection(ctx, query, false);
        await seedSevenSections(ctx);
        await kickSevenCrawl(ctx);
        sevenPending = true;
      }
      const pairing = pairProducts(query, m.products, s.products);
      let pairs: (PairGroup & {
        winner?: StoreKey | "tie" | "none";
      })[] = pairing.pairs;
      let mavenOnly = pairing.mavenOnly.length;
      let sevenOnly = pairing.sevenOnly.length;
      if (pairs.length === 0 && m.products.length > 0 && s.products.length > 0) {
        const bm = pickBest(m.products, query);
        const bs = pickBest(s.products, query);
        if (bm && bs && pairMatchTwo(query, bm, bs)) {
          const shared = new Set(
            contentWords(bm.name)
              .map(foldWord)
              .filter((w) =>
                new Set(contentWords(bs.name).map(foldWord)).has(w),
              ),
          );
          pairs = [
            {
              key: pairSignature(query, bm.name, shared),
              maven: [bm],
              seven: [bs],
              winner: verdictFor({ best: bm }, { best: bs }).winner,
            },
          ];
          mavenOnly = Math.max(0, mavenOnly - 1);
          sevenOnly = Math.max(0, sevenOnly - 1);
        }
      }
      ctx.invalidateQueries();
      return {
        query,
        pairs: pairs.slice(0, 30).map((g) => ({
          key: g.key,
          maven: g.maven,
          seven: g.seven,
          winner:
            "winner" in g && g.winner
              ? g.winner
              : verdictFor(
                  { best: pickBest(g.maven, query) },
                  { best: pickBest(g.seven, query) },
                ).winner,
        })),
        comparable: pairs.length,
        mavenOnly,
        sevenOnly,
        mavenTotal: m.total,
        sevenTotal: s.total,
        sevenPending,
      };
    },
  }),

  browseCatalog: defineAction({
    description:
      "Browses the whole product catalog the way a supermarket is laid out: returns the shared supermarket aisles (Produce, Dairy & Eggs, Pantry & Grocery…) with product counts per store, and a page of products filtered by aisle and/or search text and/or store. Aisles are normalized from both stores' own category names (aisleForCategory), so both stores' products shelve together in one aisle. The store filter works per aisle: no store filter shows everything in the aisle — kinds both stores carry, plus one-store-only products marked not comparable ('Maven only' / 'Seven Mile only'); a single-store filter shows just that store's products in the aisle, comparable marking still checked against the other store. With no aisle or search, returns current specials.",
    request: z.object({
      store: storeEnum.nullable().optional(),
      category: z.string().max(120).nullable().optional(),
      query: z.string().max(80).nullable().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(80).optional(),
    }),
    response: z.object({
      categories: z.array(
        z.object({
          name: z.string(),
          count: z.number(),
          mavenCount: z.number(),
          sevenCount: z.number(),
        }),
      ),
      products: z.array(
        productSchema.extend({
          store: storeEnum,
          comparable: z.boolean().nullable(),
        }),
      ),
      total: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const catRows = await db
        .select({
          category: schema.catalogProducts.category,
          store: schema.catalogProducts.store,
          n: sql<number>`count(*)`,
        })
        .from(schema.catalogProducts)
        .where(
          sql`${schema.catalogProducts.category} is not null and ${schema.catalogProducts.category} <> ''`,
        )
        .groupBy(schema.catalogProducts.store, schema.catalogProducts.category);
      // Products with no category at all: they belong to the
      // catch-all aisle like everything else unrecognized.
      const nullCatRows = await db
        .select({
          store: schema.catalogProducts.store,
          n: sql<number>`count(*)`,
        })
        .from(schema.catalogProducts)
        .where(
          sql`${schema.catalogProducts.category} is null or ${schema.catalogProducts.category} = ''`,
        )
        .groupBy(schema.catalogProducts.store);
      // Aggregate the stores' own category names into the shared
      // supermarket aisles the shop browses by, remembering which raw
      // categories feed each aisle per store.
      const aisleAgg = new Map<string, { maven: number; seven: number }>();
      const rawCatsByAisle = new Map<
        string,
        { maven: string[]; seven: string[] }
      >();
      const bumpAisle = (aisle: string, store: Store, n: number) => {
        const cur = aisleAgg.get(aisle) ?? { maven: 0, seven: 0 };
        cur[store] += n;
        aisleAgg.set(aisle, cur);
      };
      for (const r of catRows) {
        if (!r.category) continue;
        const aisle = aisleForCategory(r.category);
        bumpAisle(aisle, r.store, r.n);
        const entry = rawCatsByAisle.get(aisle) ?? { maven: [], seven: [] };
        entry[r.store].push(r.category);
        rawCatsByAisle.set(aisle, entry);
      }
      for (const r of nullCatRows) bumpAisle(DEFAULT_AISLE, r.store, r.n);
      const categories = AISLE_ORDER.filter((a) => aisleAgg.has(a)).map(
        (a) => {
          const agg = aisleAgg.get(a) ?? { maven: 0, seven: 0 };
          return {
            name: a as string,
            count: agg.maven + agg.seven,
            mavenCount: agg.maven,
            sevenCount: agg.seven,
          };
        },
      );

      const offset = args.offset ?? 0;
      const limit = args.limit ?? 40;
      const query = args.query?.trim() || null;
      const aisleArg = args.category?.trim() || null;
      const aisle =
        aisleArg && (AISLE_ORDER as readonly string[]).includes(aisleArg)
          ? aisleArg
          : null;
      const context = query ?? aisle;

      type BrowseProduct = Product & { store: Store; comparable: boolean | null };
      let display: BrowseProduct[] = [];
      let total = 0;

      if (!context) {
        // Landing: what's on special right now, across both stores.
        const rows = await db
          .select()
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.onSale, true))
          .orderBy(sql`${schema.catalogProducts.lastSeenAt} desc`)
          .limit(400);
        const filtered = args.store
          ? rows.filter((r) => r.store === args.store)
          : rows;
        total = filtered.length;
        display = filtered
          .slice(offset, offset + limit)
          .map((r) => ({
            ...catalogRowToProduct(r),
            store: r.store,
            comparable: null,
          }));
        return { categories, products: display, total };
      }

      // Candidate rows per store for the chosen context, plus each
      // store's pool for comparable marking (the OTHER store's
      // products in the same context).
      let mProds: Product[] = [];
      let sProds: Product[] = [];
      let mPool: Product[] = [];
      let sPool: Product[] = [];

      if (query) {
        const tokens = queryTokens(query);
        const fetchSearch = async (store: Store): Promise<CatalogRow[]> => {
          if (tokens.length === 0) return [];
          return db
            .select()
            .from(schema.catalogProducts)
            .where(
              and(
                eq(schema.catalogProducts.store, store),
                ...tokens.map((t) =>
                  like(schema.catalogProducts.nameNorm, `%${t}%`),
                ),
              ),
            )
            .limit(600);
        };
        const [mRows, sRows] = await Promise.all([
          fetchSearch(API_STORE.key),
          fetchSearch(BROWSER_STORE.key),
        ]);
        // Search results keep only word-level matches, best first.
        mProds = scoreCatalogRows(query, mRows).map((s) =>
          catalogRowToProduct(s.r),
        );
        sProds = scoreCatalogRows(query, sRows).map((s) =>
          catalogRowToProduct(s.r),
        );
        mPool = mProds;
        sPool = sProds;
      } else if (aisle) {
        // Aisle mode: every product shelved in this aisle at the
        // store — all raw categories that map to the aisle, plus (for
        // the catch-all aisle) products with no category at all.
        const aisleCats = rawCatsByAisle.get(aisle) ?? {
          maven: [] as string[],
          seven: [] as string[],
        };
        const aisleWhere = (store: Store) => {
          const conds: SQL[] = [];
          if (aisleCats[store].length > 0) {
            conds.push(
              inArray(schema.catalogProducts.category, aisleCats[store]),
            );
          }
          if (aisle === DEFAULT_AISLE) {
            conds.push(
              sql`${schema.catalogProducts.category} is null or ${schema.catalogProducts.category} = ''`,
            );
          }
          if (conds.length === 0) return null;
          return conds.length === 1 ? conds[0] : or(...conds);
        };
        const countSide = async (store: Store): Promise<number> => {
          const w = aisleWhere(store);
          if (!w) return 0;
          const rows = await db
            .select({ n: sql<number>`count(*)` })
            .from(schema.catalogProducts)
            .where(and(eq(schema.catalogProducts.store, store), w));
          return rows[0]?.n ?? 0;
        };
        const fetchWindow = async (store: Store): Promise<CatalogRow[]> => {
          const w = aisleWhere(store);
          if (!w) return [];
          // The merged page at `offset` can draw up to offset+limit
          // rows from ONE store, so each store's window runs that
          // deep — capping it would blank out deep pages while the
          // count above still promises thousands of products.
          return db
            .select()
            .from(schema.catalogProducts)
            .where(and(eq(schema.catalogProducts.store, store), w))
            .orderBy(asc(schema.catalogProducts.name))
            .limit(offset + limit);
        };
        const fetchPool = async (store: Store): Promise<Product[]> => {
          const w = aisleWhere(store);
          if (!w) return [];
          const rows = await db
            .select()
            .from(schema.catalogProducts)
            .where(and(eq(schema.catalogProducts.store, store), w))
            .orderBy(asc(schema.catalogProducts.name))
            .limit(1500);
          return rows.map((r) => catalogRowToProduct(r));
        };
        const [mCount, sCount, mWin, sWin, mPoolP, sPoolP] =
          await Promise.all([
            countSide(API_STORE.key),
            countSide(BROWSER_STORE.key),
            fetchWindow(API_STORE.key),
            fetchWindow(BROWSER_STORE.key),
            fetchPool(API_STORE.key),
            fetchPool(BROWSER_STORE.key),
          ]);
        // Exact aisle totals from the count queries (the windows are
        // just the pages being displayed).
        total =
          args.store === API_STORE.key
            ? mCount
            : args.store === BROWSER_STORE.key
              ? sCount
              : mCount + sCount;
        mProds = mWin.map((r) => catalogRowToProduct(r));
        sProds = sWin.map((r) => catalogRowToProduct(r));
        mPool = mPoolP;
        sPool = sPoolP;
      }

      // Comparable marking: a product is comparable when the OTHER
      // store's pool holds the same kind of product. A word index
      // over the pool keeps the check cheap on big aisles: only pool
      // products sharing a content word can possibly pair.
      const poolIndex = (pool: Product[]) => {
        const idx = new Map<string, Product[]>();
        for (const q of pool) {
          for (const w of new Set(contentWords(q.name).map(foldWord))) {
            const arr = idx.get(w);
            if (arr) arr.push(q);
            else idx.set(w, [q]);
          }
        }
        return idx;
      };
      const comparableFor = (
        p: Product,
        idx: Map<string, Product[]>,
      ): boolean => {
        const seen = new Set<Product>();
        for (const w of new Set(contentWords(p.name).map(foldWord))) {
          for (const q of idx.get(w) ?? []) {
            if (seen.has(q)) continue;
            seen.add(q);
            if (pairMatchTwo(context, p, q)) return true;
          }
        }
        return false;
      };
      const sevenIdx = poolIndex(sPool);
      const mavenIdx = poolIndex(mPool);
      const all: BrowseProduct[] = [
        ...mProds.map((p) => ({
          ...p,
          store: API_STORE.key,
          comparable: comparableFor(p, sevenIdx),
        })),
        ...sProds.map((p) => ({
          ...p,
          store: BROWSER_STORE.key,
          comparable: comparableFor(p, mavenIdx),
        })),
      ];
      const filtered = args.store
        ? all.filter((p) => p.store === args.store)
        : all;
      if (query) {
        const sorted = scoredEntries(query, filtered)
          .map((e, i) => ({ p: e.item, i, s: e.score }))
          .sort((a, b) => b.s - a.s || a.i - b.i)
          .map((x) => x.p);
        total = sorted.length;
        display = sorted.slice(offset, offset + limit);
      } else {
        const sorted = [...filtered].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        display = sorted.slice(offset, offset + limit);
      }
      return { categories, products: display, total };
    },
  }),

  getCart: defineAction({
    description:
      "Returns the user's shopping list (cart): every picked product with its store, catalog price, and quantity, plus the per-store totals for the list. Multi-buy deal rows carry their deal and a deal-aware lineTotal: full deal bundles are charged at the bundle total, leftover items at the regular single-item price when the store shows one (otherwise at the per-item deal price). Per-pound rows (priceBasis per_lb/per_oz — meat, chicken) carry qty as pounds/ounces and their lineTotal is simply the per-weight price × the weight.",
    request: z.object({}),
    response: z.object({
      items: z.array(
        z.object({
          id: z.number(),
          store: storeEnum,
          name: z.string(),
          price: z.number(),
          category: z.string().nullable(),
          qty: z.number(),
          dealText: z.string().nullable(),
          dealQty: z.number().nullable(),
          dealTotal: z.number().nullable(),
          regularPrice: z.number().nullable(),
          // "per_lb" / "per_oz" when the store prices this product
          // by weight (qty then counts pounds/ounces); null = each.
          priceBasis: z.enum(["per_lb", "per_oz"]).nullable(),
          lineTotal: z.number(),
        }),
      ),
      mavenTotal: z.number(),
      sevenTotal: z.number(),
      count: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.cartItems)
        .orderBy(asc(schema.cartItems.store), asc(schema.cartItems.id));
      const round = (n: number) => Math.round(n * 100) / 100;
      const lineTotal = (r: (typeof rows)[number]): number => {
        // Priced by weight: qty IS the weight — price × pounds.
        if (r.priceBasis === "per_lb" || r.priceBasis === "per_oz") {
          return round(r.price * r.qty);
        }
        if (r.dealQty != null && r.dealQty > 1 && r.dealTotal != null) {
          const bundles = Math.floor(r.qty / r.dealQty);
          const leftover = r.qty - bundles * r.dealQty;
          return round(
            bundles * r.dealTotal + leftover * (r.regularPrice ?? r.price),
          );
        }
        return round(r.price * r.qty);
      };
      const items = rows.map((r) => ({
        id: r.id,
        store: r.store,
        name: r.name,
        price: r.price,
        category: r.category,
        qty: r.qty,
        dealText: r.dealText,
        dealQty: r.dealQty,
        dealTotal: r.dealTotal,
        regularPrice: r.regularPrice,
        priceBasis:
          r.priceBasis === "per_lb"
            ? ("per_lb" as const)
            : r.priceBasis === "per_oz"
              ? ("per_oz" as const)
              : null,
        lineTotal: lineTotal(r),
      }));
      return {
        items,
        mavenTotal: round(
          items.filter((r) => r.store === API_STORE.key).reduce((s, r) => s + r.lineTotal, 0),
        ),
        sevenTotal: round(
          items.filter((r) => r.store === BROWSER_STORE.key).reduce((s, r) => s + r.lineTotal, 0),
        ),
        count: rows.reduce((s, r) => s + r.qty, 0),
      };
    },
  }),

  addToCart: defineAction({
    description:
      "Adds a product to the shopping list (cart) for a specific store, priced from the product catalog's own record for that product — a price supplied by the caller is never used, and a product the catalog doesn't know is refused (ok: false) rather than added at a made-up price. Adding the same product for the same store again raises its quantity instead of duplicating the row.",
    request: z.object({
      store: storeEnum,
      name: z.string().min(2).max(200),
      // Accepted for call compatibility but IGNORED: the catalog is
      // the only source of prices (see the description).
      price: z.number().positive().max(100000),
      category: z.string().max(120).nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().nullable(),
      qty: z.number(),
      error: z.string().nullable(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: boolean; id: number | null; qty: number; error: string | null }> {
      const db = ctx.db<typeof schema>();
      const nameNorm = normalizeName(args.name);
      // The catalog's own record for this product is the only price
      // the artifact stands behind. Without one there is nothing
      // honest to add — refuse instead of trusting the caller's price.
      const cat = await db
        .select()
        .from(schema.catalogProducts)
        .where(
          and(
            eq(schema.catalogProducts.store, args.store),
            eq(schema.catalogProducts.nameNorm, nameNorm),
          ),
        )
        .limit(1);
      const catRow = cat[0];
      if (!catRow) {
        return {
          ok: false,
          id: null,
          qty: 0,
          error: `That product isn't in the ${STORES[args.store].name} catalog yet, so there's no verified price to add it at.`,
        };
      }
      const name = catRow.name;
      const price = catRow.price;
      const category = catRow.category;
      // The catalog's deal (if any) rides along so list totals can
      // price full bundles at the bundle total.
      const dealFields = {
        dealText: catRow?.dealText ?? null,
        dealQty: catRow?.dealQty ?? null,
        dealTotal: catRow?.dealTotal ?? null,
        regularPrice: catRow?.regularPrice ?? null,
      };
      // Per-weight pricing rides along too, from the catalog row's
      // own price text: a per-pound chicken's list quantity means
      // pounds, and its price must never total as one package.
      const basis = catRow
        ? priceBasisOf(catRow.priceText, null, catRow.name)
        : "each";
      const priceBasis = basis === "each" ? null : basis;
      const existing = await db
        .select()
        .from(schema.cartItems)
        .where(
          and(
            eq(schema.cartItems.store, args.store),
            eq(schema.cartItems.nameNorm, nameNorm),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (row) {
        const qty = row.qty + 1;
        await db
          .update(schema.cartItems)
          .set({ qty, price, name, category, ...dealFields, priceBasis })
          .where(eq(schema.cartItems.id, row.id));
        ctx.invalidateQueries();
        return { ok: true, id: row.id, qty, error: null };
      }
      const inserted = await db
        .insert(schema.cartItems)
        .values({
          store: args.store,
          name,
          nameNorm,
          price,
          category,
          ...dealFields,
          priceBasis,
          qty: 1,
        })
        .returning({ id: schema.cartItems.id });
      const ins = inserted[0];
      if (!ins) throw new Error("addToCart: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, id: ins.id, qty: 1, error: null };
    },
  }),

  setCartQty: defineAction({
    description:
      "Sets the quantity of one shopping-list (cart) row; a quantity of 0 removes the row.",
    request: z.object({ id: z.number(), qty: z.number().int().min(0).max(99) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      if (args.qty === 0) {
        await db
          .delete(schema.cartItems)
          .where(eq(schema.cartItems.id, args.id));
      } else {
        await db
          .update(schema.cartItems)
          .set({ qty: args.qty })
          .where(eq(schema.cartItems.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  removeCartItem: defineAction({
    description: "Removes one row from the shopping list (cart).",
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.cartItems)
        .where(eq(schema.cartItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  clearCart: defineAction({
    description: "Empties the shopping list (cart).",
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.cartItems);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
