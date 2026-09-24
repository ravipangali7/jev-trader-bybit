import type { Category, Instrument } from "../types.ts";
import { decimals, snapStep } from "./num.ts";

export function parseInstrument(category: Category, row: Record<string, unknown>): Instrument {
  const symbol = String(row.symbol ?? "");
  const priceFilter = (row.priceFilter ?? {}) as Record<string, string>;
  const lot = (row.lotSizeFilter ?? {}) as Record<string, string>;
  const tickSize = Number(priceFilter.tickSize);
  const qtyStep = Number(lot.qtyStep ?? lot.basePrecision);
  const minOrderQty = Number(lot.minOrderQty);
  const maxOrderQty = Number(lot.maxOrderQty ?? "1000000000");
  const minNotional = Number(lot.minNotionalValue ?? lot.minOrderAmt ?? "0");
  if (!symbol || !(tickSize > 0) || !(qtyStep > 0) || !(minOrderQty > 0)) {
    throw new Error(`instruments-info for ${symbol || "unknown"} is missing tick or qty filters`);
  }
  return {
    symbol,
    category,
    tickSize,
    qtyStep,
    minOrderQty,
    maxOrderQty: maxOrderQty > 0 ? maxOrderQty : 1e12,
    minNotional: Number.isFinite(minNotional) ? minNotional : 0,
    priceDecimals: decimals(tickSize),
    qtyDecimals: decimals(qtyStep),
    source: "exchange",
  };
}

function maxDecimals(values: string[]): number {
  let d = 0;
  for (const v of values) {
    const i = v.indexOf(".");
    if (i >= 0) d = Math.max(d, v.length - i - 1);
  }
  return d;
}

function minPositiveDiff(raw: string[]): number | null {
  const nums = [...new Set(raw.map(Number))].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < nums.length; i++) {
    const d = nums[i]! - nums[i - 1]!;
    if (d > 1e-12) min = Math.min(min, d);
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * Dry-run fallback when instruments-info cannot be reached.
 * Tick size is the smallest gap between book prices (levels sit one tick apart).
 * Qty step is the finest decimal Bybit printed on a size. Min qty is that step.
 * Min notional defaults to 5 USDT, which is Bybit's usual USDT-perp floor, and is
 * replaced as soon as instruments-info succeeds.
 */
export function inferInstrument(
  category: Category,
  symbol: string,
  bids: [string, string][],
  asks: [string, string][],
): Instrument | null {
  const prices = [...bids, ...asks].map((l) => l[0]).filter((p): p is string => Boolean(p));
  const sizes = [...bids, ...asks].map((l) => l[1]).filter((s): s is string => Boolean(s));
  const diff = minPositiveDiff(prices);
  if (diff === null || sizes.length === 0) return null;
  const tickSize = snapStep(diff);
  const qtyDecimals = maxDecimals(sizes);
  const qtyStep = 10 ** -qtyDecimals;
  return {
    symbol,
    category,
    tickSize,
    qtyStep,
    minOrderQty: qtyStep,
    maxOrderQty: 1e12,
    minNotional: 5,
    priceDecimals: decimals(tickSize),
    qtyDecimals,
    source: "book",
  };
}
