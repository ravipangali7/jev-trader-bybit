import type { Side } from "./types.ts";

export interface Inventory {
  /** Signed base. Positive is long. */
  qty: number;
  /** Signed cost in USDT, same sign as qty. Entry is cost/qty. */
  costUsd: number;
}

export function flat(): Inventory {
  return { qty: 0, costUsd: 0 };
}

/** Apply a fill. Returns the USDT realized on the closing part. */
export function applyFill(inv: Inventory, side: Side, size: number, price: number): number {
  if (size <= 0) return 0;
  const signed = side === "buy" ? size : -size;
  let realized = 0;
  if (inv.qty === 0 || Math.sign(inv.qty) === Math.sign(signed)) {
    inv.costUsd += signed * price;
  } else {
    const closing = Math.min(Math.abs(signed), Math.abs(inv.qty)) * Math.sign(signed);
    const entry = inv.costUsd / inv.qty;
    realized = -closing * (price - entry);
    inv.costUsd += closing * entry;
    const remainder = signed - closing;
    inv.costUsd += remainder * price;
  }
  inv.qty += signed;
  if (Math.abs(inv.qty) < 1e-12) {
    inv.qty = 0;
    inv.costUsd = 0;
  }
  return realized;
}

export function entryPrice(inv: Inventory): number | null {
  return inv.qty ? inv.costUsd / inv.qty : null;
}

export function unrealizedUsd(inv: Inventory, mid: number): number {
  const entry = entryPrice(inv);
  return entry === null ? 0 : inv.qty * (mid - entry);
}

/**
 * This process's P&L. `baselineUnrealized` is the open P&L at startup (a seeded exchange
 * position), so an old underwater position does not trip the kill switch by itself.
 */
export function sessionPnl(realizedUsd: number, unrealized: number, baselineUnrealized: number, feesUsd: number): number {
  return realizedUsd + (unrealized - baselineUnrealized) - feesUsd;
}

export function shouldKill(pnlUsd: number, maxLossUsd: number): boolean {
  return maxLossUsd > 0 && pnlUsd <= -Math.abs(maxLossUsd);
}
