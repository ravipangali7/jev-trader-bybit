/** Shared shapes for the Bybit trader, the HTTP API, and the dashboard. */

export type Side = "buy" | "sell";
export type Action = "buy" | "sell" | "hold";
export type Category = "linear" | "spot";

export interface Instrument {
  symbol: string;
  category: Category;
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
  maxOrderQty: number;
  /** Minimum order value in quote (USDT). 0 if the instrument has none. */
  minNotional: number;
  priceDecimals: number;
  qtyDecimals: number;
  /** `exchange` is /v5/market/instruments-info. `book` is a dry-run fallback when that call fails. */
  source: "exchange" | "book";
}

export interface BookView {
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
  /** Top 5 levels each side, best first: [price, size]. */
  levels: { bids: [number, number][]; asks: [number, number][] };
  /** Cumulative base size within N bps of mid, per side. Keys are "10", "25", "50". */
  depthBps: Record<string, { bid: number; ask: number }>;
}

/** A public taker print. `side` is the aggressor. */
export interface Print {
  ts: number;
  price: number;
  size: number;
  side: Side;
  id: string;
}

export interface TradeSummary {
  count: number;
  buyQty: number;
  sellQty: number;
  /** Taker buy size minus taker sell size. */
  cvd: number;
  vwap: number | null;
  lastPrice: number | null;
  lastSide: Side | null;
}

/**
 * The order this tick put on the book. One post-only limit, replacing the previous one.
 * `sim` is paper. `placed` / `amended` / `kept` are live (or a paper order that did not move).
 * `rejected` means Bybit refused it (post-only would take, missing margin, bad size).
 */
export interface Quote {
  side: Side;
  price: number;
  size: number;
  orderId: string | null;
  orderLinkId: string | null;
  status: "sim" | "placed" | "amended" | "kept" | "rejected";
  /** The position cap or funds picked this side. Probabilities still show the model's call. */
  capped: boolean;
}

/** A maker fill: a taker hit one of our resting orders. */
export interface Fill {
  side: Side;
  size: number;
  price: number;
  orderId: string | null;
  execId: string | null;
  feeUsd: number;
  simulated: boolean;
}

export interface Totals {
  ticks: number;
  /** Same as `ticks`. Kept so a chart that still says "block" has a monotonic x. */
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  rejected: number;
  lateTicks: number;
  lateBlocks: number;
  jevUsd: number;
  feesUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlPct: number;
}

export interface TickEvent {
  symbol: string;
  tick: number;
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  priceDecimals: number;
  decision: {
    action: Action;
    probabilities: Record<Action, number>;
    upIn10: number;
    latencyMs: number;
    late: boolean;
  } | null;
  quote: Quote | null;
  fill: Fill | null;
  resting: { bid: number; ask: number };
  position: {
    side: "long" | "short" | "flat";
    size: number;
    entryPrice: number | null;
    unrealizedUsd: number;
  };
  totals: Totals;
  halted: boolean;
}

export interface Meta {
  model: string;
  dryRun: boolean;
  testnet: boolean;
  category: Category;
  symbols: string[];
  startedAt: number;
  killed: boolean;
  killReason: string | null;
  marketData: "connecting" | "live" | "reconnecting";
  /** Null in a dry run. "bybit" when live. Never an API key. */
  wallet: string | null;
  fees: { maker: number; taker: number; source: string };
  loopMs: number;
}
