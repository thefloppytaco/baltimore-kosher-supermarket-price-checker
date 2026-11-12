// Unit tests for the pure matching/pricing functions in lib.ts.
// Run with `bun test` from the space root. These pin the rules that
// production bugs have violated before: bundle totals shown as
// single-item prices, per-pound prices compared against package
// prices, an oatmeal standing in for eggs, and kinds paired across
// stores that are not the same product.

import { describe, expect, test } from "bun:test";
import {
  aisleForCategory,
  listLineCost,
  pairMatchTwo,
  pairProducts,
  parseDealText,
  parseSize,
  pickBest,
  priceBasisOf,
  scoreMatch,
  verdictFor,
  withUnit,
  type Product,
} from "./lib";

/** Build a product the way the catalog does: through withUnit. */
function mk(
  name: string,
  price: number,
  extra: Partial<Product> = {},
): Product {
  return withUnit({
    name,
    price,
    sizeText: null,
    priceText: null,
    onSale: false,
    dealText: null,
    dealQty: null,
    dealTotal: null,
    regularPrice: null,
    imageUrl: null,
    category: null,
    ...extra,
  });
}

describe("parseSize", () => {
  test("counts and weights", () => {
    expect(parseSize("Lesher Eggs 18 Pk")).toEqual({
      qty: 18,
      family: "ct",
      label: "$/ct",
    });
    expect(parseSize("Olive Oil 16.9 Oz")?.qty).toBeCloseTo(16.9);
    expect(parseSize("Flour 5 Lb")?.qty).toBe(80); // normalized to oz
  });
  test("fractions and multipacks", () => {
    expect(parseSize("Milk 1/2 Gal")?.qty).toBe(64);
    expect(parseSize("Pringles 12×12 Oz")?.qty).toBe(144);
  });
  test("no size parses to null", () => {
    expect(parseSize("Medium Eggs")).toBeNull();
    expect(parseSize("Potato Chips")).toBeNull();
  });
});

describe("priceBasisOf", () => {
  test("per-weight wording in the price text wins", () => {
    expect(priceBasisOf("$7.99 / lb", null, "Chicken Breast")).toBe("per_lb");
    expect(priceBasisOf("$0.50 / oz", null, "Deli Turkey")).toBe("per_oz");
    expect(priceBasisOf(null, "per lb", "Chicken")).toBe("per_lb");
  });
  test("a bare package size in the name is NOT per-pound", () => {
    expect(priceBasisOf(null, null, "Family Pack Chicken 3 Lb")).toBe("each");
    expect(priceBasisOf("$9.99", null, "Chicken 24 Oz")).toBe("each");
  });
});

describe("withUnit", () => {
  test("packaged product divides price by package size", () => {
    const p = mk("Lesher Eggs, 24 Oz", 1.25);
    expect(p.priceBasis).toBe("each");
    expect(p.unitFamily).toBe("oz");
    expect(p.unitPrice).toBeCloseTo(1.25 / 24, 4);
  });
  test("per-pound price is never divided by a pack size", () => {
    const p = mk("Chicken Breast 3 Lb", 7.99, { priceText: "$7.99 / lb" });
    expect(p.priceBasis).toBe("per_lb");
    expect(p.unitPrice).toBeCloseTo(7.99 / 16, 4);
    expect(p.sizeText).toBe("1 lb");
  });
  test("sizeless product has no unit price", () => {
    const p = mk("Medium Eggs", 0.99);
    expect(p.unitPrice).toBeNull();
    expect(p.unitFamily).toBeNull();
  });
});

describe("parseDealText", () => {
  test("N for $X: the displayed price is the bundle total", () => {
    expect(parseDealText("4 for $5.00", 5)).toEqual({
      qty: 4,
      total: 5,
      text: "4 for $5.00",
    });
    expect(parseDealText("2/$5", 5)?.qty).toBe(2);
  });
  test("buy-get deals price off the single-item price", () => {
    expect(parseDealText("Buy 1, get 1 free", 3.5)).toEqual({
      qty: 2,
      total: 3.5,
      text: "Buy 1, get 1 free",
    });
    expect(parseDealText("Buy 2, get 1 free", 2)?.total).toBe(4);
    expect(parseDealText("BOGO 50% off", 4)).toEqual({
      qty: 2,
      total: 6,
      text: "BOGO 50% off",
    });
  });
  test("plain sale wording is not a deal", () => {
    expect(parseDealText(null, 5)).toBeNull();
    expect(parseDealText("Sale!", 5)).toBeNull();
    expect(parseDealText("", 5)).toBeNull();
  });
});

describe("scoreMatch", () => {
  test("word-level: 'egg' does not hit 'eggplant'", () => {
    expect(scoreMatch("egg", "Eggplant Parmesan").coverage).toBe(0);
    expect(scoreMatch("egg", "Eggplant Parmesan").score).toBe(-100);
  });
  test("the item itself beats a product that merely mentions it", () => {
    const real = scoreMatch("eggs", "Medium Eggs");
    const oatmeal = scoreMatch(
      "eggs",
      "Dinosaur Eggs Brown Sugar Instant Oatmeal 8 pk",
    );
    expect(real.coverage).toBe(1);
    expect(real.score).toBeGreaterThan(oatmeal.score);
  });
  test("a packing medium is not the product", () => {
    const bottle = scoreMatch("olive oil", "Extra Virgin Olive Oil");
    const tuna = scoreMatch("olive oil", "Fancy Solid Tuna Extra Virgin Olive Oil");
    expect(bottle.score).toBeGreaterThan(tuna.score);
    expect(bottle.purity).toBeGreaterThan(tuna.purity);
  });
  test("variants are demoted unless asked for", () => {
    expect(scoreMatch("milk", "Whole Milk").score).toBeGreaterThan(
      scoreMatch("milk", "Chocolate Milk").score,
    );
    expect(scoreMatch("chocolate milk", "Chocolate Milk").coverage).toBe(1);
  });
});

describe("pickBest", () => {
  test("an off-target product with a unit price can't win the headline", () => {
    const oatmeal = mk("Dinosaur Eggs Brown Sugar Instant Oatmeal 8 pk", 5.99);
    const eggs = mk("Medium Eggs", 0.99);
    expect(pickBest([oatmeal, eggs], "eggs")?.name).toBe("Medium Eggs");
  });
  test("lowest per-unit price wins inside the top tier", () => {
    const a = mk("Eggs 12 Ct", 1.8);
    const b = mk("Eggs 18 Ct", 1.49);
    expect(pickBest([a, b], "eggs")?.name).toBe("Eggs 18 Ct");
  });
});

describe("verdictFor", () => {
  test("per-unit verdict names the winning store from the config", () => {
    const m = { best: mk("Eggs 18 Ct", 2.7) };
    const s = { best: mk("Eggs 12 Ct", 0.99) };
    const v = verdictFor(m, s);
    expect(v.winner).toBe("seven");
    expect(v.basis).toBe("unit");
    expect(v.text).toContain("Seven Mile");
    expect(v.text).toContain("/ct");
  });
  test("weight-priced verdicts are spoken per pound", () => {
    const m = { best: mk("Chicken Breast", 7.99, { priceText: "$7.99 / lb" }) };
    const s = { best: mk("Chicken Breast 16 Oz", 9.99) };
    const v = verdictFor(m, s);
    expect(v.winner).toBe("maven");
    expect(v.text).toContain("/lb");
  });
  test("a per-pound price never faces a bare package price", () => {
    const m = { best: mk("Chicken Breast", 7.99, { priceText: "$7.99 / lb" }) };
    const s = { best: mk("Chicken Breast Family Pack", 9.99) };
    expect(verdictFor(m, s).winner).toBe("none");
  });
  test("listed-price verdict when neither side has units", () => {
    const v = verdictFor({ best: mk("Rice", 3) }, { best: mk("Rice", 2.5) });
    expect(v.winner).toBe("seven");
    expect(v.basis).toBe("price");
  });
  test("no best on a side means no verdict", () => {
    expect(verdictFor({ best: null }, { best: mk("Rice", 2) }).winner).toBe(
      "none",
    );
  });
});

describe("pairProducts / pairMatchTwo", () => {
  test("grades pair like-for-like; kinds one store lacks stay out", () => {
    const maven = [mk("Lesher Large Eggs 12 Ct", 1.69), mk("Lesher Medium Eggs 18 Pk", 1.49)];
    const seven = [mk("Large Eggs", 1.29), mk("Medium Eggs", 0.99), mk("Jumbo Eggs", 2.19)];
    const { pairs, sevenOnly } = pairProducts("eggs", maven, seven);
    expect(pairs.length).toBe(2);
    expect(sevenOnly.map((p) => p.name)).toContain("Jumbo Eggs");
  });
  test("shared kind vocabulary pairs across different naming", () => {
    const { pairs } = pairProducts(
      "chips",
      [mk("Potato Chips 8 Oz", 3.49)],
      [mk("Potato Chips", 2.99), mk("Waffle Chips", 2.49)],
    );
    expect(pairs.length).toBe(1);
    expect(pairs[0]?.maven[0]?.name).toContain("Potato");
  });
  test("a variant does not pair with the plain item", () => {
    expect(
      pairMatchTwo("milk", mk("Whole Milk 64 Oz", 4.99), mk("Chocolate Milk 64 Oz", 3.99)),
    ).toBe(false);
    expect(
      pairMatchTwo("milk", mk("Whole Milk 64 Oz", 4.99), mk("Whole Milk 1 Gal", 5.49)),
    ).toBe(true);
  });
});

describe("aisleForCategory", () => {
  test("a product-level category is not an aisle", () => {
    expect(aisleForCategory("Applesauce")).toBe("Pantry & Grocery");
    expect(aisleForCategory("Baby Food")).toBe("Baby & Kids");
    expect(aisleForCategory("Chips")).toBe("Snacks & Sweets");
    expect(aisleForCategory("Milk")).toBe("Dairy & Eggs");
  });
  test("staple rules beat the dairy words inside them", () => {
    expect(aisleForCategory("Egg Noodles")).toBe("Pantry & Grocery");
    expect(aisleForCategory("Ice Cream")).toBe("Frozen Foods");
  });
  test("holiday words come from the locale config", () => {
    expect(aisleForCategory("Chanukah")).toBe("Holiday & Seasonal");
    expect(aisleForCategory("Passover")).toBe("Holiday & Seasonal");
  });
  test("unknown and missing categories land in the catch-all", () => {
    expect(aisleForCategory(null)).toBe("Pantry & Grocery");
    expect(aisleForCategory("Wobble Widgets")).toBe("Pantry & Grocery");
  });
});

describe("listLineCost", () => {
  test("per-pound lines cost price × pounds asked for", () => {
    const chicken = mk("Chicken Breast", 5.49, { priceText: "$5.49 / lb" });
    expect(listLineCost(chicken, "2 lb")).toBe(10.98);
    expect(listLineCost(chicken, null)).toBe(5.49); // no amount → 1 lb
    expect(listLineCost(chicken, "16 oz")).toBe(5.49);
  });
  test("packaged lines asked by weight cost whole packages", () => {
    const oil = mk("Olive Oil 16 Oz", 8);
    expect(listLineCost(oil, "32 oz")).toBe(16);
    expect(listLineCost(oil, null)).toBe(8);
  });
  test("a weight a package can't answer stays out of the totals", () => {
    const rice = mk("Rice", 3); // no parseable size
    expect(listLineCost(rice, "2 lb")).toBeNull();
    expect(listLineCost(null, "2 lb")).toBeNull();
  });
});
