import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import {
  EXAMPLE_BRAND,
  LOCALE,
  STORES,
  STORE_LIST,
  SUGGESTION_CHIPS,
  type StoreConfig,
  type StoreKey,
} from "../../server/src/stores";

/** The configured store for a key (winner values included). */
function storeOf(key: string): StoreConfig {
  return STORE_LIST.find((s) => s.key === key) ?? STORES.maven;
}

/** CSS colour expression for a store ("var(--maven)"). */
function storeColor(key: string): string {
  return `var(${storeOf(key).colorVar})`;
}

/** The store the Settings accuracy spot check applies to, if any. */
const SPOT_STORE: StoreConfig | undefined = STORE_LIST.find((s) => s.spotCheck);

type Board = ApiResponse<typeof api, "getBoard">;
type Item = Board["items"][number];
type Snap = Item["maven"];
type ScanResult = ApiResponse<typeof api, "lookupBarcode">;
type ListResult = ApiResponse<typeof api, "compareList">;
type ListQuote = ListResult["items"][number]["maven"];

/** Best brand guess from a product name: the part before the size comma,
 *  else the first three words. Used by "remember this brand" — the user
 *  sees exactly what got saved in the preferences list and can remove it. */
function brandCandidate(productName: string): string {
  const beforeComma = productName.split(",")[0]?.trim() ?? productName;
  if (beforeComma !== productName.trim() && beforeComma.length >= 2) return beforeComma;
  return productName.split(/\s+/).slice(0, 3).join(" ");
}

const SUGGESTIONS = SUGGESTION_CHIPS;
// Prices live in the built-in product catalog. Specials re-check weekly
// (that's what actually changes); everything else rolls through a
// monthly re-check, so a saved price can legitimately be up to about a
// month old before the page bothers re-checking it.
const STALE_MS = 32 * 24 * 60 * 60 * 1000;

function fmtCount(n: number) {
  return n.toLocaleString(LOCALE.language);
}

function fmtPrice(n: number) {
  return `${LOCALE.currencySymbol}${n.toFixed(2)}`;
}

function fmtChecked(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleString(LOCALE.language, {
    timeZone: LOCALE.timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type BasisFields = {
  priceBasis: "each" | "per_lb" | "per_oz";
  unitPrice: number | null;
  unitLabel: string | null;
};

/** "/lb" or "/oz" when the price is a per-weight price (meat,
 *  chicken, deli) — the price buys one pound/ounce, not a package,
 *  and it is always shown that way so it can't be read as one. */
function basisSuffix(p: { priceBasis: BasisFields["priceBasis"] }): string {
  return p.priceBasis === "per_lb" ? "/lb" : p.priceBasis === "per_oz" ? "/oz" : "";
}

/** The "( $0.05/oz)"-style per-unit note for a packaged product, or
 *  null. A per-weight price IS the per-unit price already, so it
 *  never gets a second, different unit note next to it. */
function unitText(p: BasisFields): string | null {
  if (p.priceBasis !== "each") return null;
  if (p.unitPrice == null || !p.unitLabel) return null;
  return `(${fmtPrice(p.unitPrice)}${p.unitLabel.slice(1)})`;
}

/** The package size as its own note ("10 Oz") when the store shows it
 *  separately from the product name and the name doesn't already carry
 *  it. The browser store prints the size on a line above the name, so most of
 *  its products would otherwise show no size at all next to the price.
 *  Per-weight products are skipped: their "/lb" suffix already says
 *  what the price buys. */
function sizeNote(p: {
  name: string;
  sizeText: string | null;
  priceBasis: BasisFields["priceBasis"];
}): string | null {
  if (p.priceBasis !== "each") return null;
  const s = p.sizeText?.trim();
  if (!s) return null;
  const num = s.match(/\d+(?:\.\d+)?/)?.[0];
  if (num && p.name.includes(num)) return null;
  return s;
}

/** Multi-buy deal badge: when a product's price is a per-item deal
 *  price, the deal itself ("4 for $5.00") is stated right next to it —
 *  plus the regular single-item price when the store shows one — so a
 *  bundle total is never mistaken for one item's price. */
function DealBadge({
  p,
}: {
  p: { dealText: string | null; regularPrice: number | null };
}) {
  if (!p.dealText) return null;
  return (
    <span className="rounded-sm border border-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[var(--sale)]">
      {p.dealText}
      {p.regularPrice != null ? ` · reg ${fmtPrice(p.regularPrice)}` : ""}
    </span>
  );
}

function isStale(snap: Snap) {
  if (snap.status === "none" || snap.status === "error") return true;
  if (!snap.checkedAt) return true;
  return Date.now() - new Date(snap.checkedAt).getTime() > STALE_MS;
}

function StoreBlock({
  label,
  colorVar,
  snap,
  isWinner,
  storeUrl,
}: {
  label: string;
  colorVar: string;
  snap: Snap;
  isWinner: boolean;
  storeUrl: string;
}) {
  const best = snap.best;
  const others = snap.products.filter((p) => p !== best).slice(0, 3);
  return (
    <div className="min-w-0 flex-1 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <a
          href={storeUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-bold uppercase tracking-wider underline-offset-2 hover:underline"
          style={{ color: `var(${colorVar})` }}
        >
          {label}
        </a>
        {snap.status === "ok" && snap.checkedAt && (
          <span className="shrink-0 text-[11px] text-[var(--dim)]">
            Checked {fmtChecked(snap.checkedAt)}
          </span>
        )}
      </div>

      {snap.status === "pending" && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--sale)] align-middle" />
          Checking prices…
        </p>
      )}
      {snap.status === "none" && (
        <p className="mt-3 text-sm text-[var(--dim)]">Not checked yet.</p>
      )}
      {snap.status === "error" && (
        <p className="mt-3 text-sm text-[var(--lose)]">
          Couldn’t check{snap.error ? ` — ${snap.error}` : ""}. Last saved prices shown below if any.
        </p>
      )}

      {best && (
        <div className="mt-2">
          <div className="flex items-start gap-3">
            {best.imageUrl && (
              <img
                src={best.imageUrl}
                alt=""
                className="h-14 w-14 shrink-0 rounded-md border border-[var(--border)] object-cover"
                loading="lazy"
              />
            )}
            <div className="min-w-0">
              <p className="text-sm leading-snug text-[var(--text)]">{best.name}</p>
              {sizeNote(best) && (
                <p className="mt-0.5 text-xs font-semibold text-[var(--text)]">
                  {sizeNote(best)}
                </p>
              )}
              {best.category && (
                <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--dim)]">
                  {best.category}
                </p>
              )}
              <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span
                  className={`font-ledger text-3xl leading-none ${isWinner ? "" : "text-[var(--dim)]"}`}
                  style={isWinner ? { color: `var(${colorVar})` } : undefined}
                >
                  {fmtPrice(best.price)}
                  {basisSuffix(best)}
                </span>
                {unitText(best) && (
                  <span className="text-sm text-[var(--dim)]">{unitText(best)}</span>
                )}
                {best.onSale && (
                  <span className="rounded-sm bg-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                    On special
                  </span>
                )}
                <DealBadge p={best} />
              </p>
              {best.priceBasis !== "each" && (
                <p className="mt-1 text-xs text-[var(--dim)]">
                  Priced by weight — that’s the price{" "}
                  {best.priceBasis === "per_lb" ? "per pound" : "per ounce"}
                </p>
              )}
              {best.dealText && (
                <p className="mt-1 text-xs text-[var(--dim)]">Per-item price with the deal</p>
              )}
            </div>
          </div>
          {others.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-dashed border-[var(--border)] pt-2">
              {others.map((p, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-[var(--dim)]">
                    {p.name}
                    {sizeNote(p) ? ` · ${sizeNote(p)}` : ""}
                    {p.category ? ` · ${p.category}` : ""}
                  </span>
                  <span className="font-ledger shrink-0 text-[var(--text)]">
                    {fmtPrice(p.price)}
                    {basisSuffix(p)}
                    {p.dealText && (
                      <span className="ml-1 font-sans text-[11px] font-bold uppercase text-[var(--sale)]">
                        {p.dealText}
                      </span>
                    )}
                    {p.onSale && <span className="ml-1 text-[11px] font-sans font-bold uppercase text-[var(--sale)]">sale</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {snap.status === "ok" && !best && (
        <p className="mt-3 text-sm text-[var(--dim)]">No matching products found.</p>
      )}
    </div>
  );
}

function ListQuoteBlock({
  label,
  colorVar,
  quote,
  isWinner,
  ingredient,
  quantityText,
  onRememberBrand,
  rememberPending,
}: {
  label: string;
  colorVar: string;
  quote: ListQuote;
  isWinner: boolean;
  ingredient: string;
  quantityText: string | null;
  onRememberBrand: (keyword: string, brand: string) => void;
  rememberPending: boolean;
}) {
  const p = quote.product;
  return (
    <div className="min-w-0 flex-1 px-4 py-3">
      <p
        className="text-xs font-bold uppercase tracking-wider"
        style={{ color: `var(${colorVar})` }}
      >
        {label}
        {quote.checkedAt && (
          <span className="ml-2 font-normal normal-case tracking-normal text-[var(--dim)]">
            Checked {fmtChecked(quote.checkedAt)}
          </span>
        )}
      </p>
      {quote.status === "pending" && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--sale)] align-middle" />
          Not in the database yet — {STORES.seven.name} indexing is queued for this item and the
          price fills in on its own.
        </p>
      )}
      {quote.status !== "pending" && !p && (
        <p className="mt-2 text-sm text-[var(--dim)]">No matching product found.</p>
      )}
      {p && (
        <div className="mt-1.5">
          <p className="text-sm leading-snug text-[var(--text)]">{p.name}</p>
          {sizeNote(p) && (
            <p className="mt-0.5 text-xs font-semibold text-[var(--text)]">
              {sizeNote(p)}
            </p>
          )}
          {p.category && (
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--dim)]">
              {p.category}
            </p>
          )}
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span
              className={`font-ledger text-2xl leading-none ${isWinner ? "" : "text-[var(--dim)]"}`}
              style={isWinner ? { color: `var(${colorVar})` } : undefined}
            >
              {fmtPrice(p.price)}
              {basisSuffix(p)}
            </span>
            {unitText(p) && (
              <span className="text-[13px] text-[var(--dim)]">{unitText(p)}</span>
            )}
            {p.onSale && (
              <span className="rounded-sm bg-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                On special
              </span>
            )}
            <DealBadge p={p} />
          </p>
          {p.priceBasis !== "each" && (
            <p className="mt-1 text-xs text-[var(--dim)]">
              Priced by weight — that’s the price{" "}
              {p.priceBasis === "per_lb" ? "per pound" : "per ounce"}
            </p>
          )}
          {quote.cost != null && Math.abs(quote.cost - p.price) > 0.005 && (
            <p className="mt-1 text-[13px] font-semibold text-[var(--text)]">
              ≈ {fmtPrice(quote.cost)}
              {quantityText ? ` for ${quantityText}` : ""} — counted in the totals
              at that amount
            </p>
          )}
          {quote.preferenceApplied && (
            <p className="mt-1.5 text-[13px] font-semibold text-[var(--accent)]">
              Your preferred brand{quote.preferenceBrand ? ` — ${quote.preferenceBrand}` : ""}
              {quote.cheapestAltPrice != null && p.price > quote.cheapestAltPrice && (
                <span className="font-normal text-[var(--dim)]">
                  {" "}
                  · cheapest alternative {quote.cheapestAltName} at{" "}
                  {fmtPrice(quote.cheapestAltPrice)} (+
                  {fmtPrice(p.price - quote.cheapestAltPrice)} for your brand)
                </span>
              )}
            </p>
          )}
          {!quote.preferenceApplied && quote.preferenceMissing && (
            <p className="mt-1.5 text-[13px] text-[var(--dim)]">
              Your preferred brand ({quote.preferenceMissing}) isn’t carried here that we
              can find — quoted the best regular match instead.
            </p>
          )}
          {!quote.preferenceApplied && (
            <button
              type="button"
              disabled={rememberPending}
              onClick={() => onRememberBrand(ingredient, brandCandidate(p.name))}
              className="mt-1.5 rounded px-1 py-0.5 text-xs font-semibold text-[var(--accent)] disabled:opacity-50"
              aria-label={`Remember the brand of ${p.name} as my preference for ${ingredient}`}
            >
              Remember this brand for {ingredient}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type BoardProduct = Item["maven"]["products"][number];
type PairT = Item["pairs"][number];
type AddArgs = {
  store: StoreKey;
  name: string;
  price: number;
  category: string | null;
};
const SHOP_PAGE = 40;

function AddToListButton({
  productName,
  storeLabel,
  onClick,
  disabled,
}: {
  productName: string;
  storeLabel: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface-alt)] px-2 py-1 text-xs font-semibold text-[var(--text)] disabled:opacity-50"
      aria-label={`Add ${productName} from ${storeLabel} to my shopping list`}
    >
      + List
    </button>
  );
}

function PairSide({
  shortLabel,
  storeLabel,
  colorVar,
  store,
  product,
  more,
  isWinner,
  onAdd,
  adding,
}: {
  shortLabel: string;
  storeLabel: string;
  colorVar: string;
  store: StoreKey;
  product: BoardProduct;
  more: number;
  isWinner: boolean;
  onAdd: (a: AddArgs) => void;
  adding: boolean;
}) {
  return (
    <div className="min-w-0 px-4 py-2.5">
      <p
        className="text-[11px] font-bold uppercase tracking-wider"
        style={{ color: `var(${colorVar})` }}
      >
        {shortLabel}
      </p>
      <div className="mt-0.5 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug text-[var(--text)]">{product.name}</p>
          {sizeNote(product) && (
            <p className="mt-0.5 text-xs font-semibold text-[var(--text)]">
              {sizeNote(product)}
            </p>
          )}
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span
              className={`font-ledger text-xl leading-none ${isWinner ? "" : "text-[var(--dim)]"}`}
              style={isWinner ? { color: `var(${colorVar})` } : undefined}
            >
              {fmtPrice(product.price)}
              {basisSuffix(product)}
            </span>
            {unitText(product) && (
              <span className="text-xs text-[var(--dim)]">{unitText(product)}</span>
            )}
            {product.onSale && (
              <span className="rounded-sm bg-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                On special
              </span>
            )}
            <DealBadge p={product} />
            {more > 0 && (
              <span className="text-xs text-[var(--dim)]">
                +{more} more at this store
              </span>
            )}
          </p>
        </div>
        <AddToListButton
          productName={product.name}
          storeLabel={storeLabel}
          disabled={adding}
          onClick={() =>
            onAdd({
              store,
              name: product.name,
              price: product.price,
              category: product.category,
            })
          }
        />
      </div>
    </div>
  );
}

function PairRow({
  pair,
  onAdd,
  adding,
}: {
  pair: PairT;
  onAdd: (a: AddArgs) => void;
  adding: boolean;
}) {
  const w = pair.winner;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2">
      <PairSide
        shortLabel={STORES.maven.short}
        storeLabel={STORES.maven.name}
        colorVar={STORES.maven.colorVar}
        store="maven"
        product={pair.maven}
        more={pair.mavenMore}
        isWinner={w === "maven"}
        onAdd={onAdd}
        adding={adding}
      />
      <PairSide
        shortLabel={STORES.seven.short}
        storeLabel={STORES.seven.name}
        colorVar={STORES.seven.colorVar}
        store="seven"
        product={pair.seven}
        more={pair.sevenMore}
        isWinner={w === "seven"}
        onAdd={onAdd}
        adding={adding}
      />
    </div>
  );
}

function FinderSide({
  label,
  colorVar,
  store,
  products,
  isWinnerPair,
  onAdd,
  adding,
}: {
  label: string;
  colorVar: string;
  store: StoreKey;
  products: BoardProduct[];
  isWinnerPair: boolean;
  onAdd: (a: AddArgs) => void;
  adding: boolean;
}) {
  const rep = products[0];
  const rest = products.slice(1);
  if (!rep) {
    return (
      <div className="min-w-0 flex-1 px-4 py-3">
        <p
          className="text-xs font-bold uppercase tracking-wider"
          style={{ color: `var(${colorVar})` }}
        >
          {label}
        </p>
        <p className="mt-2 text-sm text-[var(--dim)]">Not carried.</p>
      </div>
    );
  }
  return (
    <div className="min-w-0 flex-1 px-4 py-3">
      <p
        className="text-xs font-bold uppercase tracking-wider"
        style={{ color: `var(${colorVar})` }}
      >
        {label}
      </p>
      <div className="mt-1.5 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-[var(--text)]">{rep.name}</p>
          {sizeNote(rep) && (
            <p className="mt-0.5 text-xs font-semibold text-[var(--text)]">
              {sizeNote(rep)}
            </p>
          )}
          {rep.category && (
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--dim)]">
              {rep.category}
            </p>
          )}
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span
              className={`font-ledger text-2xl leading-none ${isWinnerPair ? "" : "text-[var(--dim)]"}`}
              style={isWinnerPair ? { color: `var(${colorVar})` } : undefined}
            >
              {fmtPrice(rep.price)}
              {basisSuffix(rep)}
            </span>
            {unitText(rep) && (
              <span className="text-[13px] text-[var(--dim)]">{unitText(rep)}</span>
            )}
            {rep.onSale && (
              <span className="rounded-sm bg-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                On special
              </span>
            )}
            <DealBadge p={rep} />
          </p>
        </div>
        <AddToListButton
          productName={rep.name}
          storeLabel={label}
          disabled={adding}
          onClick={() =>
            onAdd({ store, name: rep.name, price: rep.price, category: rep.category })
          }
        />
      </div>
      {rest.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-t border-dashed border-[var(--border)] pt-2">
          {rest.map((p, i) => (
            <li key={i} className="flex items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-[var(--dim)]">
                {p.name}
                {sizeNote(p) ? ` · ${sizeNote(p)}` : ""}
              </span>
              {p.dealText && (
                <span className="shrink-0 text-[11px] font-bold uppercase text-[var(--sale)]">
                  {p.dealText}
                </span>
              )}
              <span className="font-ledger shrink-0 text-[var(--text)]">
                {fmtPrice(p.price)}
                {basisSuffix(p)}
              </span>
              <AddToListButton
                productName={p.name}
                storeLabel={label}
                disabled={adding}
                onClick={() =>
                  onAdd({ store, name: p.name, price: p.price, category: p.category })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type StoreScope = "both" | StoreKey;

/** The three-way store picker used by the Specials and What's new
 *  views: either store, or both together. */
function StoreScopeToggle({
  value,
  onChange,
  ariaLabel,
}: {
  value: StoreScope;
  onChange: (v: StoreScope) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="flex overflow-hidden rounded-md border border-[var(--border)]"
      role="group"
      aria-label={ariaLabel}
    >
      {(
        [
          ...STORE_LIST.map((s) => ({ key: s.key as StoreScope, label: s.name })),
          { key: "both" as StoreScope, label: "Both" },
        ]
      ).map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          aria-pressed={value === opt.key}
          className={`px-3 py-2 text-sm font-semibold ${
            value === opt.key
              ? "bg-[var(--accent)] text-white"
              : "bg-[var(--surface)] text-[var(--text)]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

type DealProduct = Board["specials"][number];

/** One row in the Specials / What's new lists: store badge, the
 *  product exactly as that store lists it, its price, and a + List
 *  button so a special can go straight onto the shopping list. */
function DealRow({
  p,
  onAdd,
  adding,
}: {
  p: DealProduct;
  onAdd: (a: AddArgs) => void;
  adding: boolean;
}) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      {p.imageUrl && (
        <img
          src={p.imageUrl}
          alt=""
          className="h-11 w-11 shrink-0 rounded-md border border-[var(--border)] object-cover"
          loading="lazy"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-[var(--text)]">{p.name}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-sm px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white"
            style={{
              backgroundColor: storeColor(p.store),
            }}
          >
            {STORES[p.store].short}
          </span>
          {p.onSale && (
            <span className="rounded-sm bg-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
              On special
            </span>
          )}
          <DealBadge p={p} />
          {sizeNote(p) && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text)]">
              {sizeNote(p)}
            </span>
          )}
          {p.category && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--dim)]">
              {p.category}
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-ledger text-lg leading-none text-[var(--text)]">
          {fmtPrice(p.price)}
          {basisSuffix(p)}
          {unitText(p) && (
            <span className="ml-1 font-sans text-xs text-[var(--dim)]">
              {unitText(p)}
            </span>
          )}
        </span>
        {p.priceBasis !== "each" && (
          <span className="text-[11px] text-[var(--dim)]">
            priced {p.priceBasis === "per_lb" ? "per pound" : "per ounce"}
          </span>
        )}
        {p.dealText && (
          <span className="text-[11px] text-[var(--dim)]">per item with the deal</span>
        )}
        <AddToListButton
          productName={p.name}
          storeLabel={STORES[p.store].name}
          disabled={adding}
          onClick={() =>
            onAdd({ store: p.store, name: p.name, price: p.price, category: p.category })
          }
        />
      </div>
    </li>
  );
}

/** Each store's own flyer / specials page, from the store config
 *  (stores.ts). The addresses are stable while their content rotates
 *  with the current sale cycle; the stores run more specials than any
 *  flyer shows, so these sit alongside the full on-special list, not
 *  instead of it. See DESIGN.md for how each flyer address was
 *  verified and why one store links its specials page instead of a
 *  rotating flyer PDF. */
const FLYER_LINKS = {
  maven: { label: STORES.maven.flyerLabel, url: STORES.maven.flyerUrl },
  seven: { label: STORES.seven.flyerLabel, url: STORES.seven.flyerUrl },
} as const;

export function App() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const autoRefreshSig = useRef<string>("");

  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
    refetchInterval: (query) => {
      const data = query.state.data as Board | undefined;
      const pending = data?.items.some(
        (i) => i.maven.status === "pending" || i.seven.status === "pending",
      );
      return pending ? 15000 : false;
    },
  });

  const refreshAll = useMutation({
    mutationFn: async () => await api.refreshAll({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });
  const syncCatalog = useMutation({
    mutationFn: async () => await api.syncCatalog({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });
  const spotCheck = useMutation({
    mutationFn: async () => await api.spotCheckMaven({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });
  const refreshItem = useMutation({
    mutationFn: async (id: number) => await api.refreshItem({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });
  const addItem = useMutation({
    mutationFn: async (q: string) => await api.addWatchItem({ query: q }),
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
  const removeItem = useMutation({
    mutationFn: async (id: number) => await api.removeWatchItem({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });

  // ---- Views (main / settings / finder / shop / specials / new) + shopping list ----
  const [view, setView] = useState<
    "main" | "settings" | "shop" | "finder" | "specials" | "new"
  >("main");
  // Which store(s) the Specials and What's new views are showing.
  const [specialsStore, setSpecialsStore] = useState<StoreScope>("both");
  const [newStore, setNewStore] = useState<StoreScope>("both");
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  const cart = useQuery({
    queryKey: ["cart"],
    queryFn: () => api.getCart({}),
  });
  // Why the last "+ List" tap was refused, if it was (the server only
  // adds products at prices from its own catalog — a product it
  // doesn't know is refused, never priced from the tap).
  const [addError, setAddError] = useState<string | null>(null);
  const addToCart = useMutation({
    mutationFn: async (a: AddArgs) => await api.addToCart(a),
    onSuccess: (r) => {
      if (r.ok) {
        setAddError(null);
        queryClient.invalidateQueries({ queryKey: ["cart"] });
      } else {
        setAddError(r.error ?? "That product couldn't be added.");
      }
    },
  });
  const onAddToList = (a: AddArgs) => addToCart.mutate(a);
  const setCartQty = useMutation({
    mutationFn: async (args: { id: number; qty: number }) => await api.setCartQty(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cart"] }),
  });
  const removeCartItemM = useMutation({
    mutationFn: async (id: number) => await api.removeCartItem({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cart"] }),
  });
  const clearCart = useMutation({
    mutationFn: async () => await api.clearCart({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cart"] }),
  });

  // ---- Product finder ----
  const [finderQuery, setFinderQuery] = useState("");
  const [finderDraft, setFinderDraft] = useState("");
  const finder = useQuery({
    queryKey: ["finder", finderQuery],
    queryFn: () => api.searchProducts({ query: finderQuery }),
    enabled: view === "finder" && finderQuery.trim().length >= 2,
  });
  const openFinder = (q: string) => {
    setFinderQuery(q);
    setFinderDraft(q);
    setView("finder");
  };
  const onFinderSearch = (e: FormEvent) => {
    e.preventDefault();
    if (finderDraft.trim().length >= 2) setFinderQuery(finderDraft.trim());
  };

  // ---- Shop ----
  const [shopStore, setShopStore] = useState<StoreKey | null>(null);
  const [shopCategory, setShopCategory] = useState<string | null>(null);
  const [shopCategorySel, setShopCategorySel] = useState("");
  const [shopQuery, setShopQuery] = useState<string | null>(null);
  const [shopDraft, setShopDraft] = useState("");
  const [shopOffset, setShopOffset] = useState(0);
  const browse = useQuery({
    queryKey: ["browse", shopStore, shopCategory, shopQuery, shopOffset],
    queryFn: () =>
      api.browseCatalog({
        store: shopStore,
        category: shopCategory,
        query: shopQuery,
        offset: shopOffset,
        limit: SHOP_PAGE,
      }),
    enabled: view === "shop",
  });
  const onShopSearch = (e: FormEvent) => {
    e.preventDefault();
    if (shopDraft.trim().length >= 2) {
      setShopQuery(shopDraft.trim());
      setShopOffset(0);
    }
  };
  const onShopCategory = (value: string) => {
    setShopCategorySel(value);
    setShopOffset(0);
    // Aisles are shared by both stores now — picking one no longer
    // picks a store. The store buttons next to it decide whose
    // products in the aisle you see.
    setShopCategory(value || null);
  };

  // ---- List / recipe compare + brand preferences ----
  const [listText, setListText] = useState("");
  const [prefKeyword, setPrefKeyword] = useState("");
  const [prefBrand, setPrefBrand] = useState("");
  const compareList = useMutation({
    mutationFn: async (text: string) => await api.compareList({ text }),
  });
  const brandPrefs = useQuery({
    queryKey: ["brandPreferences"],
    queryFn: () => api.listBrandPreferences({}),
  });
  const savePref = useMutation({
    mutationFn: async (args: { keyword: string; brand: string }) =>
      await api.saveBrandPreference(args),
    onSuccess: () => {
      setPrefKeyword("");
      setPrefBrand("");
      queryClient.invalidateQueries({ queryKey: ["brandPreferences"] });
    },
  });
  const removePref = useMutation({
    mutationFn: async (id: number) => await api.removeBrandPreference({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["brandPreferences"] }),
  });
  const listResult = compareList.data ?? null;

  const onCompareList = (e: FormEvent) => {
    e.preventDefault();
    if (listText.trim().length >= 2) compareList.mutate(listText.trim());
  };
  const onSavePref = (e: FormEvent) => {
    e.preventDefault();
    if (prefKeyword.trim().length >= 2 && prefBrand.trim().length >= 2) {
      savePref.mutate({ keyword: prefKeyword.trim(), brand: prefBrand.trim() });
    }
  };

  // ---- Barcode scan ----
  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [linkName, setLinkName] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<{ reset: () => void } | null>(null);

  const recentScans = useQuery({
    queryKey: ["recentScans"],
    queryFn: () => api.listRecentScans({}),
  });

  const lookupBarcode = useMutation({
    mutationFn: async (code: string) => await api.lookupBarcode({ barcode: code }),
    onSuccess: (r) => {
      setScanResult(r);
      queryClient.invalidateQueries({ queryKey: ["recentScans"] });
      queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
  const linkBarcode = useMutation({
    mutationFn: async (args: { barcode: string; productName: string }) =>
      await api.linkBarcode(args),
    onSuccess: (r) => {
      setScanResult(r);
      setLinkName("");
      queryClient.invalidateQueries({ queryKey: ["recentScans"] });
      queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });

  const stopScanner = () => {
    try {
      readerRef.current?.reset();
    } catch {
      // Reader already stopped.
    }
    readerRef.current = null;
    setScanning(false);
  };

  const startScanner = async () => {
    setScanError(null);
    setScanOpen(true);
    setScanning(true);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/library");
      // Let the <video> element mount before handing it to the reader.
      await new Promise((r) => setTimeout(r, 60));
      const video = videoRef.current;
      if (!video) throw new Error("no video element");
      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;
      await reader.decodeFromVideoDevice(null, video, (result) => {
        if (result) {
          const text = result.getText();
          stopScanner();
          setScanOpen(false);
          lookupBarcode.mutate(text);
        }
      });
    } catch {
      stopScanner();
      setScanError(
        "Couldn't start the camera — check the camera permission, or type the barcode number in below / upload a photo of it instead.",
      );
    }
  };

  // Stop the camera if the component unmounts mid-scan.
  useEffect(() => {
    return () => {
      try {
        readerRef.current?.reset();
      } catch {
        // Already stopped.
      }
    };
  }, []);

  const decodePhoto = async (file: File) => {
    setScanError(null);
    const url = URL.createObjectURL(file);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/library");
      const reader = new BrowserMultiFormatReader();
      const result = await reader.decodeFromImageUrl(url);
      lookupBarcode.mutate(result.getText());
    } catch {
      setScanError(
        "No barcode could be read in that photo — try a closer, sharper shot, or type the number in.",
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const onManualLookup = (e: FormEvent) => {
    e.preventDefault();
    const code = manualCode.replace(/\D/g, "");
    if (code.length >= 6) {
      setScanError(null);
      lookupBarcode.mutate(code);
    }
  };

  const onLinkSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (scanResult && linkName.trim().length >= 2) {
      linkBarcode.mutate({ barcode: scanResult.barcode, productName: linkName.trim() });
    }
  };

  const items = board.data?.items ?? [];
  const catalog = board.data?.catalog;
  const specials = board.data?.specials ?? [];
  const newProducts = board.data?.newProducts ?? [];
  const spot = board.data?.spotCheck ?? null;

  // Run the first accuracy spot check on its own if none has ever
  // run — later checks are a tap away in the database panel.
  const autoSpotDone = useRef(false);
  useEffect(() => {
    if (!board.data || autoSpotDone.current) return;
    if (board.data.spotCheck === null && board.data.catalog.maven.count > 0) {
      autoSpotDone.current = true;
      spotCheck.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.data]);

  // Build the product database on first open if it isn't there yet —
  // the API store crawls in under a minute; the browser store's
  // indexing then continues in the background on its own.
  const autoSyncDone = useRef(false);
  useEffect(() => {
    if (!board.data || autoSyncDone.current) return;
    if (board.data.catalog.maven.count === 0 && board.data.catalog.maven.status !== "running") {
      autoSyncDone.current = true;
      syncCatalog.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.data]);

  // Auto-refresh on open: if anything is stale or unchecked, kick one
  // refresh per distinct board state — no clicks needed.
  useEffect(() => {
    if (!board.data) return;
    const stale = items.some((i) => isStale(i.maven) || isStale(i.seven));
    const anyPending = items.some(
      (i) => i.maven.status === "pending" || i.seven.status === "pending",
    );
    const sig = items
      .map((i) => `${i.id}:${i.maven.checkedAt ?? ""}:${i.seven.checkedAt ?? ""}:${i.maven.status}:${i.seven.status}`)
      .join("|");
    if (stale && !anyPending && items.length > 0 && autoRefreshSig.current !== sig) {
      autoRefreshSig.current = sig;
      refreshAll.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.data]);

  const mavenWins = items.filter((i) => i.verdict.winner === "maven").length;
  const sevenWins = items.filter((i) => i.verdict.winner === "seven").length;
  const ties = items.filter((i) => i.verdict.winner === "tie").length;
  const anyPending = items.some(
    (i) => i.maven.status === "pending" || i.seven.status === "pending",
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    if (q) addItem.mutate(q);
  };

  if (view === "settings") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-3xl px-4 pb-10">
          <section className="pt-5">
            <button
              type="button"
              onClick={() => setView("main")}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)]"
              aria-label="Back to prices"
            >
              ← Back to prices
            </button>
            <h2 className="font-ledger mt-3 text-2xl">Settings</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              What the page remembers for you — the brands you prefer — and the technical
              side: the product database both stores are priced from, keeping it synced
              and verified, and refreshing your watchlist.
            </p>
          </section>

          <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-[var(--text)]">Refresh the watchlist</h3>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Re-price every item on your watchlist from the product database right
                  now, instead of waiting for the next automatic check.
                </p>
              </div>
              <button
                type="button"
                onClick={() => refreshAll.mutate()}
                disabled={refreshAll.isPending}
                className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                aria-label="Refresh all prices now"
              >
                {refreshAll.isPending ? "Refreshing\u2026" : "Refresh all"}
              </button>
            </div>
          </section>

          {/* Brand preferences — saved information, so it lives here in
              Settings. List/recipe pricing reads these on every run. */}
          <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="text-sm font-semibold text-[var(--text)]">Brands you prefer</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">
              When a list or recipe includes the item, that brand is quoted at each store
              that carries it — even when another brand is cheaper — and the quote shows
              what the preference costs.
            </p>
            {brandPrefs.data && brandPrefs.data.preferences.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {brandPrefs.data.preferences.map((pref) => (
                  <li
                    key={pref.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 text-[var(--text)]">
                      <span className="capitalize">{pref.keyword}</span>
                      <span className="mx-1.5 text-[var(--dim)]">→</span>
                      {pref.brand}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePref.mutate(pref.id)}
                      disabled={removePref.isPending}
                      className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-[var(--lose)] disabled:opacity-50"
                      aria-label={`Remove preference for ${pref.brand} on ${pref.keyword}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-[var(--dim)]">
                None saved yet — add one below, or use “Remember this brand” on any quote.
              </p>
            )}
            <form onSubmit={onSavePref} className="mt-3 flex flex-col gap-2 sm:flex-row">
              <label htmlFor="pref-keyword" className="sr-only">
                Item the preference is for
              </label>
              <input
                id="pref-keyword"
                value={prefKeyword}
                onChange={(e) => setPrefKeyword(e.target.value)}
                placeholder="For item… e.g. Milk"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
              />
              <label htmlFor="pref-brand" className="sr-only">
                Preferred brand
              </label>
              <input
                id="pref-brand"
                value={prefBrand}
                onChange={(e) => setPrefBrand(e.target.value)}
                placeholder={`I prefer… e.g. ${EXAMPLE_BRAND}`}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
              />
              <button
                type="submit"
                disabled={
                  savePref.isPending ||
                  prefKeyword.trim().length < 2 ||
                  prefBrand.trim().length < 2
                }
                className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-50"
                aria-label="Save brand preference"
              >
                {savePref.isPending ? "Saving…" : "Save preference"}
              </button>
            </form>
            {savePref.isError && (
              <p className="mt-2 text-sm text-[var(--lose)]">
                Couldn’t save that preference — try again.
              </p>
            )}
          </section>

        {!catalog && (
          <p className="mt-4 text-sm text-[var(--dim)]">
            Loading the product database status…
          </p>
        )}

        {/* Product database status */}
        {catalog && (
          <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--text)]">
                  Product database
                </h2>
                <ul className="mt-2 space-y-1 text-sm text-[var(--dim)]">
                  <li>
                    <span className="font-semibold" style={{ color: storeColor("maven") }}>
                      {STORES.maven.name}
                    </span>{" "}
                    —{" "}
                    {catalog.maven.status === "running" || syncCatalog.isPending
                      ? "building now…"
                      : catalog.maven.count > 0
                        ? `${fmtCount(catalog.maven.count)} products`
                        : "not built yet"}
                    {catalog.maven.lastSyncAt && (
                      <> · updated {fmtChecked(catalog.maven.lastSyncAt)}</>
                    )}
                    {catalog.maven.newThisWeek > 0 && (
                      <> · {fmtCount(catalog.maven.newThisWeek)} new this week</>
                    )}
                    {catalog.maven.count > 0 && (
                      <>
                        {" "}
                        · sizes known for {fmtCount(catalog.maven.withSize)} of{" "}
                        {fmtCount(catalog.maven.count)}
                      </>
                    )}
                    {catalog.maven.historyPoints > 0 && (
                      <>
                        {" "}
                        · {fmtCount(catalog.maven.historyPoints)} price change
                        {catalog.maven.historyPoints === 1 ? "" : "s"} on record —
                        prices are tracked in a history, not just overwritten
                      </>
                    )}
                    {catalog.maven.status === "error" && (
                      <span className="text-[var(--lose)]"> · last build hit a problem</span>
                    )}
                  </li>
                  <li>
                    <span className="font-semibold" style={{ color: storeColor("seven") }}>
                      {STORES.seven.name}
                    </span>{" "}
                    —{" "}
                    {catalog.seven.sectionsTotal > 0 &&
                    catalog.seven.sectionsDone < catalog.seven.sectionsTotal
                      ? `indexing in the background — ${catalog.seven.sectionsDone} of ${catalog.seven.sectionsTotal} sections done, ${fmtCount(catalog.seven.count)} products so far`
                      : catalog.seven.count > 0
                        ? `${fmtCount(catalog.seven.count)} products`
                        : "indexing hasn't started yet"}
                    {catalog.seven.lastSyncAt && catalog.seven.count > 0 && (
                      <> · updated {fmtChecked(catalog.seven.lastSyncAt)}</>
                    )}
                    {catalog.seven.newThisWeek > 0 && (
                      <> · {fmtCount(catalog.seven.newThisWeek)} new this week</>
                    )}
                    {/* What the sweep is doing right now: several agents
                        work different parts of the store at once, each
                        holding a batch of sections, and a batch is only
                        presumed dead after ten minutes with no save from
                        any of its sections — so showing when the oldest
                        one started is also what makes a wrongly reaped
                        batch visible. */}
                    {catalog.seven.sectionsRunning > 0 && (
                      <span>
                        {" "}
                        · {catalog.seven.batchesRunning} agent
                        {catalog.seven.batchesRunning === 1 ? "" : "s"} sweeping{" "}
                        {catalog.seven.sectionsRunning} section
                        {catalog.seven.sectionsRunning === 1 ? "" : "s"} now
                        {catalog.seven.nowSweeping.length > 0
                          ? ` (${catalog.seven.nowSweeping.slice(0, 4).join(", ")})`
                          : ""}
                        {catalog.seven.oldestBatchClaimedAt
                          ? ` · oldest batch started ${fmtChecked(
                              catalog.seven.oldestBatchClaimedAt,
                            )}`
                          : ""}
                      </span>
                    )}
                    {catalog.seven.sectionsErrored > 0 && (
                      <span className="text-[var(--lose)]">
                        {" "}
                        · {catalog.seven.sectionsErrored} section
                        {catalog.seven.sectionsErrored === 1 ? "" : "s"} hit a problem and
                        will retry on the next sync
                        {catalog.seven.lastError ? ` — ${catalog.seven.lastError}` : ""}
                      </span>
                    )}
                    {catalog.seven.sectionsShort > 0 && (
                      <span>
                        {" "}
                        · {catalog.seven.sectionsShort} section
                        {catalog.seven.sectionsShort === 1 ? "" : "s"} finished short of
                        the count the store itself lists — noted in the sweep and retried
                        when their turn comes in the rolling re-check
                      </span>
                    )}
                    {catalog.seven.historyPoints > 0 && (
                      <span>
                        {" "}
                        · {fmtCount(catalog.seven.historyPoints)} price change
                        {catalog.seven.historyPoints === 1 ? "" : "s"} on record —
                        prices are tracked in a history, not just overwritten
                      </span>
                    )}
                    {catalog.seven.count > 0 && (
                      <span>
                        {" "}
                        · sizes known for {fmtCount(catalog.seven.withSize)} of{" "}
                        {fmtCount(catalog.seven.count)} — {STORES.seven.name} prints each
                        product’s size on a separate line above its name, and the
                        sweep now records it for every product; sections still
                        missing sizes re-check first, so the rest fill in on the
                        weekly cycle
                      </span>
                    )}
                  </li>
                </ul>
                <p className="mt-2 text-xs leading-relaxed">
                  Every product is stored under the name that store uses, with its size, its
                  category from the store's own aisles, and its last price. Matching uses those
                  categories — plus whether the item is what the product actually is, not just
                  a word in its name — so an oatmeal called “Dinosaur Eggs” no longer stands in
                  for eggs. Lookups read the database first — that's what makes them instant. What
                  changes week to week is what's on sale, so specials re-check weekly at both
                  stores; ordinary prices roll through a monthly re-check — a slice of the
                  catalog each week, every product verified at least once a month. {STORES.maven.name}'s
                  store API returns its whole catalog in one quick pass, so its weekly
                  check covers everything at once; {STORES.seven.name}'s sections rotate a quarter at a
                  time. New products and categories are picked up by the weekly passes.
                </p>
                {/* Accuracy spot check — only for stores whose access
                    mode supports one (config: spotCheck). */}
                {SPOT_STORE && (
                <div className="mt-3 border-t border-dashed border-[var(--border)] pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-[var(--text)]">
                      {SPOT_STORE.name} accuracy check
                    </p>
                    <button
                      type="button"
                      onClick={() => spotCheck.mutate()}
                      disabled={spotCheck.isPending}
                      className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-1.5 text-[13px] font-semibold text-[var(--text)] disabled:opacity-50"
                      aria-label={`Run a ${SPOT_STORE?.name ?? "store"} accuracy spot check now`}
                    >
                      {spotCheck.isPending ? "Checking live prices…" : "Run spot check"}
                    </button>
                  </div>
                  {spotCheck.isPending && !spot && (
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      Comparing a sample of saved prices against the live store…
                    </p>
                  )}
                  {spotCheck.isError && (
                    <p className="mt-1 text-sm text-[var(--lose)]">
                      The spot check couldn't run — try again.
                    </p>
                  )}
                  {spot && (
                    <>
                      <p className="mt-1 text-sm text-[var(--dim)]">
                        {fmtChecked(spot.checkedAt)} — sampled {spot.total} products across
                        the catalog:{" "}
                        <span className="font-semibold text-[var(--text)]">
                          {spot.matched} matched the live store
                        </span>
                        {spot.mismatched > 0 && (
                          <>
                            , {spot.mismatched} differed (saved prices updated to the live
                            ones)
                          </>
                        )}
                        {spot.notFound > 0 && (
                          <>, {spot.notFound} no longer found at the store</>
                        )}
                        {spot.errors > 0 && (
                          <>, {spot.errors} couldn't be checked</>
                        )}
                        .
                      </p>
                      {spot.results.some((r) => r.result !== "match") && (
                        <ul className="mt-2 space-y-1 text-[13px]">
                          {spot.results
                            .filter((r) => r.result !== "match")
                            .map((r, i) => (
                              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                                <span className="min-w-0 text-[var(--text)]">
                                  {r.productName}
                                </span>
                                {r.result === "mismatch" && r.livePrice != null && (
                                  <span className="text-[var(--dim)]">
                                    saved {fmtPrice(r.catalogPrice)}
                                    {r.catalogOnSale ? " (on sale)" : ""} → live{" "}
                                    {fmtPrice(r.livePrice)}
                                    {r.liveOnSale ? " (on sale)" : ""}
                                  </span>
                                )}
                                {r.result === "not_found" && (
                                  <span className="text-[var(--dim)]">
                                    saved {fmtPrice(r.catalogPrice)} — not found in the live
                                    store
                                  </span>
                                )}
                                {r.result === "error" && (
                                  <span className="text-[var(--lose)]">
                                    couldn't be checked this run
                                  </span>
                                )}
                              </li>
                            ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => syncCatalog.mutate()}
                disabled={syncCatalog.isPending}
                className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-50"
                aria-label="Build or refresh the product database now"
              >
                {syncCatalog.isPending ? "Building…" : "Sync database"}
              </button>
            </div>
            {syncCatalog.isError && (
              <p className="mt-2 text-sm text-[var(--lose)]">
                Couldn’t start the sync — try again.
              </p>
            )}
          </section>
        )}
        {addError && (
          <p
            className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-xl rounded-md border border-[var(--lose)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--lose)] shadow-lg"
            role="alert"
          >
            {addError}{" "}
            <button
              type="button"
              onClick={() => setAddError(null)}
              className="ml-1 font-semibold underline"
              aria-label="Dismiss the add-to-list message"
            >
              Dismiss
            </button>
          </p>
        )}
        </main>
      </div>
    );
  }

  if (view === "finder") {
    const f = finder.data;
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-3xl px-4 pb-10">
          <section className="pt-5">
            <button
              type="button"
              onClick={() => setView("main")}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)]"
              aria-label="Back to prices"
            >
              ← Back to prices
            </button>
            <h2 className="font-ledger mt-3 text-2xl capitalize">{finderQuery}</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Every kind of {finderQuery} both stores carry, paired like-for-like — the
              same kind at {STORES.maven.name} next to the same kind at {STORES.seven.name}, so nothing
              here compares a random product against a random product. Kinds only one
              store carries aren’t comparisons, so they’re not listed here — they’re in
              the Shop, marked as one-store-only.
            </p>
            <form onSubmit={onFinderSearch} className="mt-3 flex gap-2">
              <label htmlFor="finder-search" className="sr-only">
                Find comparable products for
              </label>
              <input
                id="finder-search"
                value={finderDraft}
                onChange={(e) => setFinderDraft(e.target.value)}
                placeholder="e.g. Chips, Eggs, Cheese…"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
              />
              <button
                type="submit"
                disabled={finderDraft.trim().length < 2}
                className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                aria-label="Search for comparable products"
              >
                Find
              </button>
            </form>
          </section>

          {finder.isPending && finderQuery.trim().length >= 2 && (
            <p className="mt-5 text-sm text-[var(--dim)]">
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--sale)] align-middle" />
              Pairing up what both stores carry…
            </p>
          )}
          {finder.isError && (
            <p className="mt-5 text-sm text-[var(--lose)]">
              That search didn’t go through — try again.
            </p>
          )}
          {f && (
            <>
              <p className="mt-4 text-sm text-[var(--dim)]">
                {f.comparable} comparable kind{f.comparable === 1 ? "" : "s"}
                {f.mavenOnly + f.sevenOnly > 0 && (
                  <>
                    {" "}
                    · {f.mavenOnly} more product{f.mavenOnly === 1 ? "" : "s"} only at
                    {STORES.maven.short} and {f.sevenOnly} only at {STORES.seven.name} — find them in the{" "}
                    <button
                      type="button"
                      onClick={() => setView("shop")}
                      className="font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
                      aria-label="Open the shop to see one-store-only products"
                    >
                      Shop
                    </button>
                  </>
                )}
              </p>
              {f.sevenPending && (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  {STORES.seven.name} hasn’t indexed this yet — it’s queued now and fills in on its
                  own; search again in a bit.
                </p>
              )}
              {f.pairs.length === 0 && !f.sevenPending && (
                <p className="mt-4 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--dim)]">
                  No directly comparable products for “{f.query}” — the two stores carry
                  different kinds of it. Browse the Shop to see everything each store has.
                </p>
              )}
              <div className="mt-4 space-y-3">
                {f.pairs.map((pair) => (
                  <article
                    key={pair.key}
                    className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
                  >
                    <div className="flex flex-col divide-y divide-[var(--border)] sm:flex-row sm:divide-x sm:divide-y-0">
                      <FinderSide
                        label={STORES.maven.name}
                        colorVar={STORES.maven.colorVar}
                        store="maven"
                        products={pair.maven}
                        isWinnerPair={pair.winner === "maven"}
                        onAdd={onAddToList}
                        adding={addToCart.isPending}
                      />
                      <FinderSide
                        label={STORES.seven.name}
                        colorVar={STORES.seven.colorVar}
                        store="seven"
                        products={pair.seven}
                        isWinnerPair={pair.winner === "seven"}
                        onAdd={onAddToList}
                        adding={addToCart.isPending}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        {addError && (
          <p
            className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-xl rounded-md border border-[var(--lose)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--lose)] shadow-lg"
            role="alert"
          >
            {addError}{" "}
            <button
              type="button"
              onClick={() => setAddError(null)}
              className="ml-1 font-semibold underline"
              aria-label="Dismiss the add-to-list message"
            >
              Dismiss
            </button>
          </p>
        )}
        </main>
      </div>
    );
  }

  if (view === "specials") {
    const shown =
      specialsStore === "both"
        ? specials
        : specials.filter((p) => p.store === specialsStore);
    const mavenSpecials = catalog?.maven.specialsCount ?? 0;
    const sevenSpecials = catalog?.seven.specialsCount ?? 0;
    const totalSpecials =
      specialsStore === "maven"
        ? mavenSpecials
        : specialsStore === "seven"
          ? sevenSpecials
          : mavenSpecials + sevenSpecials;
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-3xl px-4 pb-10">
          <section className="pt-5">
            <button
              type="button"
              onClick={() => setView("main")}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)]"
              aria-label="Back to prices"
            >
              ← Back to prices
            </button>
            <h2 className="font-ledger mt-3 text-2xl">Specials</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Everything on special right now — pick a store, or see both together.
              Specials re-check weekly at both stores, so this is the current week’s
              picture.
            </p>
            <div className="mt-3">
              <StoreScopeToggle
                value={specialsStore}
                onChange={setSpecialsStore}
                ariaLabel="Which store's specials to show"
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(specialsStore === "both" || specialsStore === "maven") && (
                <a
                  href={FLYER_LINKS.maven.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--accent)]"
                  aria-label={`Open ${FLYER_LINKS.maven.label}`}
                >
                  {FLYER_LINKS.maven.label} →
                </a>
              )}
              {(specialsStore === "both" || specialsStore === "seven") && (
                <a
                  href={FLYER_LINKS.seven.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--accent)]"
                  aria-label={`Open ${FLYER_LINKS.seven.label}`}
                >
                  {FLYER_LINKS.seven.label} →
                </a>
              )}
            </div>
            <p className="mt-2 text-[13px] text-[var(--dim)]">
              The flyer is only part of the picture — both stores run more specials
              than the flyer shows. Everything they mark on special online is in the
              list below.
            </p>
          </section>

          <p className="mt-4 text-sm text-[var(--dim)]">
            {fmtCount(totalSpecials)} product{totalSpecials === 1 ? "" : "s"} on special
            {specialsStore !== "both"
              ? ` at ${STORES[specialsStore].name}`
              : " across both stores"}
            {shown.length < totalSpecials &&
              ` — showing the ${shown.length} most recently confirmed`}
            .
          </p>
          {shown.length === 0 ? (
            <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--dim)]">
              No specials on file for{" "}
              {specialsStore !== "both"
                ? STORES[specialsStore].name
                : "either store"}{" "}
              right now — the weekly specials check fills this in as soon as it runs.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-dashed divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4">
              {shown.map((p, i) => (
                <DealRow key={i} p={p} onAdd={onAddToList} adding={addToCart.isPending} />
              ))}
            </ul>
          )}
        {addError && (
          <p
            className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-xl rounded-md border border-[var(--lose)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--lose)] shadow-lg"
            role="alert"
          >
            {addError}{" "}
            <button
              type="button"
              onClick={() => setAddError(null)}
              className="ml-1 font-semibold underline"
              aria-label="Dismiss the add-to-list message"
            >
              Dismiss
            </button>
          </p>
        )}
        </main>
      </div>
    );
  }

  if (view === "new") {
    const shown =
      newStore === "both" ? newProducts : newProducts.filter((p) => p.store === newStore);
    const mavenNew = catalog?.maven.newThisWeek ?? 0;
    const sevenNew = catalog?.seven.newThisWeek ?? 0;
    const totalNew =
      newStore === "maven" ? mavenNew : newStore === "seven" ? sevenNew : mavenNew + sevenNew;
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-3xl px-4 pb-10">
          <section className="pt-5">
            <button
              type="button"
              onClick={() => setView("main")}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)]"
              aria-label="Back to prices"
            >
              ← Back to prices
            </button>
            <h2 className="font-ledger mt-3 text-2xl">What’s new</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Products that showed up at the stores in the last week and weren’t there
              before — pick a store, or see both together.
            </p>
            <div className="mt-3">
              <StoreScopeToggle
                value={newStore}
                onChange={setNewStore}
                ariaLabel="Which store's new products to show"
              />
            </div>
          </section>

          <p className="mt-4 text-sm text-[var(--dim)]">
            {fmtCount(totalNew)} new product{totalNew === 1 ? "" : "s"} this week
            {newStore !== "both"
              ? ` at ${STORES[newStore].name}`
              : " across both stores"}
            {shown.length < totalNew &&
              ` — showing the ${shown.length} most recent`}
            .
          </p>
          {shown.length === 0 ? (
            <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--dim)]">
              Nothing new this week at{" "}
              {newStore !== "both" ? STORES[newStore].name : "either store"}{" "}
              yet — the weekly checks pick new products up as they appear.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-dashed divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4">
              {shown.map((p, i) => (
                <DealRow key={i} p={p} onAdd={onAddToList} adding={addToCart.isPending} />
              ))}
            </ul>
          )}
        {addError && (
          <p
            className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-xl rounded-md border border-[var(--lose)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--lose)] shadow-lg"
            role="alert"
          >
            {addError}{" "}
            <button
              type="button"
              onClick={() => setAddError(null)}
              className="ml-1 font-semibold underline"
              aria-label="Dismiss the add-to-list message"
            >
              Dismiss
            </button>
          </p>
        )}
        </main>
      </div>
    );
  }

  if (view === "shop") {
    const cats = browse.data?.categories ?? [];
    const prods = browse.data?.products ?? [];
    const totalPages = browse.data ? Math.max(1, Math.ceil(browse.data.total / SHOP_PAGE)) : 1;
    const page = Math.floor(shopOffset / SHOP_PAGE) + 1;
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-3xl px-4 pb-10">
          <section className="pt-5">
            <button
              type="button"
              onClick={() => setView("main")}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)]"
              aria-label="Back to prices"
            >
              ← Back to prices
            </button>
            <h2 className="font-ledger mt-3 text-2xl">Shop both stores</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Everything both stores carry, organized by the aisles of a normal
              supermarket — produce, dairy &amp; eggs, pantry, and the rest — with both
              stores’ products shelved together in each aisle (all the applesauce sits in
              Pantry, the baby-food kind in Baby). For any aisle, the store buttons show
              both stores together — including anything only one of them carries, marked
              “{STORES.maven.short} only” or “{STORES.seven.short} only” — or just{" "}
              {STORES.seven.name}’s products, or just {STORES.maven.name}’s. Add
              anything to your shopping list as you go
              {cart.data && cart.data.count > 0
                ? ` — ${cart.data.count} item${cart.data.count === 1 ? "" : "s"} on it so far, shown on the main page.`
                : "."}
            </p>
            <form onSubmit={onShopSearch} className="mt-3 flex gap-2">
              <label htmlFor="shop-search" className="sr-only">
                Search all products
              </label>
              <input
                id="shop-search"
                value={shopDraft}
                onChange={(e) => setShopDraft(e.target.value)}
                placeholder="Search all products…"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
              />
              <button
                type="submit"
                disabled={shopDraft.trim().length < 2}
                className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                aria-label="Search all products"
              >
                Search
              </button>
            </form>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-md border border-[var(--border)]" role="group" aria-label="Store filter">
                {(
                  [
                    { key: null as StoreKey | null, label: "Both stores" },
                    ...STORE_LIST.map((s) => ({
                      key: s.key as StoreKey | null,
                      label: s.name,
                    })),
                  ]
                ).map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => {
                      setShopStore(opt.key);
                      setShopOffset(0);
                    }}
                    aria-pressed={shopStore === opt.key}
                    className={`px-3 py-2 text-sm font-semibold ${
                      shopStore === opt.key
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--surface)] text-[var(--text)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <label htmlFor="shop-category" className="sr-only">
                Aisle
              </label>
              <select
                id="shop-category"
                value={shopCategorySel}
                onChange={(e) => onShopCategory(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
                aria-label="Browse by aisle"
              >
                <option value="">On special now — all aisles</option>
                {cats.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({fmtCount(c.count)})
                  </option>
                ))}
              </select>
            </div>
            {shopQuery && (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Searching for “{shopQuery}”.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setShopQuery(null);
                    setShopDraft("");
                    setShopOffset(0);
                  }}
                  className="font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
                  aria-label="Clear the shop search"
                >
                  Clear search
                </button>
              </p>
            )}
          </section>

          {browse.isPending && (
            <p className="mt-5 text-sm text-[var(--dim)]">Loading products…</p>
          )}
          {browse.isError && (
            <p className="mt-5 text-sm text-[var(--lose)]">
              Couldn’t load the shop — try again.
            </p>
          )}
          {browse.data && (
            <>
              <p className="mt-4 text-sm text-[var(--dim)]">
                {fmtCount(browse.data.total)} product{browse.data.total === 1 ? "" : "s"}
                {shopCategory
                  ? ` in ${shopCategory}`
                  : shopQuery
                    ? ` matching “${shopQuery}”`
                    : " on special"}
                {browse.data.total > 0
                  ? ` — page ${page} of ${totalPages}`
                  : ""}
              </p>
              {prods.length === 0 ? (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--dim)]">
                  Nothing here under this filter — this aisle may be empty at the store
                  you picked, or that side of the catalog is still being indexed.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-dashed divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4">
                  {prods.map((p, i) => (
                    <li key={i} className="flex items-start gap-3 py-2.5">
                      {p.imageUrl && (
                        <img
                          src={p.imageUrl}
                          alt=""
                          className="h-11 w-11 shrink-0 rounded-md border border-[var(--border)] object-cover"
                          loading="lazy"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-snug text-[var(--text)]">{p.name}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span
                            className="rounded-sm px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white"
                            style={{
                              backgroundColor: storeColor(p.store),
                            }}
                          >
                            {STORES[p.store].short}
                          </span>
                          {p.comparable === false && (
                            <span className="rounded-sm border border-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[var(--sale)]">
                              {`${STORES[p.store].short} only`}
                            </span>
                          )}
                          {p.onSale && (
                            <span className="rounded-sm bg-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                              On special
                            </span>
                          )}
                          <DealBadge p={p} />
                          {sizeNote(p) && (
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text)]">
                              {sizeNote(p)}
                            </span>
                          )}
                          {p.category && (
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--dim)]">
                              {p.category}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="font-ledger text-lg leading-none text-[var(--text)]">
                          {fmtPrice(p.price)}
                          {basisSuffix(p)}
                          {unitText(p) && (
                            <span className="ml-1 font-sans text-xs text-[var(--dim)]">
                              {unitText(p)}
                            </span>
                          )}
                        </span>
                        {p.priceBasis !== "each" && (
                          <span className="text-[11px] text-[var(--dim)]">
                            priced {p.priceBasis === "per_lb" ? "per pound" : "per ounce"}
                          </span>
                        )}
                        {p.dealText && (
                          <span className="text-[11px] text-[var(--dim)]">
                            per item with the deal
                          </span>
                        )}
                        <AddToListButton
                          productName={p.name}
                          storeLabel={STORES[p.store].name}
                          disabled={addToCart.isPending}
                          onClick={() =>
                            onAddToList({
                              store: p.store,
                              name: p.name,
                              price: p.price,
                              category: p.category,
                            })
                          }
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {totalPages > 1 && (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={shopOffset === 0 || browse.isFetching}
                    onClick={() => setShopOffset(Math.max(0, shopOffset - SHOP_PAGE))}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-50"
                    aria-label="Previous page of products"
                  >
                    ← Previous
                  </button>
                  <span className="text-sm text-[var(--dim)]">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= totalPages || browse.isFetching}
                    onClick={() => setShopOffset(shopOffset + SHOP_PAGE)}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-50"
                    aria-label="Next page of products"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        {addError && (
          <p
            className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-xl rounded-md border border-[var(--lose)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--lose)] shadow-lg"
            role="alert"
          >
            {addError}{" "}
            <button
              type="button"
              onClick={() => setAddError(null)}
              className="ml-1 font-semibold underline"
              aria-label="Dismiss the add-to-list message"
            >
              Dismiss
            </button>
          </p>
        )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        {/* Score strip */}
        <section className="pt-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-ledger text-2xl leading-tight">
                {items.length === 0 ? (
                  <>Add what you buy — prices check themselves.</>
                ) : (
                  <>
                    <span style={{ color: storeColor("maven") }}>{STORES.maven.short} {mavenWins}</span>
                    <span className="mx-2 text-[var(--dim)]">·</span>
                    <span style={{ color: storeColor("seven") }}>{STORES.seven.short} {sevenWins}</span>
                    {ties > 0 && <span className="ml-2 text-base text-[var(--dim)]">({ties} tied)</span>}
                  </>
                )}
              </p>
              {anyPending && (
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Some prices are still coming in — they fill in on their own.
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setView("shop")}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
                aria-label="Shop both stores"
              >
                Shop
              </button>
              <button
                type="button"
                onClick={() => setView("settings")}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
                aria-label="Open settings"
              >
                Settings
              </button>
            </div>
          </div>
        </section>

        {/* Search an item — the first thing on the page */}
        <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--text)]">
            Search an item
          </h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            Type an item and it’s priced at both stores, like-for-like — the comparison
            lands on your list below and stays priced.
          </p>
          <form onSubmit={onSubmit} className="mt-3 flex gap-2">
            <label htmlFor="add-item" className="sr-only">
              Item to compare
            </label>
            <input
              id="add-item"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. Milk, Eggs, Chicken breast…"
              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
            />
            <button
              type="submit"
              disabled={addItem.isPending || !draft.trim()}
              className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              aria-label="Add item and check prices"
            >
              {addItem.isPending ? "Checking…" : "Compare"}
            </button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTIONS.filter(
              (s) => !items.some((i) => i.query.toLowerCase() === s.toLowerCase()),
            ).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addItem.mutate(s)}
                disabled={addItem.isPending}
                className="rounded-full border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-1 text-[13px] text-[var(--text)] disabled:opacity-50"
                aria-label={`Add ${s} to watchlist`}
              >
                + {s}
              </button>
            ))}
          </div>
          {addItem.isError && (
            <p className="mt-2 text-sm text-[var(--lose)]">Couldn’t add that item — try again.</p>
          )}
        </section>

        {/* List / recipe compare */}
        <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--text)]">
            Price a list or recipe
          </h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            Paste a shopping list or a whole recipe. Every line gets priced at both stores
            with the exact product behind the quote, your saved brand preferences (in
            Settings) are used even when they cost more, and the totals say which store
            wins the whole list.
          </p>
          <form onSubmit={onCompareList} className="mt-3">
            <label htmlFor="list-text" className="sr-only">
              Shopping list or recipe to price
            </label>
            <textarea
              id="list-text"
              value={listText}
              onChange={(e) => setListText(e.target.value)}
              rows={6}
              placeholder={
                `Paste here — one item per line, or a full recipe:\n\n2 lb chicken breast\n1/2 cup olive oil\n${EXAMPLE_BRAND} milk, 1/2 gallon\n…`
              }
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
            />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={compareList.isPending || listText.trim().length < 2}
                className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                aria-label="Price this list at both stores"
              >
                {compareList.isPending ? "Pricing…" : "Price this list"}
              </button>
              {compareList.isPending && (
                <span className="text-sm text-[var(--dim)]">
                  Reading the list and checking the product database…
                </span>
              )}
              {compareList.isError && (
                <span className="text-sm text-[var(--lose)]" role="alert">
                  That didn’t go through — try again.
                </span>
              )}
            </div>
          </form>

          {listResult && (
            <div className="mt-4 border-t border-dashed border-[var(--border)] pt-3">
              {listResult.items.length === 0 ? (
                <p className="text-sm text-[var(--dim)]">
                  No buyable items could be read out of that text — try one item per line.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <p className="font-ledger text-xl">
                      <span style={{ color: storeColor("maven") }}>
                        {STORES.maven.short} {listResult.mavenTotal != null ? fmtPrice(listResult.mavenTotal) : "—"}
                      </span>
                      <span className="mx-2 text-[var(--dim)]">·</span>
                      <span style={{ color: storeColor("seven") }}>
                        {STORES.seven.short} {listResult.sevenTotal != null ? fmtPrice(listResult.sevenTotal) : "—"}
                      </span>
                    </p>
                    {listResult.winner !== "none" && listResult.diff != null && (
                      <span
                        className="rounded-sm px-2 py-1 text-xs font-bold text-white"
                        style={{
                          backgroundColor:
                            listResult.winner === "tie"
                              ? "var(--dim)"
                              : storeColor(listResult.winner),
                        }}
                      >
                        {listResult.winner === "tie"
                          ? "Same total either way"
                          : `${storeOf(listResult.winner).name} wins the list by ${fmtPrice(listResult.diff)}`}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[13px] text-[var(--dim)]">
                    Totals cover the {listResult.commonCount} item
                    {listResult.commonCount === 1 ? "" : "s"} both stores priced with a
                    directly comparable product. Meat and chicken priced per pound are
                    costed at the amount your list asks for — 1 lb when it gives no
                    amount — and packaged products at the whole packages that amount
                    takes. Lines where the two stores quoted different products, or
                    where a requested weight can’t be answered from a package size,
                    are left out, so the totals never compare a random product against
                    a random product. Priced:{" "}
                    {listResult.mavenPriced} of {listResult.items.length} at {STORES.maven.short},{" "}
                    {listResult.sevenPriced} of {listResult.items.length} at {STORES.seven.short}.
                  </p>
                  <div className="mt-3 space-y-3">
                    {listResult.items.map((row, i) => (
                      <article
                        key={i}
                        className="overflow-hidden rounded-md border border-[var(--border)]"
                      >
                        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--surface-alt)] px-4 py-2">
                          <h3 className="font-ledger text-lg capitalize leading-none">
                            {row.name}
                          </h3>
                          {row.quantityText && (
                            <span className="text-[13px] text-[var(--dim)]">
                              needs {row.quantityText}
                            </span>
                          )}
                          {row.preferences.length > 0 && (
                            <span className="rounded-sm border border-[var(--accent)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[var(--accent)]">
                              Prefers {row.preferences.join(", ")}
                            </span>
                          )}
                          {row.maven.product && row.seven.product && !row.comparable && (
                            <span className="rounded-sm border border-[var(--sale)] px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[var(--sale)]">
                              Different products — not in totals
                            </span>
                          )}
                          {row.winner !== "none" && row.winner !== "tie" && (
                            <span className="ml-auto text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                              {`${storeOf(row.winner).short} cheaper`}
                            </span>
                          )}
                          {row.winner === "tie" && (
                            <span className="ml-auto text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                              Same price
                            </span>
                          )}
                        </header>
                        <div className="flex flex-col divide-y divide-[var(--border)] sm:flex-row sm:divide-x sm:divide-y-0">
                          <ListQuoteBlock
                            label={STORES.maven.name}
                            colorVar={STORES.maven.colorVar}
                            quote={row.maven}
                            isWinner={row.winner === "maven"}
                            ingredient={row.name}
                            quantityText={row.quantityText}
                            onRememberBrand={(k, b) => savePref.mutate({ keyword: k, brand: b })}
                            rememberPending={savePref.isPending}
                          />
                          <ListQuoteBlock
                            label={STORES.seven.name}
                            colorVar={STORES.seven.colorVar}
                            quote={row.seven}
                            isWinner={row.winner === "seven"}
                            ingredient={row.name}
                            quantityText={row.quantityText}
                            onRememberBrand={(k, b) => savePref.mutate({ keyword: k, brand: b })}
                            rememberPending={savePref.isPending}
                          />
                        </div>
                      </article>
                    ))}
                  </div>
                  <p className="mt-2 text-[13px] text-[var(--dim)]">
                    Changed your mind about a total? Re-run after changing a brand
                    preference in Settings — preferences apply the next time you price a
                    list.
                  </p>
                </>
              )}
            </div>
          )}

        </section>

        {/* Barcode scan */}
        <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--text)]">
                Scan a barcode
              </h2>
              <p className="mt-1 text-sm text-[var(--dim)]">
                Holding a product? Scan its barcode and see what it costs at each store.
              </p>
            </div>
            {!scanOpen && (
              <button
                type="button"
                onClick={startScanner}
                disabled={lookupBarcode.isPending}
                className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                aria-label="Scan a barcode with the camera"
              >
                Scan with camera
              </button>
            )}
          </div>

          {scanOpen && (
            <div className="mt-3">
              <video
                ref={videoRef}
                muted
                playsInline
                className="max-h-72 w-full rounded-md bg-black object-cover"
                aria-label="Camera view — point at a product barcode"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="text-sm text-[var(--dim)]" role="status">
                  {scanning
                    ? "Looking for a barcode — hold it steady inside the frame…"
                    : "Starting camera…"}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    stopScanner();
                    setScanOpen(false);
                  }}
                  className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-sm font-semibold text-[var(--text)]"
                  aria-label="Cancel barcode scan"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <form onSubmit={onManualLookup} className="mt-3 flex gap-2">
            <label htmlFor="barcode-manual" className="sr-only">
              Barcode number
            </label>
            <input
              id="barcode-manual"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="…or type the barcode number"
              inputMode="numeric"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
            />
            <label
              className="flex shrink-0 cursor-pointer items-center rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-sm font-semibold text-[var(--text)]"
              aria-label="Upload a photo of a barcode"
            >
              Photo
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Upload a photo of a barcode"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) decodePhoto(f);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              type="submit"
              disabled={lookupBarcode.isPending || manualCode.replace(/\D/g, "").length < 6}
              className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-50"
              aria-label="Look up typed barcode number"
            >
              Look up
            </button>
          </form>

          {scanError && (
            <p className="mt-2 text-sm text-[var(--lose)]" role="alert">
              {scanError}
            </p>
          )}
          {lookupBarcode.isPending && (
            <p className="mt-3 text-sm text-[var(--dim)]">
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--sale)] align-middle" />
              Looking that barcode up…
            </p>
          )}
          {lookupBarcode.isError && (
            <p className="mt-2 text-sm text-[var(--lose)]">
              The lookup failed — check your connection and try again.
            </p>
          )}

          {recentScans.data && recentScans.data.scans.length > 0 && !scanResult && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
                Recent scans
              </span>
              {recentScans.data.scans.map((s) => (
                <button
                  key={s.barcode}
                  type="button"
                  onClick={() => lookupBarcode.mutate(s.barcode)}
                  disabled={lookupBarcode.isPending}
                  className="rounded-full border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-1 text-[13px] text-[var(--text)] disabled:opacity-50"
                  aria-label={`Look up prices again for ${s.productName}`}
                >
                  {s.productName}
                </button>
              ))}
            </div>
          )}

          {scanResult && (
            <div className="mt-4 border-t border-dashed border-[var(--border)] pt-3">
              {scanResult.resolved ? (
                <>
                  <div className="flex items-start gap-3">
                    {scanResult.imageUrl && (
                      <img
                        src={scanResult.imageUrl}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-md border border-[var(--border)] object-cover"
                        loading="lazy"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-semibold leading-snug text-[var(--text)]">
                        {scanResult.productName}
                      </p>
                      <p className="mt-0.5 text-sm text-[var(--dim)]">
                        {[scanResult.brand, scanResult.quantityText]
                          .filter(Boolean)
                          .join(" · ")}
                        {[scanResult.brand, scanResult.quantityText].some(Boolean)
                          ? " · "
                          : ""}
                        Barcode {scanResult.barcode}
                      </p>
                      {scanResult.verdict.text && (
                        <span
                          className="mt-1.5 inline-block rounded-sm px-2 py-1 text-xs font-bold text-white"
                          style={{
                            backgroundColor:
                              scanResult.verdict.winner === "tie" ||
                              scanResult.verdict.winner === "none"
                                ? "var(--dim)"
                                : storeColor(scanResult.verdict.winner),
                          }}
                        >
                          {scanResult.verdict.text}
                          {scanResult.verdict.basis === "price" &&
                          scanResult.verdict.winner !== "tie"
                            ? " (listed price)"
                            : ""}
                        </span>
                      )}
                    </div>
                    <span className="flex shrink-0 flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => lookupBarcode.mutate(scanResult.barcode)}
                        disabled={lookupBarcode.isPending}
                        className="rounded px-2 py-1 text-xs font-semibold text-[var(--accent)] disabled:opacity-50"
                        aria-label="Check this barcode's prices again"
                      >
                        Check again
                      </button>
                      {!items.some(
                        (i) =>
                          i.query.toLowerCase() ===
                          (scanResult.searchQuery ?? scanResult.productName ?? "").toLowerCase(),
                      ) && (
                        <button
                          type="button"
                          onClick={() =>
                            addItem.mutate(
                              scanResult.searchQuery ?? scanResult.productName ?? "",
                            )
                          }
                          disabled={addItem.isPending || !scanResult.productName}
                          className="rounded px-2 py-1 text-xs font-semibold text-[var(--accent)] disabled:opacity-50"
                          aria-label={`Add ${scanResult.productName} to the watchlist`}
                        >
                          + Watchlist
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-col divide-y divide-[var(--border)] rounded-md border border-[var(--border)] sm:flex-row sm:divide-x sm:divide-y-0">
                    <StoreBlock
                      label={STORES.maven.name}
                      colorVar={STORES.maven.colorVar}
                      snap={scanResult.maven}
                      isWinner={scanResult.verdict.winner === "maven"}
                      storeUrl={STORES.maven.homepage}
                    />
                    <StoreBlock
                      label={STORES.seven.name}
                      colorVar={STORES.seven.colorVar}
                      snap={scanResult.seven}
                      isWinner={scanResult.verdict.winner === "seven"}
                      storeUrl={STORES.seven.homepage}
                    />
                  </div>
                  {scanResult.seven.status === "pending" && (
                    <p className="mt-2 text-sm text-[var(--dim)]">
                      {STORES.seven.name} hasn't indexed this product yet — it's queued now and the
                      price fills in on its own; tap “Check again” in a bit.
                    </p>
                  )}
                  {scanResult.maven.status === "ok" &&
                    scanResult.maven.products.length === 0 &&
                    scanResult.seven.status === "ok" &&
                    scanResult.seven.products.length === 0 && (
                      <p className="mt-2 text-sm text-[var(--dim)]">
                        Neither store's catalog shows a product under this name right now.
                      </p>
                    )}
                </>
              ) : (
                <>
                  <p className="text-sm text-[var(--text)]">
                    Barcode <span className="font-ledger">{scanResult.barcode}</span> isn't
                    in the barcode database yet — some local and store-brand products
                    aren't listed anywhere public.
                  </p>
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    Tell us what it is once and it's remembered: every future scan of this
                    barcode prices instantly.
                  </p>
                  <form onSubmit={onLinkSubmit} className="mt-2 flex gap-2">
                    <label htmlFor="barcode-link-name" className="sr-only">
                      What product is this barcode?
                    </label>
                    <input
                      id="barcode-link-name"
                      value={linkName}
                      onChange={(e) => setLinkName(e.target.value)}
                      placeholder={`e.g. ${EXAMPLE_BRAND} Milk 1/2 Gal`}
                      className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
                    />
                    <button
                      type="submit"
                      disabled={linkBarcode.isPending || linkName.trim().length < 2}
                      className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                      aria-label="Save what this barcode is and check its prices"
                    >
                      {linkBarcode.isPending ? "Checking…" : "Save & check prices"}
                    </button>
                  </form>
                  {linkBarcode.isError && (
                    <p className="mt-2 text-sm text-[var(--lose)]">
                      Couldn't save that — try again.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        {/* Specials + What's new — entry points only; the lists live
            behind these buttons, each with a {STORES.maven.name} / {STORES.seven.name} /
            Both picker, so the front page stays quick. */}
        <section className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setView("specials")}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-left"
            aria-label="See what's on special"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-bold uppercase tracking-wider text-[var(--text)]">
                Specials
              </span>
              <span className="text-[var(--sale)]" aria-hidden="true">
                →
              </span>
            </span>
            <span className="mt-1 block text-sm text-[var(--dim)]">
              {catalog && catalog.maven.specialsCount + catalog.seven.specialsCount > 0
                ? `${fmtCount(catalog.maven.specialsCount + catalog.seven.specialsCount)} products on special — ${STORES.maven.short} ${fmtCount(catalog.maven.specialsCount)} · ${STORES.seven.short} ${fmtCount(catalog.seven.specialsCount)}. Pick a store or see both.`
                : "What’s on special this week — pick a store or see both."}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setView("new")}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-left"
            aria-label="See what's new this week"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-bold uppercase tracking-wider text-[var(--text)]">
                What’s new
              </span>
              <span className="text-[var(--accent)]" aria-hidden="true">
                →
              </span>
            </span>
            <span className="mt-1 block text-sm text-[var(--dim)]">
              {catalog && catalog.maven.newThisWeek + catalog.seven.newThisWeek > 0
                ? `${fmtCount(catalog.maven.newThisWeek + catalog.seven.newThisWeek)} new products this week — ${STORES.maven.short} ${fmtCount(catalog.maven.newThisWeek)} · ${STORES.seven.short} ${fmtCount(catalog.seven.newThisWeek)}. Pick a store or see both.`
                : "New products this week — pick a store or see both."}
            </span>
          </button>
        </section>

        {/* Board */}
        <section className="mt-5 space-y-4">
          {board.isPending && <p className="text-sm text-[var(--dim)]">Loading your watchlist…</p>}
          {board.isError && (
            <p className="text-sm text-[var(--lose)]">
              Couldn’t load the board.{" "}
              <button type="button" className="underline" onClick={() => board.refetch()}>
                Retry
              </button>
            </p>
          )}
          {board.data && items.length === 0 && (
            <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--dim)]">
              Nothing on the list yet. Add a staple above and it's priced from the product
              database right away — anything the database doesn't know yet gets indexed in the
              background.
            </p>
          )}
          {items.map((item) => (
            <article
              key={item.id}
              className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
            >
              <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2.5">
                <h2 className="font-ledger text-xl capitalize leading-none">{item.query}</h2>
                {item.verdict.text && (
                  <span
                    className="rounded-sm px-2 py-1 text-xs font-bold text-white"
                    style={{
                      backgroundColor:
                        item.verdict.winner === "tie" ||
                        item.verdict.winner === "none"
                          ? "var(--dim)"
                          : storeColor(item.verdict.winner),
                    }}
                  >
                    {item.verdict.text}
                    {item.verdict.basis === "price" && item.verdict.winner !== "tie"
                      ? " (listed price)"
                      : ""}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => refreshItem.mutate(item.id)}
                    disabled={refreshItem.isPending}
                    className="rounded px-2 py-1 text-xs font-semibold text-[var(--accent)] disabled:opacity-50"
                    aria-label={`Re-check ${item.query} now`}
                  >
                    Re-check
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem.mutate(item.id)}
                    disabled={removeItem.isPending}
                    className="rounded px-2 py-1 text-xs font-semibold text-[var(--lose)] disabled:opacity-50"
                    aria-label={`Remove ${item.query} from watchlist`}
                  >
                    Remove
                  </button>
                </span>
              </header>
              {item.pairs.length > 0 ? (
                <div>
                  <div className="divide-y divide-[var(--border)]">
                    {item.pairs.slice(0, 3).map((pair, i) => (
                      <PairRow
                        key={i}
                        pair={pair}
                        onAdd={onAddToList}
                        adding={addToCart.isPending}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border)] px-4 py-2 text-[13px] text-[var(--dim)]">
                    <span>
                      {item.comparable} comparable kind{item.comparable === 1 ? "" : "s"}{" "}
                      shown side by side
                      {item.onlyCount > 0 &&
                        ` · ${item.onlyCount} product${item.onlyCount === 1 ? "" : "s"} only at one store, left out`}
                    </span>
                    <button
                      type="button"
                      onClick={() => openFinder(item.query)}
                      className="ml-auto shrink-0 rounded px-1 py-0.5 font-semibold text-[var(--accent)]"
                      aria-label={`See all comparable ${item.query} products in the finder`}
                    >
                      See all matches
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-col divide-y divide-[var(--border)] sm:flex-row sm:divide-x sm:divide-y-0">
                    <StoreBlock
                      label={STORES.maven.name}
                      colorVar={STORES.maven.colorVar}
                      snap={item.maven}
                      isWinner={item.verdict.winner === "maven"}
                      storeUrl={STORES.maven.homepage}
                    />
                    <StoreBlock
                      label={STORES.seven.name}
                      colorVar={STORES.seven.colorVar}
                      snap={item.seven}
                      isWinner={item.verdict.winner === "seven"}
                      storeUrl={STORES.seven.homepage}
                    />
                  </div>
                  {item.onlyCount > 0 && (
                    <p className="border-t border-[var(--border)] px-4 py-2 text-[13px] text-[var(--dim)]">
                      No directly comparable products at both stores for this one — the
                      closest matches above aren’t the same kinds of {item.query}, so
                      there’s no verdict.{" "}
                      <button
                        type="button"
                        onClick={() => openFinder(item.query)}
                        className="font-semibold text-[var(--accent)]"
                        aria-label={`Open the finder for ${item.query}`}
                      >
                        Open the finder
                      </button>
                    </p>
                  )}
                </>
              )}
            </article>
          ))}
        </section>

        {/* Shopping list */}
        {cart.data && cart.data.items.length > 0 && (
          <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--text)]">
                Your shopping list
              </h2>
              <button
                type="button"
                onClick={() => clearCart.mutate()}
                disabled={clearCart.isPending}
                className="rounded px-2 py-1 text-xs font-semibold text-[var(--lose)] disabled:opacity-50"
                aria-label="Clear the whole shopping list"
              >
                Clear list
              </button>
            </div>
            <p className="mt-1.5 font-ledger text-xl">
              <span style={{ color: storeColor("maven") }}>
                {STORES.maven.short} {fmtPrice(cart.data.mavenTotal)}
              </span>
              <span className="mx-2 text-[var(--dim)]">·</span>
              <span style={{ color: storeColor("seven") }}>
                {STORES.seven.short} {fmtPrice(cart.data.sevenTotal)}
              </span>
            </p>
            <ul className="mt-2 divide-y divide-dashed divide-[var(--border)]">
              {cart.data.items.map((ci) => (
                <li key={ci.id} className="flex items-center gap-2.5 py-2 text-sm">
                  <span
                    className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white"
                    style={{
                      backgroundColor: storeColor(ci.store),
                    }}
                  >
                    {STORES[ci.store].short}
                  </span>
                  <span className="min-w-0 flex-1 leading-snug text-[var(--text)]">
                    {ci.name}
                    {ci.priceBasis && (
                      <span className="mt-0.5 block text-xs font-semibold text-[var(--dim)]">
                        {fmtPrice(ci.price)}
                        {ci.priceBasis === "per_lb" ? "/lb" : "/oz"} — priced by
                        weight, so the quantity counts{" "}
                        {ci.priceBasis === "per_lb" ? "pounds" : "ounces"}
                      </span>
                    )}
                    {ci.dealText && (
                      <span className="mt-0.5 block text-xs font-semibold text-[var(--sale)]">
                        {ci.dealText}
                        {ci.regularPrice != null
                          ? ` · ${fmtPrice(ci.price)} each with the deal, reg ${fmtPrice(ci.regularPrice)}`
                          : ` · ${fmtPrice(ci.price)} each with the deal`}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setCartQty.mutate({ id: ci.id, qty: ci.qty - 1 })}
                      disabled={setCartQty.isPending}
                      className="rounded border border-[var(--border)] bg-[var(--surface-alt)] px-2 py-0.5 text-sm font-bold text-[var(--text)] disabled:opacity-50"
                      aria-label={
                        ci.priceBasis === "per_lb"
                          ? `One pound less of ${ci.name}`
                          : ci.priceBasis === "per_oz"
                            ? `One ounce less of ${ci.name}`
                            : `One less ${ci.name}`
                      }
                    >
                      −
                    </button>
                    <span className="min-w-6 text-center font-ledger">
                      {ci.qty}
                      {ci.priceBasis === "per_lb"
                        ? " lb"
                        : ci.priceBasis === "per_oz"
                          ? " oz"
                          : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCartQty.mutate({ id: ci.id, qty: ci.qty + 1 })}
                      disabled={setCartQty.isPending}
                      className="rounded border border-[var(--border)] bg-[var(--surface-alt)] px-2 py-0.5 text-sm font-bold text-[var(--text)] disabled:opacity-50"
                      aria-label={
                        ci.priceBasis === "per_lb"
                          ? `One pound more of ${ci.name}`
                          : ci.priceBasis === "per_oz"
                            ? `One ounce more of ${ci.name}`
                            : `One more ${ci.name}`
                      }
                    >
                      +
                    </button>
                  </span>
                  <span className="font-ledger w-16 shrink-0 text-right text-[var(--text)]">
                    {fmtPrice(ci.lineTotal)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeCartItemM.mutate(ci.id)}
                    disabled={removeCartItemM.isPending}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-[var(--lose)] disabled:opacity-50"
                    aria-label={`Remove ${ci.name} from the shopping list`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[13px] text-[var(--dim)]">
              Built from the finder, the shop, and your comparisons — each item is pinned
              to the store you picked it from, at that store’s catalog price when you
              added it.
              {cart.data.items.some((ci) => ci.priceBasis) &&
                " Items priced by weight (meat, chicken) show their per-pound price, and their quantity counts pounds."}
            </p>
          </section>
        )}

        <footer className="mt-6 text-xs leading-relaxed text-[var(--dim)]">
          Per-unit prices are figured from each product’s package size — the size in its name at
          {STORES.maven.name}, and at {STORES.seven.name} the size the store prints on the line above the name —
          so different sizes compare
          fairly. A “listed price” verdict means the sizes couldn’t be matched unit-for-unit. Meat,
          chicken, and other by-weight prices are shown per pound (or per ounce) exactly as the
          store prices them, and comparisons and totals keep them that way — a per-pound price is
          never compared against a whole-package price. Sale
          badges show only when the store itself marks the item on special. Multi-buy specials
          (“4 for $5.00”, buy-one-get-one) show the per-item price with the deal stated next to
          it — never the bundle total as if it were one item’s price.
        </footer>
      {addError && (
          <p
            className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-xl rounded-md border border-[var(--lose)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--lose)] shadow-lg"
            role="alert"
          >
            {addError}{" "}
            <button
              type="button"
              onClick={() => setAddError(null)}
              className="ml-1 font-semibold underline"
              aria-label="Dismiss the add-to-list message"
            >
              Dismiss
            </button>
          </p>
        )}
        </main>
    </div>
  );
}
