// Store + locale configuration — the single source of truth for WHICH
// two stores this space compares and the locale it speaks.
//
// Everything store-shaped reads from here: the database enums
// (schema.ts passes STORE_KEYS to drizzle), the Zod request/response
// schemas (storeEnum in actions.ts), the client (imported via the
// @space/server/stores path alias), verdict text, flyer links, and the
// browser-agent prompts. To retarget the space at two different
// stores, edit this file (plus the adapter notes in DESIGN.md) — no
// other code names a store.
//
// Access modes:
//  - "api": the store exposes a public JSON product API the server can
//    fetch directly (Market Maven runs on MyCloudGrocer — see the
//    adapter notes in DESIGN.md). These stores get a full-catalog
//    crawl and live per-query checks, and support accuracy spot checks.
//  - "browser": the store sits behind a bot check (Seven Mile runs on
//    stor.ai/Selfpoint behind Cloudflare), so its catalog is indexed
//    by background browser agents sweeping section by section. What
//    the agents sweep still comes from the store itself: a stor.ai
//    storefront publishes its whole category tree in a keyless blob
//    (`catalogBlobUrl`) the server can fetch directly, so the work
//    queue is seeded from real leaf categories, with sitemap
//    discovery kept only as the fallback when that fetch fails.

export const STORE_KEYS = ["maven", "seven"] as const;
export type StoreKey = (typeof STORE_KEYS)[number];

export type StoreAccess = "api" | "browser";

/** Which storefront platform a browser store runs on, when known —
 *  the key that unlocks that platform's keyless catalog surfaces
 *  (see the adapter notes in DESIGN.md). */
export type StorePlatform = "mycloudgrocer" | "storai";

/** How a browser store's category pages get read. "tiles" is the
 *  shipped default: the agent reads the rendered listing tiles, which
 *  is the only source that carries sale badges and sizes. "json" is
 *  the stor.ai JSON-API experiment — exact names and prices in small
 *  pages, but no sale flag and no barcode — and must prove it matches
 *  the tile read on a store before being switched on for it. */
export type CatalogRead = "tiles" | "json";

export interface StoreConfig {
  /** Stable key stored in the database and used in verdicts. */
  key: StoreKey;
  /** Full display name ("Market Maven"). */
  name: string;
  /** Short label for badges and score strips ("Maven"). */
  short: string;
  /** CSS custom property holding the store's colour (theme.css). */
  colorVar: string;
  /** Store homepage, linked from product cards. */
  homepage: string;
  /** Weekly flyer / specials page, linked from the Specials view. */
  flyerUrl: string;
  /** Link text for the flyer link. */
  flyerLabel: string;
  /** How the catalog reaches this store (see header). */
  access: StoreAccess;
  /** Whether the Settings accuracy spot check applies (API stores). */
  spotCheck: boolean;
  /** Storefront platform, when identified by the Step 1 probe. */
  platform?: StorePlatform;
  /** stor.ai retailer id (the `r-<id>` in its catalog blob path). */
  retailerId?: number;
  /** stor.ai branch id — the physical store whose stock/prices count. */
  branchId?: number;
  /**
   * Public, keyless URL of the storefront's catalog-tree blob. The
   * server CAN fetch this even when the storefront itself answers 403,
   * so the sweep seeds one section per real leaf category instead of
   * asking a browser agent to transcribe a sitemap page. Leave unset
   * and the sweep falls back to sitemap discovery.
   */
  catalogBlobUrl?: string;
  /** Category-page read mode; defaults to "tiles" when unset. */
  catalogRead?: CatalogRead;
}

export const STORES: Record<StoreKey, StoreConfig> = {
  maven: {
    key: "maven",
    name: "Market Maven",
    short: "Maven",
    colorVar: "--maven",
    homepage: "https://www.marketmavenmd.com/",
    flyerUrl: "https://marketmavenmd.com/Baltimore/circular",
    flyerLabel: "Market Maven’s weekly flyer",
    access: "api",
    spotCheck: true,
  },
  seven: {
    key: "seven",
    name: "Seven Mile",
    short: "Seven Mile",
    colorVar: "--seven",
    homepage: "https://www.shopsevenmilemarket.com/",
    flyerUrl: "https://www.shopsevenmilemarket.com/specials",
    flyerLabel: "Seven Mile’s specials page",
    access: "browser",
    spotCheck: false,
    platform: "storai",
    retailerId: 1138,
    branchId: 967,
    catalogBlobUrl:
      "https://htmlcache.blob.core.windows.net/html-production-env/r-1138/desktop/multi-true/data.js",
    catalogRead: "tiles",
  },
};

/** Stores in display order (first store first everywhere). */
export const STORE_LIST: StoreConfig[] = STORE_KEYS.map((k) => STORES[k]);

/** The API-access store (full-crawl + spot checks), if one is configured. */
export const API_STORE: StoreConfig =
  STORE_LIST.find((s) => s.access === "api") ?? STORES.maven;

/** The browser-access store (agent-indexed sweep), if one is configured. */
export const BROWSER_STORE: StoreConfig =
  STORE_LIST.find((s) => s.access === "browser") ?? STORES.seven;

// ---------- locale / owner knobs ----------

/**
 * Locale knobs. `timeZone` must match the timezone named in the
 * managed cron schedules in space.json (cron strings are platform
 * data and can't read this file); `currency` formats every price.
 */
export const LOCALE = {
  timeZone: "America/New_York",
  language: "en-US",
  currency: "USD",
  currencySymbol: "$",
} as const;

/** One-tap suggestion chips on the search form (UI affordances, not data). */
export const SUGGESTION_CHIPS: string[] = [
  "Milk",
  "Eggs",
  "Chicken breast",
  "Olive oil",
  "Bread",
  "Cheese",
  "Orange juice",
  "Chips",
];

/**
 * Example brand used in placeholders and sample text ("I prefer… e.g.
 * …"). A local brand the first store is known for; swap it when
 * retargeting the space.
 */
export const EXAMPLE_BRAND = "Pride of the Farm";

/**
 * Words that mark a store category as holiday/seasonal for the Shop's
 * aisle mapping (aisleForCategory in lib.ts). Locale/religion-specific
 * by nature — replace with the holidays the target stores observe.
 */
export const HOLIDAY_WORDS: string[] = [
  "chanukah",
  "hanukkah",
  "passover",
  "pesach",
  "purim",
  "sukkot",
  "shavuot",
  "holiday",
  "seasonal",
];
