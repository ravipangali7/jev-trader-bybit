import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SymbolSpec } from "./config.ts";
import type { Model, TradeState } from "./model.ts";
import { applyFill, entryPrice, flat, sessionPnl, shouldKill, unrealizedUsd, type Inventory } from "./pnl.ts";
import { formatStep, orderQty, quotePrice } from "./bybit/num.ts";
import { feeToUsd } from "./bybit/fees.ts";
import { isBalanceError, isMissingOrder, type BybitVenue, type LiveExecution, type LiveOrderUpdate } from "./bybit/venue.ts";
import type { BookView, Fill, Instrument, Print, Quote, Side, TickEvent, Totals, TradeSummary } from "./types.ts";

export interface MarketData {
  view(symbol: string): BookView | null;
  drainPrints(symbol: string): Print[];
  summary(symbol: string, sinceTs: number): TradeSummary;
  recent(symbol: string, n: number): Print[];
}

export interface TraderOpts {
  spec: SymbolSpec;
  instrument: Instrument;
  model: Model;
  data: MarketData;
  /** Null in a dry run. Live orders go through this. */
  venue: BybitVenue | null;
  loopMs: number;
  horizonTicks: number;
  bankrollUsd: number;
  maxLossUsd: number;
  makerFee: number;
  jevUsdPerMTok: number;
  historySize: number;
  /** Combined session P&L across symbols. The kill switch uses the sum. */
  portfolioPnl: () => number;
  kill: (reason: string) => void;
  isKilled: () => boolean;
  onEvent: (e: TickEvent, timing?: { readMs: number; loopMs: number }) => void;
  onFill: (tick: number, fill: Fill) => void;
  /** Live only. False when the wallet cannot fund this order. Unknown balances should return true. */
  funds?: (side: Side, qty: number, price: number) => boolean;
  logFile?: string;
}

interface Resting {
  orderId: string;
  side: Side;
  price: number;
  size: number;
  placedTs: number;
  tick: number;
}

const emptySummary = (): TradeSummary => ({
  count: 0, buyQty: 0, sellQty: 0, cvd: 0, vwap: null, lastPrice: null, lastSide: null,
});

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * One symbol. Every timer tick: read the book, ask the model buy or sell, and rest one post-only
 * limit on that side, `insideTicks` inside the touch, cancelling or amending the previous order.
 * One tick in flight. A tick that arrives while the previous one is still running is late and quotes nothing.
 * Dry runs simulate the fill when a real public trade crosses the resting price.
 */
export class SymbolTrader {
  readonly history: TickEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  /** Ticks that arrived while a decision was in flight. Emitted after that decision, so the stream stays ordered. */
  private pendingLate: number[] = [];
  private lastBook: BookView | null = null;
  private resting: Resting | null = null;
  private simId = 0;
  private tickN = 0;
  private position: Inventory = flat();
  private baselineUnrealized: number | null = null;
  private totals: Totals = {
    ticks: 0, blocks: 0, decisions: 0, quotes: 0, fills: 0, rejected: 0, lateTicks: 0, lateBlocks: 0,
    jevUsd: 0, feesUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlPct: 0,
  };
  private seenExec = new Set<string>();
  private link = 0;
  private sizeNote = false;
  instrument: Instrument;

  constructor(private opts: TraderOpts) {
    this.instrument = opts.instrument;
    if (opts.logFile) mkdirSync(dirname(opts.logFile), { recursive: true });
  }

  get symbol() { return this.opts.spec.symbol; }
  get pnlUsd() { return this.totals.pnlUsd; }
  get positionQty() { return this.position.qty; }

  updateInstrument(inst: Instrument) {
    this.instrument = inst;
  }

  /** Live startup: the account already has a position. Session P&L ignores the open P&L at this moment. */
  seed(qty: number, entry: number) {
    this.position = qty ? { qty, costUsd: qty * entry } : flat();
    this.baselineUnrealized = null;
  }

  async onTick() {
    if (this.opts.isKilled()) return;
    const bookNow = this.opts.data.view(this.symbol);
    if (!bookNow && !this.busy) return;
    this.totals.ticks++;
    this.totals.blocks = this.totals.ticks;
    const tick = this.totals.ticks;
    if (this.busy) {
      this.totals.lateTicks++;
      this.totals.lateBlocks = this.totals.lateTicks;
      this.pendingLate.push(tick);
      return;
    }
    const book = bookNow;
    if (!book) return;
    this.busy = true;
    const t0 = performance.now();
    try {
      if (!this.opts.venue) this.harvestSims();
      this.maybeKill(book.mid);
      if (this.opts.isKilled()) return;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();

      const decision = await this.opts.model.decide(this.buildState(tick, book));
      if (this.opts.isKilled()) return;
      const wanted: Side = decision.action === "sell" ? "sell" : "buy";
      const other: Side = wanted === "buy" ? "sell" : "buy";
      const size = this.sized(book.mid);
      const side: Side | null = size > 0 && this.allowed(wanted, size, book.mid) ? wanted : size > 0 && this.allowed(other, size, book.mid) ? other : null;
      this.totals.decisions++;
      this.totals.jevUsd += (decision.inputTokens / 1e6) * this.opts.jevUsdPerMTok;

      let quote: Quote | null = null;
      if (side && size > 0) {
        decision.action = side;
        const capped = side !== wanted;
        quote = await this.quote(tick, side, size, book, capped);
        if (quote) this.totals.quotes++;
        if (quote?.status === "rejected") this.totals.rejected++;
      }
      this.emit(tick, book, decision, quote, false, { readMs: 0, loopMs: Math.round(performance.now() - t0) });
      this.maybeKill(book.mid);
    } catch (e) {
      console.error(`${this.symbol} tick ${tick}:`, (e as Error).message);
    } finally {
      this.busy = false;
      const late = this.pendingLate.splice(0);
      for (const t of late) {
        if (this.lastBook) this.emit(t, this.lastBook, null, null, true);
      }
    }
  }

  /** A private-stream (or backfill) execution. Deduped by exec id. */
  onLiveFill(ex: LiveExecution) {
    if (ex.symbol !== this.symbol) return;
    if (ex.ts && this.startedAt && ex.ts < this.startedAt) return;
    if (this.seenExec.has(ex.execId)) return;
    this.seenExec.add(ex.execId);
    const feeUsd = feeToUsd(ex.fee, ex.feeCurrency, ex.price);
    const fill: Fill = {
      side: ex.side, size: ex.size, price: ex.price, orderId: ex.orderId, execId: ex.execId, feeUsd, simulated: false,
    };
    this.noteFill(fill);
    if (this.resting && this.resting.orderId === ex.orderId) {
      this.resting.size = Math.max(0, this.resting.size - ex.size);
      if (this.resting.size <= this.instrument.qtyStep / 2) this.resting = null;
    }
    const book = this.lastBook;
    if (book) this.maybeKill(book.mid);
  }

  onOrderUpdate(o: LiveOrderUpdate) {
    if (o.symbol !== this.symbol || !this.resting || this.resting.orderId !== o.orderId) return;
    const dead = o.orderStatus === "Cancelled" || o.orderStatus === "Rejected" || o.orderStatus === "Filled" || o.orderStatus === "Deactivated";
    if (dead) {
      if (o.rejectReason && o.rejectReason !== "EC_NoError" && o.rejectReason !== "EC_PerCancelRequest") {
        console.warn(`${this.symbol} order ${o.orderId} ${o.orderStatus} ${o.rejectReason}`);
      }
      this.resting = null;
      return;
    }
    if (o.leavesQty >= 0) this.resting.size = o.leavesQty;
  }

  /** Set just before the first tick so backfill does not replay older account history. */
  startedAt = 0;

  private sized(price: number): number {
    const inst = this.instrument;
    const wanted = this.opts.spec.size ?? inst.minOrderQty;
    const q = orderQty(wanted, price, inst.qtyStep, inst.minOrderQty, inst.maxOrderQty, inst.minNotional);
    if (!this.sizeNote && this.opts.spec.size !== null && q !== alignNote(this.opts.spec.size, inst.qtyStep)) {
      console.log(`${this.symbol} order size ${this.opts.spec.size} adjusted to ${q} (step ${inst.qtyStep}, min ${inst.minOrderQty}, min notional ${inst.minNotional})`);
      this.sizeNote = true;
    }
    const cap = this.cap();
    if (q > cap) {
      if (!this.sizeNote) console.warn(`${this.symbol} order size ${q} is above the position cap ${cap}, not quoting`);
      this.sizeNote = true;
      return 0;
    }
    return q;
  }

  private cap(): number {
    const spec = this.opts.spec;
    if (spec.maxPosition !== null) return spec.maxPosition;
    const size = spec.size ?? this.instrument.minOrderQty;
    return size * 10;
  }

  /** The new order replaces the old one, so only the new size plus the position counts. */
  private allowed(side: Side, size: number, price: number): boolean {
    const next = side === "buy" ? this.position.qty + size : this.position.qty - size;
    if (Math.abs(next) > this.cap() + 1e-9) return false;
    if (this.opts.funds && !this.opts.funds(side, size, price)) return false;
    return true;
  }

  private async quote(tick: number, side: Side, size: number, book: BookView, capped: boolean): Promise<Quote | null> {
    const inst = this.instrument;
    const price = quotePrice(side, book.bid, book.ask, inst.tickSize, this.opts.spec.insideTicks);
    if (!this.opts.venue) {
      this.resting = { orderId: `sim-${++this.simId}`, side, price, size, placedTs: Date.now(), tick };
      return { side, price, size, orderId: this.resting.orderId, orderLinkId: null, status: "sim", capped };
    }
    const venue = this.opts.venue;
    const qty = formatStep(size, inst.qtyDecimals);
    const px = formatStep(price, inst.priceDecimals);
    try {
      if (this.resting && this.resting.side !== side) {
        await venue.cancel(this.symbol, this.resting.orderId);
        this.resting = null;
      }
      if (this.opts.isKilled()) return null;
      if (this.resting && this.resting.side === side) {
        if (this.resting.price === price && Math.abs(this.resting.size - size) < inst.qtyStep / 2) {
          return { side, price, size, orderId: this.resting.orderId, orderLinkId: null, status: "kept", capped };
        }
        try {
          await venue.amend(this.symbol, this.resting.orderId, qty, px);
          this.resting.price = price;
          this.resting.size = size;
          this.resting.tick = tick;
          return { side, price, size, orderId: this.resting.orderId, orderLinkId: null, status: "amended", capped };
        } catch (e) {
          if (!isMissingOrder(e)) throw e;
          this.resting = null;
        }
      }
      const orderLinkId = linkId(this.symbol, tick, ++this.link);
      const placed = await venue.place({ symbol: this.symbol, side, qty, price: px, orderLinkId });
      if (this.opts.isKilled()) {
        await venue.cancel(this.symbol, placed.orderId).catch(() => {});
        return null;
      }
      this.resting = { orderId: placed.orderId, side, price, size, placedTs: Date.now(), tick };
      return { side, price, size, orderId: placed.orderId, orderLinkId, status: "placed", capped };
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`${this.symbol} order: ${msg}`);
      if (isBalanceError(e)) console.warn(`${this.symbol} not enough balance for ${side} ${qty} @ ${px}`);
      return { side, price, size, orderId: null, orderLinkId: null, status: "rejected", capped };
    }
  }

  private harvestSims() {
    const prints = this.opts.data.drainPrints(this.symbol);
    const order = this.resting;
    if (!order) return;
    for (const p of prints) {
      if (!this.resting || this.resting.orderId !== order.orderId) break;
      const size = simHit(this.resting, p);
      if (size <= 0) continue;
      const feeUsd = size * this.resting.price * this.opts.makerFee;
      const fill: Fill = {
        side: this.resting.side, size, price: this.resting.price, orderId: this.resting.orderId, execId: p.id, feeUsd, simulated: true,
      };
      this.resting.size -= size;
      if (this.resting.size <= this.instrument.qtyStep / 2) this.resting = null;
      this.noteFill(fill);
    }
  }

  private noteFill(fill: Fill) {
    this.totals.realizedUsd += applyFill(this.position, fill.side, fill.size, fill.price);
    this.totals.feesUsd += fill.feeUsd;
    this.totals.fills++;
    const tick = this.history.at(-1)?.tick ?? this.totals.ticks;
    const e = this.history.find((h) => h.tick === tick);
    if (e) e.fill = e.fill && e.fill.side === fill.side ? combineFill(e.fill, fill) : fill;
    this.onFillRefresh();
    this.opts.onFill(tick, fill);
  }

  private onFillRefresh() {
    const book = this.lastBook;
    if (!book) return;
    const e = this.history.at(-1);
    if (!e) return;
    this.writeTotals(book.mid);
    e.position = this.positionView(book.mid);
    e.totals = this.totalsView();
    e.resting = this.restingView();
  }

  private maybeKill(mid: number) {
    this.writeTotals(mid);
    const portfolio = this.opts.portfolioPnl();
    if (shouldKill(portfolio, this.opts.maxLossUsd)) {
      this.opts.kill(`session P&L $${portfolio.toFixed(2)} hit the max loss of $${this.opts.maxLossUsd}`);
    }
  }

  private writeTotals(mid: number) {
    const unreal = unrealizedUsd(this.position, mid);
    if (this.baselineUnrealized === null) this.baselineUnrealized = unreal;
    const t = this.totals;
    t.pnlUsd = sessionPnl(t.realizedUsd, unreal, this.baselineUnrealized, t.feesUsd);
    t.pnlPct = this.opts.bankrollUsd ? (t.pnlUsd / this.opts.bankrollUsd) * 100 : 0;
  }

  private buildState(tick: number, book: BookView): TradeState {
    const m = this.mids;
    const n = m.length;
    const H = this.opts.horizonTicks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0);
    const pd = this.instrument.priceDecimals;
    const lvl = (l: [number, number]) => `${l[0].toFixed(pd)} x ${round(l[1], this.instrument.qtyDecimals)}`;
    const since = Date.now() - H * this.opts.loopMs;
    const trades = this.opts.data.summary(this.symbol, since);
    const depth: TradeState["depth"] = {};
    for (const band of ["10", "25", "50"]) {
      const v = book.depthBps[band];
      if (v) depth[`${band}bps`] = { bid: round(v.bid, 4), ask: round(v.ask, 4) };
    }
    const size = this.sized(book.mid);
    return {
      market: this.symbol,
      tick,
      horizonTicks: H,
      intervalMs: this.opts.loopMs,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(pd)).join(" "),
      trades: trades ?? emptySummary(),
      recentTrades: this.opts.data.recent(this.symbol, 10).map((t) => `${t.side} ${round(t.size, 4)} @ ${t.price.toFixed(pd)}`),
      allowed: { buy: size > 0 && this.allowed("buy", size, book.mid), sell: size > 0 && this.allowed("sell", size, book.mid) },
    };
  }

  private restingView() {
    const bid = this.resting?.side === "buy" ? this.resting.size : 0;
    const ask = this.resting?.side === "sell" ? this.resting.size : 0;
    return { bid: round(bid, 4), ask: round(ask, 4) };
  }

  private positionView(mid: number) {
    const size = Math.abs(this.position.qty);
    const unreal = unrealizedUsd(this.position, mid);
    return {
      side: this.position.qty > 0 ? "long" as const : this.position.qty < 0 ? "short" as const : "flat" as const,
      size: round(size, 4),
      entryPrice: entryPrice(this.position),
      unrealizedUsd: round(unreal, 4),
    };
  }

  private totalsView(): Totals {
    const t = this.totals;
    return {
      ...t,
      jevUsd: round(t.jevUsd, 6),
      feesUsd: round(t.feesUsd, 6),
      realizedUsd: round(t.realizedUsd, 4),
      pnlUsd: round(t.pnlUsd, 4),
      pnlPct: round(t.pnlPct, 4),
    };
  }

  private emit(
    tick: number,
    book: BookView,
    decision: { action: Side | "hold"; probabilities: Record<"buy" | "sell" | "hold", number>; upIn10: number; latencyMs: number } | null,
    quote: Quote | null,
    late: boolean,
    timing?: { readMs: number; loopMs: number },
  ) {
    this.writeTotals(book.mid);
    const pd = this.instrument.priceDecimals;
    const event: TickEvent = {
      symbol: this.symbol,
      tick,
      block: tick,
      ts: Date.now(),
      mid: round(book.mid, pd),
      bestBid: round(book.bid, pd),
      bestAsk: round(book.ask, pd),
      spreadBps: round(book.spreadBps, 2),
      priceDecimals: pd,
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false },
      quote,
      fill: null,
      resting: this.restingView(),
      position: this.positionView(book.mid),
      totals: this.totalsView(),
      halted: this.opts.isKilled(),
    };
    this.history.push(event);
    if (this.history.length > this.opts.historySize) this.history.shift();
    if (this.opts.logFile) appendFileSync(this.opts.logFile, JSON.stringify(event) + "\n");
    this.opts.onEvent(event, timing);
  }
}

/** Fill size if this public print would have hit a resting post-only order. 0 otherwise. */
export function simHit(order: { side: Side; price: number; size: number; placedTs: number }, print: Print): number {
  if (print.ts <= order.placedTs || order.size <= 0) return 0;
  const hit = order.side === "buy" ? print.side === "sell" && print.price <= order.price : print.side === "buy" && print.price >= order.price;
  if (!hit) return 0;
  return Math.min(order.size, print.size);
}

function combineFill(a: Fill, b: Fill): Fill {
  const size = a.size + b.size;
  return {
    ...b,
    size: round(size, 8),
    price: (a.size * a.price + b.size * b.price) / size,
    feeUsd: a.feeUsd + b.feeUsd,
  };
}

function linkId(symbol: string, tick: number, n: number): string {
  const id = `${symbol.slice(0, 4)}${tick.toString(36)}${n.toString(36)}`;
  return id.slice(0, 36);
}

function alignNote(size: number, step: number): number {
  return Number((Math.floor(size / step + 1e-8) * step).toFixed(8));
}
