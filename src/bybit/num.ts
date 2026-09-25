import type { Side } from "../types.ts";

/** Decimal places of a step such as 0.01 or 0.0001. */
export function decimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const t = step.toString().toLowerCase();
  if (t.includes("e")) {
    const [m, e] = t.split("e");
    const exp = Number(e);
    const md = (m?.split(".")[1] ?? "").length;
    return Math.max(0, md - exp);
  }
  const i = t.indexOf(".");
  return i < 0 ? 0 : t.length - i - 1;
}

export function formatStep(value: number, places: number): string {
  return value.toFixed(places);
}

/** Snap a noisy positive difference onto a 1, 2, or 5 times a power of ten. */
export function snapStep(min: number): number {
  if (!(min > 0) || !Number.isFinite(min)) throw new Error("step must be positive");
  const exp = Math.round(Math.log10(min));
  const pow = 10 ** exp;
  const n = min / pow;
  const nice = [1, 2, 5, 10].reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), 1);
  const step = nice === 10 ? pow * 10 : nice * pow;
  return Number(step.toPrecision(12));
}

/**
 * Post-only price, `insideTicks` inside the touch, never crossing.
 * A one-tick spread cannot step inside, so the quote joins the touch.
 * Integer tick math, so the price lands on the instrument grid.
 */
export function quotePrice(side: Side, bid: number, ask: number, tick: number, insideTicks: number): number {
  if (!(tick > 0) || !(bid > 0) || !(ask > 0) || ask < bid) throw new Error("bad book for quote");
  const bidU = Math.round(bid / tick);
  const askU = Math.round(ask / tick);
  const step = Math.max(0, Math.floor(insideTicks));
  let p = side === "buy" ? bidU + step : askU - step;
  if (side === "buy" && p >= askU) p = bidU;
  if (side === "sell" && p <= bidU) p = askU;
  if (p <= 0) p = side === "buy" ? bidU : askU;
  return Number((p * tick).toFixed(decimals(tick)));
}

/** Floor `raw` onto the qty step. */
export function alignQtyDown(raw: number, step: number): number {
  if (!(step > 0)) throw new Error("bad qty step");
  const q = Math.floor(raw / step + 1e-8) * step;
  return Number(q.toFixed(decimals(step)));
}

/** Smallest qty that satisfies minOrderQty and min notional, aligned up to the step. */
export function minTradableQty(price: number, step: number, minQty: number, minNotional: number): number {
  const fromNotional = minNotional > 0 && price > 0 ? (minNotional / price) : 0;
  const raw = Math.max(minQty, fromNotional);
  const up = Math.ceil(raw / step - 1e-8) * step;
  return Number(up.toFixed(decimals(step)));
}

/** Order qty: the configured size, raised to the minimum and capped by the maximum, on the step. */
export function orderQty(wanted: number, price: number, step: number, minQty: number, maxQty: number, minNotional: number): number {
  const min = minTradableQty(price, step, minQty, minNotional);
  let q = alignQtyDown(Math.max(wanted, min), step);
  if (q < min) q = min;
  const max = alignQtyDown(maxQty, step);
  if (q > max) q = max;
  return q;
}
