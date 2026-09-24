export type Action = "buy" | "sell" | "hold";
export type Side = "buy" | "sell";
export type Category = "linear" | "spot";

export interface Quote {
  side: Side;
  price: number;
  size: number;
  orderId: string | null;
  orderLinkId: string | null;
  status: "sim" | "placed" | "amended" | "kept" | "rejected";
  capped: boolean;
}

export interface Fill {
  side: Side;
  size: number;
  price: number;
  orderId: string | null;
  execId: string | null;
  feeUsd: number;
  simulated: boolean;
}

export interface Decision {
  action: Action;
  probabilities: { buy: number; sell: number; hold: number };
  upIn10: number;
  latencyMs: number;
  late: boolean;
}

export interface Position {
  side: "long" | "short" | "flat";
  size: number;
  entryPrice: number | null;
  unrealizedUsd: number;
}

export interface Totals {
  ticks: number;
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
  decision: Decision | null;
  quote: Quote | null;
  fill: Fill | null;
  resting: { bid: number; ask: number };
  position: Position;
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
  wallet: string | null;
  fees: { maker: number; taker: number; source: string };
  loopMs: number;
}

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface SymbolBook {
  events: TickEvent[];
  latest: TickEvent | null;
  avgLatencyMs: number;
}

export interface FeedState {
  meta: Meta | null;
  connection: ConnectionState;
  books: Record<string, SymbolBook>;
}
