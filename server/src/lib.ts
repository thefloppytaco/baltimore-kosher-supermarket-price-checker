// Pure matching and pricing functions — no database, no fetch, no
// platform calls. Everything here is deterministic over its inputs,
// which is what makes it unit-testable (lib.test.ts) and portable to
// a rebuilt copy of this space. actions.ts holds the stateful shell
// (catalog, snapshots, agent sweep) around these functions.
//
// The rules encoded here, in brief:
//  - A product's stored `price` is ALWAYS its per-item price; a
//    multi-buy deal ("4 for $5.00") is kept separately and the bundle
//    total never stands in for one item's price (parseDealText).
//  - A price is per-pound/per-ounce ONLY when the store's own price
//    text says so ("/ lb", "per lb") — a package size in the name
//    never makes a product weight-priced (priceBasisOf).
//  - Matching is word-level with singular/plural folding, scored by
//    whether the query words are the product's head noun, adjusted
//    by name purity and category agreement (scoreMatch/scoredEntries).
//  - Two products compare only when they are the same KIND — same
//    item, grade, and variant under each store's own naming
//    (pairSignature/pairProducts).

import {
  HOLIDAY_WORDS,
  LOCALE,
  STORES,
  STORE_KEYS,
  type StoreKey,
} from "./stores";

/** A product as the pricing/matching layer sees it. actions.ts's
 *  zod-validated Product is structurally this shape. */
export interface Product {
  name: string;
  price: number;
  sizeText: string | null;
  unitPrice: number | null;
  unitLabel: string | null;
  unitFamily: string | null;
  priceBasis: PriceBasis;
  priceText: string | null;
  onSale: boolean;
  dealText: string | null;
  dealQty: number | null;
  dealTotal: number | null;
  regularPrice: number | null;
  imageUrl: string | null;
  category: string | null;
}

/** The slice of a store snapshot verdictFor reads. */
export interface SnapLike {
  best: Product | null;
}

export interface Verdict {
  winner: StoreKey | "tie" | "none";
  basis: "unit" | "price" | null;
  diff: number | null;
  text: string;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function queryTokens(query: string): string[] {
  return normalizeName(query).split(" ").filter(Boolean);
}

// ---------- size / per-unit parsing ----------

export type ParsedSize = { qty: number; family: string; label: string };

export function parseSize(name: string): ParsedSize | null {
  // Multipacks first: "12×12 Oz" / "12 x 0.67 Oz" is twelve packages
  // of that size — the total is the product of the two numbers (the
  // plain pattern below would otherwise read only the second number
  // and understate the package 12-fold).
  const multi = name.match(
    /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|lb|lbs|ct|count|pk|pack)\b/i,
  );
  if (multi) {
    const packs = Number(multi[1]);
    const each = Number(multi[2]);
    const unit = (multi[3] ?? "").toLowerCase().replace(/\s+/g, "");
    if (packs > 1 && each > 0) {
      if (unit === "oz" || unit === "fl.oz" || unit === "floz")
        return { qty: packs * each, family: "oz", label: "$/oz" };
      if (unit === "lb" || unit === "lbs")
        return { qty: packs * each * 16, family: "oz", label: "$/oz" };
      return { qty: packs * each, family: "ct", label: "$/ct" };
    }
  }
  // Fraction sizes first: "1/2 Gal", "1/2 Galon"
  const frac = name.match(/(\d+)\s*\/\s*(\d+)\s*(gallons?|gal(?:on)?|l|liter|quarts?)\b/i);
  if (frac) {
    const qty = Number(frac[1]) / Number(frac[2]);
    const unit = (frac[3] ?? "").toLowerCase();
    if (unit.startsWith("quart")) return { qty: qty * 32, family: "oz", label: "$/oz" };
    if (unit === "l" || unit.startsWith("liter"))
      return { qty: qty * 33.814, family: "oz", label: "$/oz" };
    return { qty: qty * 128, family: "oz", label: "$/oz" };
  }
  const m = name.match(
    /(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|lb|lbs|gallons?|gal(?:on)?|quarts?|qt|pints?|liter|litre|ml|ct|count|pk|pack|eggs?)\b/i,
  );
  if (!m) return null;
  const qty = Number(m[1]);
  if (!qty || Number.isNaN(qty)) return null;
  const unit = (m[2] ?? "").toLowerCase().replace(/\s+/g, "");
  // One "oz" family for weight and fluid volume (grocery-pragmatic):
  // fl oz = oz, lb = 16 oz, gallon = 128 oz, quart = 32 oz, pint = 16 oz.
  if (unit === "oz" || unit === "fl.oz" || unit === "floz")
    return { qty, family: "oz", label: "$/oz" };
  if (unit === "lb" || unit === "lbs")
    return { qty: qty * 16, family: "oz", label: "$/oz" };
  if (unit.startsWith("gal")) return { qty: qty * 128, family: "oz", label: "$/oz" };
  if (unit.startsWith("quart") || unit === "qt")
    return { qty: qty * 32, family: "oz", label: "$/oz" };
  if (unit.startsWith("pint") || unit === "pt")
    return { qty: qty * 16, family: "oz", label: "$/oz" };
  if (unit === "liter" || unit === "litre")
    return { qty: qty * 33.814, family: "oz", label: "$/oz" };
  if (unit === "ml") return { qty: qty / 29.574, family: "oz", label: "$/oz" };
  // count family: ct / count / pk / pack / eggs
  return { qty, family: "ct", label: "$/ct" };
}

export type PriceBasis = "each" | "per_lb" | "per_oz";

/**
 * What a price buys, from per-weight wording ONLY: "$7.99 / lb",
 * "per lb", "/ Lb" in the price text or size text, or the same slash /
 * "per" forms in the product name. A bare weight in the name ("3 Lb",
 * "24 Oz") is a package size — the package is priced as a whole — so
 * it deliberately does NOT match here (the regex requires the slash
 * or the word "per" immediately before the unit).
 */
export function priceBasisOf(
  priceText: string | null | undefined,
  sizeText: string | null | undefined,
  name: string,
): PriceBasis {
  const perWeight = (t: string | null | undefined): PriceBasis | null => {
    if (!t) return null;
    const m = t.match(/(?:\/|\bper)\s*(lb|oz)\b/i);
    if (!m) return null;
    return m[1]!.toLowerCase() === "lb" ? "per_lb" : "per_oz";
  };
  return perWeight(priceText) ?? perWeight(sizeText) ?? perWeight(name) ?? "each";
}

/** True when the product is priced by weight (per lb or per oz). */
export function isWeightPriced(p: { priceBasis: PriceBasis }): boolean {
  return p.priceBasis !== "each";
}

export function withUnit(
  p: Omit<Product, "unitPrice" | "unitLabel" | "unitFamily" | "priceBasis"> & {
    priceBasis?: PriceBasis;
  },
): Product {
  const priceBasis =
    p.priceBasis ?? priceBasisOf(p.priceText, p.sizeText, p.name);
  const base = { ...p, priceBasis };
  // Priced by weight: `price` is already the price of one lb (or one
  // oz) — the pack size in the name must NOT divide it. The
  // comparison value is normalized to $/oz (the family every packaged
  // weight also lands in) so per-pound and packaged products compare
  // unit-for-unit; displays use priceBasis to show "$X/lb".
  if (priceBasis === "per_lb") {
    return {
      ...base,
      sizeText: p.sizeText ?? "1 lb",
      unitPrice: Math.round((p.price / 16) * 10000) / 10000,
      unitLabel: "$/oz",
      unitFamily: "oz",
    };
  }
  if (priceBasis === "per_oz") {
    return {
      ...base,
      sizeText: p.sizeText ?? "1 oz",
      unitPrice: p.price,
      unitLabel: "$/oz",
      unitFamily: "oz",
    };
  }
  const text = p.sizeText ?? p.name;
  const parsed = parseSize(text) ?? parseSize(p.name);
  if (!parsed || parsed.qty <= 0) {
    return { ...base, unitPrice: null, unitLabel: null, unitFamily: null };
  }
  return {
    ...base,
    unitPrice: Math.round((p.price / parsed.qty) * 10000) / 10000,
    unitLabel: parsed.label,
    unitFamily: parsed.family,
  };
}

// ---------- multi-buy deals ----------

/** A parsed multi-buy deal: `qty` items together cost `total`. */
export type DealInfo = { qty: number; total: number; text: string };

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Per-item price under a deal, rounded to the cent. */
export function dealPerItem(deal: DealInfo): number {
  return roundMoney(deal.total / deal.qty);
}

const DEAL_WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
};

export function dealCount(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return DEAL_WORD_NUMBERS[raw.toLowerCase()] ?? fallback;
}

/**
 * Parse multi-buy wording into a deal, given the price the store
 * displays alongside it. Handles the shapes grocery stores actually
 * use: "4 for $5.00" / "4/$5.00" (the displayed price is the bundle
 * total), "Buy 1, get 1 free" / "BOGO" (displayed price is the
 * single-item price; the deal covers buy+get items for buy×price),
 * and "Buy 2, get 1 at 50% off" / "BOGO 50% off". Returns null when
 * the text carries no recognizable multi-buy deal — a plain sale
 * price is not a deal and must not be divided.
 */
export function parseDealText(
  dealText: string | null | undefined,
  listedPrice: number,
): DealInfo | null {
  if (!dealText || !(listedPrice > 0)) return null;
  const text = dealText.trim();
  if (!text) return null;
  // "N for $X" / "N for X" / "N/$X" / "N / X"
  const forMatch = text.match(
    /(\d+)\s*(?:for|\/)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i,
  );
  if (forMatch) {
    const qty = Number(forMatch[1]);
    const total = Number(forMatch[2]);
    if (qty > 1 && total > 0) return { qty, total, text };
  }
  // Buy X get Y … (free / % off), spelled or numbered.
  const buyGet = text.match(
    /buy\s*(\d+|one|two|three|four|five|six)\b[^.]*?get\s*(\d+|one|two|three|four|five|six)\b([^.]*)/i,
  );
  if (buyGet) {
    const buy = dealCount(buyGet[1], 1);
    const get = dealCount(buyGet[2], 1);
    const rest = (buyGet[3] ?? "").toLowerCase();
    const pct = rest.match(/(\d+(?:\.\d+)?)\s*%/);
    if (rest.includes("free") || (!pct && /bogo/i.test(text))) {
      return { qty: buy + get, total: roundMoney(listedPrice * buy), text };
    }
    if (pct) {
      const off = Number(pct[1]) / 100;
      if (off > 0 && off < 1) {
        return {
          qty: buy + get,
          total: roundMoney(listedPrice * (buy + get * (1 - off))),
          text,
        };
      }
    }
    return null;
  }
  // Bare "BOGO" / "buy one get one" without quantities spelled out in
  // the buy/get pattern above: the standard reading is buy 1 get 1,
  // free or at the stated % off.
  if (/\bbogo\b/i.test(text) || /buy\s+one\s*,?\s*get\s+one/i.test(text)) {
    const pct = text.match(/(\d+(?:\.\d+)?)\s*%\s*off/i);
    if (pct) {
      const off = Number(pct[1]) / 100;
      if (off > 0 && off < 1) {
        return { qty: 2, total: roundMoney(listedPrice * (2 - off)), text };
      }
      return null;
    }
    return { qty: 2, total: listedPrice, text };
  }
  return null;
}

// ---------- match relevance ----------

// Words that describe packaging/size rather than the product itself —
// they don't count as "some other product" when they trail the matched
// query words in a product name.
const SIZE_WORDS = new Set([
  "oz", "floz", "fl", "lb", "lbs", "g", "kg", "ml", "l", "ct", "count",
  "pk", "pack", "packs", "doz", "dozen", "gal", "gallon", "gallons",
  "galon", "qt", "quart", "quarts", "pint", "pints", "pt", "liter",
  "liters", "litre", "litres", "x",
]);
// Glue words that carry no product identity.
const GLUE_WORDS = new Set(["a", "an", "the", "of", "with", "and", "w"]);
// Grade/size/fat-content adjectives: when they trail the matched
// words ("Pride Of The Farm Milk Low-fat, 1/2 Galon", "Eggs Jumbo
// Brown Organic") the product is still the item itself, so they don't
// count as trailing "some other product" words.
const DESCRIPTOR_WORDS = new Set([
  "large", "medium", "small", "jumbo", "mini", "extra", "whole",
  "skim", "lowfat", "low", "fat", "free", "fresh", "white", "brown",
  "grade", "virgin", "pure", "raw", "natural", "organic", "cage",
  "range", "lite", "light", "reduced", "fatfree", "boneless", "skinless",
]);
// Words that turn the item into a different product when they appear
// in its name: flavored and plant-based variants. "Chocolate Milk"
// and "Coconut Milk" are not what a list means by "milk". Penalized
// only when the word isn't itself part of the query, so searching
// "chocolate milk" or "almond milk" is unaffected.
const VARIANT_WORDS = new Set([
  "chocolate", "strawberry", "vanilla", "caramel", "mocha",
  "flavored", "flavoured", "coconut", "almond", "oat", "soy", "cashew",
  // A spray is a different form of the product: "olive oil" on a list
  // means a bottle, not the cooking spray.
  "spray",
  // Chip flavors are different products from plain chips (and from
  // each other): a pizza-flavored crisp must not pair with plain
  // potato chips just because both names end in "Potato Chips".
  "bbq", "barbecue", "barbeque", "pizza", "ketchup",
]);

export function isSizeWord(w: string): boolean {
  if (SIZE_WORDS.has(w)) return true;
  // Plain numbers, fractions, and glued number+unit tokens ("16oz").
  return (
    /^\d+(\.\d+)?$/.test(w) ||
    /^\d+\/\d+$/.test(w) ||
    /^\d+(oz|lb|lbs|ct|pk|ml|g|kg|l)$/.test(w)
  );
}

/** Fold a word for comparison: one trailing "s" stripped ("eggs"→"egg"). */
export function foldWord(w: string): string {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}

export function wordMatches(word: string, token: string): boolean {
  return foldWord(word) === foldWord(token);
}

export type MatchScore = { score: number; coverage: number; purity: number };

/**
 * Relevance of one product name for a query. The core idea: the query
 * words should name what the product IS (its head noun), not merely
 * appear somewhere in its name. "Medium Eggs" is eggs; "Dinosaur Eggs
 * Brown Sugar Instant Oatmeal" is oatmeal with an egg-themed name —
 * the content words trailing the last matched query word (sizes and a
 * "(Brand)" note don't count) are what the product actually is, so
 * they cost score, and a product whose name ends at the query words
 * (plus sizes) earns a head-match bonus. Matching is word-level with
 * singular/plural folding, so "egg" no longer hits "eggplant"/"Eggo"
 * the way the old substring match did.
 */
export function scoreMatch(query: string, rawName: string): MatchScore {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return { score: 0, coverage: 0, purity: 1 };
  // A "(Brand)" note is packaging metadata, not product words.
  const name = rawName.replace(/\([^)]*\)/g, " ");
  const words = normalizeName(name).split(" ").filter(Boolean);
  let coverageCount = 0;
  let lastMatchIdx = -1;
  let firstMatchIdx = Number.POSITIVE_INFINITY;
  for (const t of tokens) {
    let hit = false;
    words.forEach((w, i) => {
      if (wordMatches(w, t)) {
        hit = true;
        if (i > lastMatchIdx) lastMatchIdx = i;
        if (i < firstMatchIdx) firstMatchIdx = i;
      }
    });
    if (hit) coverageCount++;
  }
  const coverage = coverageCount / tokens.length;
  if (coverage === 0 || lastMatchIdx < 0) return { score: -100, coverage: 0, purity: 0 };
  const trailing = words
    .slice(lastMatchIdx + 1)
    .filter(
      (w) => !isSizeWord(w) && !GLUE_WORDS.has(w) && !DESCRIPTOR_WORDS.has(w),
    ).length;
  // Name purity: the share of the name's words that are the item
  // itself — query words, grade descriptors, sizes, glue. A bottle
  // named "Extra Virgin Olive Oil" is pure; "Fancy Solid Tuna Extra
  // Virgin Olive Oil" is mostly another product that merely ends
  // with the query phrase (this naming style drops the "in"), so
  // impurity costs score in proportion.
  const pureCount = words.filter(
    (w) =>
      isSizeWord(w) ||
      GLUE_WORDS.has(w) ||
      DESCRIPTOR_WORDS.has(w) ||
      tokens.some((t) => wordMatches(w, t)),
  ).length;
  const purity = words.length > 0 ? pureCount / words.length : 0;
  let score =
    coverage * 10 +
    (trailing === 0 ? 2 : 0) -
    trailing * 0.6 -
    (Number.isFinite(firstMatchIdx) ? firstMatchIdx * 0.05 : 0) -
    words.length * 0.02 -
    (1 - purity) * 3;
  // "Tuna In Olive Oil" / "Sardines in Extra Virgin Olive Oil" /
  // "Olives With Olive Oil": when a matched phrase is introduced by
  // "in" or "with" — allowing grade descriptors in between ("in pure
  // olive oil", "in extra virgin olive oil") — the query names an
  // ingredient or packing medium, and the product itself is whatever
  // came before the preposition. Heavy penalty (waived when the
  // preposition is part of the query, e.g. "tuna in olive oil").
  const precededByPrep = words.some((w, i) => {
    if (!tokens.some((t) => wordMatches(w, t))) return false;
    let j = i - 1;
    while (j >= 0 && DESCRIPTOR_WORDS.has(words[j]!)) j--;
    const prep = j >= 0 ? words[j] : undefined;
    return (prep === "in" || prep === "with") && !tokens.includes(prep);
  });
  if (precededByPrep) score -= 4;
  // Flavored / plant-based variants of the item are different
  // products ("Chocolate Milk" for "milk").
  const foldedTokens = tokens.map(foldWord);
  if (
    words.some(
      (w) => VARIANT_WORDS.has(w) && !foldedTokens.includes(foldWord(w)),
    )
  ) {
    score -= 2;
  }
  return { score, coverage, purity };
}

export type ScoredEntry<T> = { item: T; score: number; coverage: number; purity: number };

/**
 * Score a set of named, categorized items for a query: name relevance
 * (scoreMatch) plus category agreement — products shelved in the
 * aisle the query belongs to get a bonus, products shelved in a
 * different known aisle a penalty. This is what keeps "Dinosaur
 * Eggs" oatmeal out of the eggs results once a store's products
 * carry their categories; where categories are unknown it simply
 * doesn't vote. Shared by the catalog matcher, the headline pick,
 * and the board's display sort so all three rank the same way.
 */
export function scoredEntries<T extends { name: string; category: string | null }>(
  query: string,
  items: T[],
): ScoredEntry<T>[] {
  const entries = items.map((item) => ({ item, ...scoreMatch(query, item.name) }));
  const tokens = queryTokens(query);
  const full = entries.filter((e) => e.coverage >= 0.999 && e.item.category);
  // Which aisle does the query belong to? First choice: an aisle
  // named after the item itself (a category whose name contains
  // every query word — "Milk", "Fresh Eggs") — that vote can't be
  // flooded by a neighboring aisle the way a raw count can (yogurts
  // whose names mention milk fat would otherwise outvote the milk
  // aisle). Fallback: the aisle most full-coverage candidates sit in.
  const aisleNamedForItem = (cat: string) => {
    const catWords = normalizeName(cat).split(" ").filter(Boolean);
    return (
      tokens.length > 0 &&
      tokens.every((t) => catWords.some((w) => wordMatches(w, t)))
    );
  };
  // Only names that are mostly the item itself get to vote on its
  // aisle — otherwise a flooded candidate pool (every canned fish
  // "in olive oil", every yogurt mentioning milk fat) picks the
  // wrong aisle by sheer numbers.
  let pool = full.filter(
    (e) => e.purity >= 0.75 && aisleNamedForItem(e.item.category!),
  );
  if (pool.length === 0) pool = full.filter((e) => e.purity >= 0.75);
  if (pool.length === 0) pool = full;
  const catCounts = new Map<string, number>();
  for (const e of pool) {
    catCounts.set(e.item.category!, (catCounts.get(e.item.category!) ?? 0) + 1);
  }
  let modalCat: string | null = null;
  let modalN = 0;
  for (const [c, n] of catCounts) {
    if (n > modalN) {
      modalN = n;
      modalCat = c;
    }
  }
  if (modalCat && modalN >= 2) {
    for (const e of entries) {
      if (e.item.category) e.score += e.item.category === modalCat ? 1 : -1;
    }
  }
  return entries;
}

/**
 * Pick the representative product: most common unit family, then
 * lowest per-unit. When the query is known, only the top relevance
 * tier competes — a cheap per-unit price on an off-target product
 * (oatmeal surfacing for "eggs" because its name contains the word)
 * must never beat the products that actually are the item, which is
 * exactly the wrong-verdict bug this fixes. One exception: when the
 * tier's most relevant product carries no per-unit price — Seven
 * Mile's plainly-named standard products ("Medium Eggs") often
 * don't — the representative is the tier's lowest listed price, so
 * sized specialty variants (a $1.99 double-yolk dozen) don't speak
 * for the store over its standard item.
 */
export function pickBest(products: Product[], query?: string): Product | null {
  if (products.length === 0) return null;
  let pool = products;
  if (query) {
    const entries = scoredEntries(query, products).filter((e) => e.coverage > 0);
    if (entries.length > 0) {
      let top = Number.NEGATIVE_INFINITY;
      let topEntry: ScoredEntry<Product> | null = null;
      for (const e of entries) {
        if (e.score > top) {
          top = e.score;
          topEntry = e;
        }
      }
      const tier = entries.filter((e) => e.score >= top - 1.5).map((e) => e.item);
      if (tier.length > 0) pool = tier;
      if (topEntry && topEntry.item.unitPrice == null) {
        return [...pool].sort((a, b) => a.price - b.price)[0] ?? null;
      }
    }
  }
  const withUnits = pool.filter((p) => p.unitPrice != null && p.unitFamily != null);
  if (withUnits.length === 0) {
    return [...pool].sort((a, b) => a.price - b.price)[0] ?? null;
  }
  const famCount = new Map<string, number>();
  for (const p of withUnits) famCount.set(p.unitFamily!, (famCount.get(p.unitFamily!) ?? 0) + 1);
  let topFamily: string | null = null;
  let topCount = -1;
  for (const [fam, n] of famCount) {
    if (n > topCount) {
      topCount = n;
      topFamily = fam;
    }
  }
  const inFamily = withUnits.filter((p) => p.unitFamily === topFamily);
  return inFamily.sort((a, b) => (a.unitPrice ?? 0) - (b.unitPrice ?? 0))[0] ?? null;
}

export function verdictFor(first: SnapLike, second: SnapLike): Verdict {
  const FIRST = STORE_KEYS[0] ?? "maven";
  const SECOND = STORE_KEYS[1] ?? "seven";
  const mb = first.best;
  const sb = second.best;
  if (!mb || !sb) {
    return { winner: "none", basis: null, diff: null, text: "" };
  }
  if (
    mb.unitPrice != null &&
    sb.unitPrice != null &&
    mb.unitFamily != null &&
    mb.unitFamily === sb.unitFamily
  ) {
    const diff = Math.abs(mb.unitPrice - sb.unitPrice);
    if (diff < 0.005)
      return { winner: "tie", basis: "unit", diff: 0, text: "Same per-unit price" };
    const winner = mb.unitPrice < sb.unitPrice ? FIRST : SECOND;
    // Weight-priced on either side (meat, chicken, deli): the
    // comparison ran per ounce so a per-pound price could face a
    // packaged weight fairly, but the verdict is spoken per pound —
    // that's the unit these prices actually live in.
    if (
      (isWeightPriced(mb) || isWeightPriced(sb)) &&
      mb.unitFamily === "oz"
    ) {
      const diffLb = diff * 16;
      return {
        winner,
        basis: "unit",
        diff: Math.round(diffLb * 10000) / 10000,
        text: `${STORES[winner].name} by ${LOCALE.currencySymbol}${diffLb.toFixed(2)}/lb`,
      };
    }
    const per = mb.unitLabel?.replace("$/", "") ?? "unit";
    return {
      winner,
      basis: "unit",
      diff,
      text: `${STORES[winner].name} by ${LOCALE.currencySymbol}${diff.toFixed(2)}/${per}`,
    };
  }
  // A per-pound price must never be compared against a package price
  // as if they bought the same thing — when one side is priced by
  // weight and the two can't be compared unit-for-unit, there is no
  // honest verdict.
  if (isWeightPriced(mb) || isWeightPriced(sb)) {
    return { winner: "none", basis: null, diff: null, text: "" };
  }
  const diff = Math.abs(mb.price - sb.price);
  if (diff < 0.005)
    return { winner: "tie", basis: "price", diff: 0, text: "Same listed price" };
  const winner = mb.price < sb.price ? FIRST : SECOND;
  return {
    winner,
    basis: "price",
    diff,
    text: `${STORES[winner].name} by ${LOCALE.currencySymbol}${diff.toFixed(2)}`,
  };
}

// ---------- comparable pairing ----------

// A generic query ("chips", "eggs") matches many DIFFERENT products at
// each store, and lining the two stores' lists up side by side compares
// random products against random products. Pairing fixes that: two
// products are "directly comparable" only when they are the same KIND
// of product — same item, same variant/size class — under each store's
// own naming. The kind is captured by a signature: the product's
// content words (no sizes, no glue, no "(Brand)" notes) that are
//   - query words (the item itself),
//   - descriptor words (medium / large / jumbo / whole / brown …), so
//     large eggs never pair with medium eggs,
//   - variant words (chocolate, almond, spray …), so a variant never
//     pairs with the plain item, or
//   - words that appear in BOTH stores' candidate lists for the query
//     (the shared kind vocabulary — "potato" in potato chips at both
//     stores; brand words, which each store spells differently and
//     which sit in only one store's list, drop out).
// Products whose signatures match pair up; the rest are one-store-only
// for this query and stay out of the comparison (they still show in
// the shop, badged as such).

/** Content words of a product name: no sizes, no glue, no "(Brand)" notes. */
export function contentWords(name: string): string[] {
  const clean = name.replace(/\([^)]*\)/g, " ");
  return normalizeName(clean)
    .split(" ")
    .filter((w) => w && !isSizeWord(w) && !GLUE_WORDS.has(w));
}

export function pairSignature(
  query: string,
  name: string,
  sharedVocab: Set<string>,
): string {
  const q = new Set(queryTokens(query).map(foldWord));
  const sig = new Set<string>();
  for (const w of contentWords(name)) {
    // "Organic" is a production method, not a different kind of
    // product: an organic whole milk is still the whole-milk quote
    // for "milk", and keeping it in the signature made near-identical
    // products (an organic extra-virgin olive oil against a regular
    // one) count as incomparable. Size/grade/color descriptors
    // (medium, whole, brown) DO stay — those are different kinds.
    if (w === "organic") continue;
    const f = foldWord(w);
    if (
      q.has(f) ||
      DESCRIPTOR_WORDS.has(w) ||
      VARIANT_WORDS.has(w) ||
      sharedVocab.has(f)
    ) {
      sig.add(f);
    }
  }
  return [...sig].sort().join(" ");
}

export type PairGroup = { key: string; maven: Product[]; seven: Product[] };

/**
 * Pair two stores' candidate lists for a query into directly
 * comparable groups. Only word-level matches (coverage > 0) are
 * eligible — substring junk never pairs and never counts as
 * one-store-only either. Groups are ordered by their representatives'
 * relevance; products inside a group likewise (representative first).
 */
export function pairProducts(
  query: string,
  maven: Product[],
  seven: Product[],
): { pairs: PairGroup[]; mavenOnly: Product[]; sevenOnly: Product[] } {
  const vocab = (list: Product[]) =>
    new Set(list.flatMap((p) => contentWords(p.name).map(foldWord)));
  const vm = vocab(maven);
  const vs = vocab(seven);
  const shared = new Set([...vm].filter((w) => vs.has(w)));
  const qWords = new Set(queryTokens(query).map(foldWord));

  const groupSide = (list: Product[]) => {
    const entries = scoredEntries(query, list).filter((e) => e.coverage > 0);
    const scores = new Map<Product, number>();
    for (const e of entries) scores.set(e.item, e.score);
    // The aisle this item belongs to at this store (same selection
    // scoredEntries votes with): an aisle named after the item among
    // mostly-pure names, else the modal aisle of those names.
    const full = entries.filter((e) => e.coverage >= 0.999 && e.item.category);
    const aisleNamedForItem = (cat: string) => {
      const catWords = normalizeName(cat).split(" ").filter(Boolean);
      return queryTokens(query).every((t) =>
        catWords.some((w) => wordMatches(w, t)),
      );
    };
    let pool = full.filter(
      (e) => e.purity >= 0.75 && aisleNamedForItem(e.item.category!),
    );
    if (pool.length === 0) pool = full.filter((e) => e.purity >= 0.75);
    if (pool.length === 0) pool = full;
    const catCounts = new Map<string, number>();
    for (const e of pool) {
      catCounts.set(e.item.category!, (catCounts.get(e.item.category!) ?? 0) + 1);
    }
    let modalCat: string | null = null;
    let modalN = 0;
    for (const [c, n] of catCounts) {
      if (n > modalN) {
        modalN = n;
        modalCat = c;
      }
    }
    if (modalN < 2) modalCat = null;
    const catHasQueryWord = (cat: string) =>
      normalizeName(cat)
        .split(" ")
        .filter(Boolean)
        .some((w) => qWords.has(foldWord(w)));

    const groups = new Map<string, Product[]>();
    const only: Product[] = [];
    for (const e of entries) {
      const p = e.item;
      const sig = pairSignature(query, p.name, shared);
      // A signature with no query word in it isn't this item at all.
      if (!sig || !sig.split(" ").some((w) => qWords.has(w))) {
        only.push(p);
        continue;
      }
      // Junk guards — products that merely MENTION the item must not
      // pair on the bare query word alone ("Farfel No Eggs" pasta and
      // a "Gala & Eggs" prepared dish both reduce to the signature
      // "egg"): a bare signature (query words only) needs a name that
      // is mostly the item itself, and a product shelved in a
      // different aisle from the item's own, with an impure name, is
      // some other product that happens to mention it.
      const sigWords = sig.split(" ");
      const bare = sigWords.every((w) => qWords.has(w));
      const categoryVeto =
        p.category != null &&
        modalCat != null &&
        p.category !== modalCat &&
        !catHasQueryWord(p.category) &&
        e.purity < 0.75;
      if ((bare && e.purity < 0.75) || categoryVeto) continue;
      const arr = groups.get(sig);
      if (arr) arr.push(p);
      else groups.set(sig, [p]);
    }
    for (const arr of groups.values()) {
      arr.sort(
        (a, b) =>
          (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.price - b.price,
      );
    }
    only.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
    return { groups, only, scores };
  };

  const gm = groupSide(maven);
  const gs = groupSide(seven);
  const pairs: PairGroup[] = [];
  const pairedKeys = new Set<string>();
  for (const [key, mArr] of gm.groups) {
    const sArr = gs.groups.get(key);
    if (!sArr || sArr.length === 0) continue;
    pairs.push({ key, maven: mArr, seven: sArr });
    pairedKeys.add(key);
  }
  const repScore = (g: PairGroup) =>
    Math.max(
      gm.scores.get(g.maven[0]!) ?? 0,
      gs.scores.get(g.seven[0]!) ?? 0,
    );
  pairs.sort((a, b) => repScore(b) - repScore(a));
  // One-store-only for this query: eligible products that never formed
  // a group, plus every product in a group the other store doesn't have.
  const unpaired = (
    side: { groups: Map<string, Product[]>; only: Product[] },
  ): Product[] => {
    const out = [...side.only];
    for (const [key, arr] of side.groups) {
      if (!pairedKeys.has(key)) out.push(...arr);
    }
    return out;
  };
  return { pairs, mavenOnly: unpaired(gm), sevenOnly: unpaired(gs) };
}

/** True when two specific products are the same kind (see pairSignature). */
export function pairMatchTwo(query: string, a: Product, b: Product): boolean {
  const bWords = new Set(contentWords(b.name).map(foldWord));
  const shared = new Set(
    contentWords(a.name).map(foldWord).filter((w) => bWords.has(w)),
  );
  const sa = pairSignature(query, a.name, shared);
  const sb = pairSignature(query, b.name, shared);
  return sa !== "" && sa === sb;
}

// ---------- supermarket aisles ----------
// The Shop browses by the aisles of a normal supermarket, shared by
// both stores — NOT by the stores' own category names. Those names
// are product-level at one store and department-level at the other
// ("Applesauce" is not an aisle; neither store's tree lines up with
// the other's), so the same food used to land in different
// "categories" depending on which store named it. Every raw store
// category maps to exactly one aisle by keyword, supermarket-style:
// a jar of applesauce (store category "Applesauce", "Canned Fruit",
// plain "Grocery"…) lands in Pantry & Grocery, while baby-food
// applesauce (store category "Baby Food") lands in Baby & Kids —
// the split a real supermarket makes. Products whose category is
// missing or unrecognized also land in Pantry & Grocery, the
// dry-goods catch-all. Matching is word-level (plural-folded), so
// "tea" never fires inside "steak" and "oil" never inside "foil";
// the staple rules run before Dairy & Eggs so "peanut butter" and
// "egg noodles" land in the pantry, not with the milk and eggs.
export const AISLE_ORDER = [
  "Produce",
  "Meat & Seafood",
  "Deli & Prepared Foods",
  "Dairy & Eggs",
  "Bakery & Bread",
  "Frozen Foods",
  "Breakfast & Cereal",
  "Pantry & Grocery",
  "Snacks & Sweets",
  "Beverages",
  "Baby & Kids",
  "Health & Beauty",
  "Household & More",
  "Holiday & Seasonal",
] as const;
export const DEFAULT_AISLE = "Pantry & Grocery";

const AISLE_RULES: { aisle: string; words: string[]; phrases?: string[][] }[] = [
  { aisle: "Baby & Kids", words: ["baby", "infant", "toddler"] },
  {
    aisle: "Holiday & Seasonal",
    words: HOLIDAY_WORDS,
  },
  {
    aisle: "Pantry & Grocery",
    words: ["peanut", "pasta", "noodle", "canned", "rice", "bean", "lentil", "grain", "flour", "baking", "spice", "sauce", "soup", "oil", "vinegar", "condiment", "dressing", "jam", "jelly", "honey", "syrup", "grocery"],
  },
  {
    aisle: "Deli & Prepared Foods",
    words: ["deli", "sushi", "appetizing", "prepared", "takeout", "rotisserie", "sandwich", "dip"],
    phrases: [["take", "out"]],
  },
  {
    aisle: "Meat & Seafood",
    words: ["meat", "poultry", "fish", "seafood", "chicken", "beef", "steak", "turkey", "lamb", "veal", "salmon"],
  },
  { aisle: "Frozen Foods", words: ["frozen"], phrases: [["ice", "cream"]] },
  {
    aisle: "Dairy & Eggs",
    words: ["dairy", "milk", "egg", "cheese", "yogurt", "butter", "cream"],
  },
  {
    aisle: "Bakery & Bread",
    words: ["bakery", "bread", "bagel", "challah", "pita", "cake", "pastry", "muffin", "bun", "roll", "tortilla", "wrap"],
  },
  {
    aisle: "Produce",
    words: ["produce", "fruit", "vegetable", "salad", "potato"],
  },
  {
    aisle: "Breakfast & Cereal",
    words: ["cereal", "breakfast", "oatmeal", "granola", "pancake"],
  },
  {
    aisle: "Snacks & Sweets",
    words: ["snack", "chip", "candy", "cookie", "cracker", "pretzel", "popcorn", "chocolate", "nut", "sweet", "gum", "marshmallow"],
  },
  {
    aisle: "Beverages",
    words: ["beverage", "drink", "juice", "soda", "coffee", "tea", "wine", "beer", "liquor", "seltzer", "water"],
  },
  {
    aisle: "Health & Beauty",
    words: ["health", "beauty", "vitamin", "personal", "pharmacy", "medicine"],
  },
  {
    aisle: "Household & More",
    words: ["household", "houseware", "cleaning", "laundry", "paper", "disposable", "toy", "craft", "storage"],
  },
];

/** True when the folded phrase appears as consecutive tokens. */
export function hasPhrase(tokens: string[], phrase: string[]): boolean {
  const folded = phrase.map(foldWord);
  for (let j = 0; j + folded.length <= tokens.length; j++) {
    if (folded.every((w, k) => tokens[j + k] === w)) return true;
  }
  return false;
}

/** The supermarket aisle a raw store category belongs to. */
export function aisleForCategory(category: string | null): string {
  if (!category) return DEFAULT_AISLE;
  const tokens = normalizeName(category).split(" ").filter(Boolean).map(foldWord);
  if (tokens.length === 0) return DEFAULT_AISLE;
  const tokenSet = new Set(tokens);
  for (const rule of AISLE_RULES) {
    if (rule.words.some((w) => tokenSet.has(foldWord(w)))) return rule.aisle;
    if (rule.phrases?.some((phrase) => hasPhrase(tokens, phrase))) {
      return rule.aisle;
    }
  }
  return DEFAULT_AISLE;
}
/**
 * The weight a list line asks for, in pounds, when it states one
 * ("2 lb", "1/2 lb", "16 oz", "1 kg"). Null when the line gives no
 * weight (counts, cups, or nothing) — cups of chicken aren't pounds.
 */
export function quantityToPounds(quantityText: string | null): number | null {
  if (!quantityText) return null;
  const t = quantityText.toLowerCase();
  const frac = t.match(/(\d+)\s*\/\s*(\d+)\s*(lbs?|oz|ounces?|kg|g)\b/);
  const dec = t.match(/(\d+(?:\.\d+)?)\s*(lbs?|oz|ounces?|kg|g)\b/);
  let qty: number | null = null;
  let unit = "";
  if (frac) {
    qty = Number(frac[1]) / Number(frac[2]);
    unit = frac[3] ?? "";
  } else if (dec) {
    qty = Number(dec[1]);
    unit = dec[2] ?? "";
  }
  if (qty == null || !Number.isFinite(qty) || qty <= 0) return null;
  if (unit === "oz" || unit.startsWith("ounce")) return qty / 16;
  if (unit === "kg") return qty * 2.20462;
  if (unit === "g") return qty / 453.592;
  return qty;
}

/**
 * What one list line costs at one store for the amount requested.
 * Per-pound products (meat, chicken) price by the pound: cost is the
 * per-lb price times the pounds asked for — never the bare per-lb
 * price standing in for the whole line. Packaged products asked for
 * by weight cost whole packages enough to cover that weight, from
 * the package size behind the product's per-unit price.
 */
export function listLineCost(
  product: Product | null,
  quantityText: string | null,
): number | null {
  if (!product) return null;
  const lbs = quantityToPounds(quantityText);
  if (product.priceBasis === "per_lb") {
    return roundMoney(product.price * (lbs ?? 1));
  }
  if (product.priceBasis === "per_oz") {
    return roundMoney(product.price * (lbs ?? 1) * 16);
  }
  if (lbs != null) {
    // Packaged product, weight requested: whole packages to cover it.
    if (product.unitPrice != null && product.unitPrice > 0 && product.unitFamily === "oz") {
      const packageOz = product.price / product.unitPrice;
      if (packageOz > 0) {
        const packages = Math.max(1, Math.ceil((lbs * 16) / packageOz - 1e-9));
        return roundMoney(product.price * packages);
      }
    }
    return null;
  }
  return roundMoney(product.price);
}
