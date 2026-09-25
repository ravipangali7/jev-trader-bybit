import { applyFill, flat, unrealizedUsd, type Inventory } from "./pnl.ts";
import type { Side } from "./types.ts";

/** One simulated or live fill, as stored and as replayed. */
export interface AccountFill {
  symbol: string;
  ts: number;
  side: Side;
  size: number;
  price: number;
  feeUsd: number;
  /** Realized USDT on the closing part of this fill. 0 when the fill only opens. */
  realizedUsd: number;
  positionQty: number;
  equityUsd: number;
  simulated: boolean;
  orderId: string | null;
  execId: string | null;
}

export interface ReplayState {
  qty: number;
  costUsd: number;
  realizedUsd: number;
  feesUsd: number;
  fills: number;
  roundTrips: number;
  wins: number;
  execIds: string[];
}

export interface MetricInput {
  startUsd: number;
  fills: number;
  roundTrips: number;
  wins: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  positionQty: number;
  /** Highest equity seen, including the starting balance. */
  peakEquityUsd: number;
}

export interface Metrics {
  startUsd: number;
  fills: number;
  roundTrips: number;
  wins: number;
  /** Null until a round trip has closed. Wins are closed trips with positive net P&L. */
  winRate: number | null;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  /** realized + unrealized - fees */
  pnlUsd: number;
  roiPct: number;
  drawdownUsd: number;
  drawdownPct: number;
  equityUsd: number;
  positionQty: number;
  peakEquityUsd: number;
}

/** Base closed by this fill. 0 when the fill does not reduce an open position. */
export function closingSize(qtyBefore: number, side: Side, size: number): number {
  if (!(size > 0) || qtyBefore === 0) return 0;
  const signed = side === "buy" ? size : -size;
  if (Math.sign(qtyBefore) === Math.sign(signed)) return 0;
  return Math.min(size, Math.abs(qtyBefore));
}

/** Realized P&L of the close, minus the fee share of the closed size. */
export function closeNet(realizedUsd: number, feeUsd: number, closed: number, size: number): number {
  if (!(closed > 0) || !(size > 0)) return 0;
  return realizedUsd - feeUsd * (closed / size);
}

export function equityUsd(startUsd: number, realizedUsd: number, unrealized: number, feesUsd: number): number {
  return startUsd + realizedUsd + unrealized - feesUsd;
}

/** Replay fills oldest-first into a paper account. */
export function replayFills(fills: AccountFill[]): ReplayState {
  const inv: Inventory = flat();
  let realizedUsd = 0;
  let feesUsd = 0;
  let roundTrips = 0;
  let wins = 0;
  const execIds: string[] = [];
  for (const fill of fills) {
    const before = inv.qty;
    const realized = applyFill(inv, fill.side, fill.size, fill.price);
    realizedUsd += realized;
    feesUsd += fill.feeUsd;
    const closed = closingSize(before, fill.side, fill.size);
    if (closed > 0) {
      roundTrips++;
      if (closeNet(realized, fill.feeUsd, closed, fill.size) > 0) wins++;
    }
    if (fill.execId) execIds.push(fill.execId);
  }
  return {
    qty: inv.qty,
    costUsd: inv.costUsd,
    realizedUsd,
    feesUsd,
    fills: fills.length,
    roundTrips,
    wins,
    execIds,
  };
}

const r8 = (n: number) => Math.round(n * 1e8) / 1e8;

export function buildMetrics(input: MetricInput): Metrics {
  const unreal = input.unrealizedUsd;
  const pnlUsd = input.realizedUsd + unreal - input.feesUsd;
  const equity = equityUsd(input.startUsd, input.realizedUsd, unreal, input.feesUsd);
  const peak = Math.max(input.peakEquityUsd, equity, input.startUsd);
  const drawdownUsd = Math.max(0, peak - equity);
  return {
    startUsd: r8(input.startUsd),
    fills: input.fills,
    roundTrips: input.roundTrips,
    wins: input.wins,
    winRate: input.roundTrips > 0 ? input.wins / input.roundTrips : null,
    realizedUsd: r8(input.realizedUsd),
    unrealizedUsd: r8(unreal),
    feesUsd: r8(input.feesUsd),
    pnlUsd: r8(pnlUsd),
    roiPct: input.startUsd > 0 ? r8((pnlUsd / input.startUsd) * 100) : 0,
    drawdownUsd: r8(drawdownUsd),
    drawdownPct: peak > 0 ? r8((drawdownUsd / peak) * 100) : 0,
    equityUsd: r8(equity),
    positionQty: r8(input.positionQty),
    peakEquityUsd: r8(peak),
  };
}

/** Mark to market helper used by tests. */
export function markUnrealized(inv: Inventory, mid: number): number {
  return unrealizedUsd(inv, mid);
}
