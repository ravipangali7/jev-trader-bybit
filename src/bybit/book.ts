import type { BookView, Print, Side, TradeSummary } from "../types.ts";

interface BookMsg {
  type?: string;
  data?: {
    s?: string;
    b?: [string, string][];
    a?: [string, string][];
    u?: number;
  };
}

/**
 * One symbol's Bybit order book. Snapshots replace both sides. Deltas with size 0 delete a level.
 * A delta whose update id is not the previous id plus one is a gap: the book is marked stale until
 * the next snapshot (the caller resubscribes to force one).
 */
export class LocalBook {
  readonly bids = new Map<string, string>();
  readonly asks = new Map<string, string>();
  u = 0;
  ready = false;
  /** Set when a delta was dropped. Cleared on the next snapshot. */
  gapped = false;

  apply(msg: BookMsg): "snapshot" | "delta" | "gap" | "ignore" {
    const data = msg.data;
    if (!data) return "ignore";
    const type = msg.type ?? "delta";
    if (type === "snapshot") {
      this.bids.clear();
      this.asks.clear();
      this.write(this.bids, data.b ?? []);
      this.write(this.asks, data.a ?? []);
      this.u = data.u ?? 0;
      this.ready = this.bids.size > 0 && this.asks.size > 0;
      this.gapped = false;
      return "snapshot";
    }
    if (!this.ready) return "ignore";
    const u = data.u ?? 0;
    if (this.u !== 0 && u !== this.u + 1) {
      this.ready = false;
      this.gapped = true;
      return "gap";
    }
    this.u = u;
    this.write(this.bids, data.b ?? []);
    this.write(this.asks, data.a ?? []);
    this.ready = this.bids.size > 0 && this.asks.size > 0;
    return "delta";
  }

  private write(side: Map<string, string>, levels: [string, string][]) {
    for (const [price, size] of levels) {
      if (!price) continue;
      if (Number(size) === 0) side.delete(price);
      else side.set(price, size);
    }
  }

  /** All levels as exchange strings, best-first. Used to infer tick and qty step. */
  rawLevels(): { bids: [string, string][]; asks: [string, string][] } {
    const bids = [...this.bids.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
    const asks = [...this.asks.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    return { bids, asks };
  }

  view(): BookView | null {
    if (!this.ready) return null;
    const bids = [...this.bids.entries()]
      .map(([p, s]) => [Number(p), Number(s)] as [number, number])
      .filter((l) => l[0] > 0 && l[1] > 0)
      .sort((a, b) => b[0] - a[0]);
    const asks = [...this.asks.entries()]
      .map(([p, s]) => [Number(p), Number(s)] as [number, number])
      .filter((l) => l[0] > 0 && l[1] > 0)
      .sort((a, b) => a[0] - b[0]);
    const bid = bids[0]?.[0];
    const ask = asks[0]?.[0];
    if (bid === undefined || ask === undefined || ask < bid) return null;
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
    const depthBps: BookView["depthBps"] = {};
    for (const bps of [10, 25, 50, 100]) {
      const band = (mid * bps) / 10_000;
      const bidSz = bids.filter((l) => mid - l[0] <= band).reduce((s, l) => s + l[1], 0);
      const askSz = asks.filter((l) => l[0] - mid <= band).reduce((s, l) => s + l[1], 0);
      depthBps[String(bps)] = { bid: bidSz, ask: askSz };
    }
    const near = depthBps["100"] ?? { bid: 0, ask: 0 };
    const denom = near.bid + near.ask;
    const imbalance = denom > 0 ? (near.bid - near.ask) / denom : 0;
    return {
      bid,
      ask,
      mid,
      spreadBps,
      imbalance,
      levels: { bids: bids.slice(0, 5), asks: asks.slice(0, 5) },
      depthBps,
    };
  }
}

const RING = 2000;

/** Public trades for one symbol. `drain` returns prints since the last drain. */
export class TradeTape {
  private prints: Print[] = [];
  private fresh: Print[] = [];

  push(p: Print) {
    this.prints.push(p);
    this.fresh.push(p);
    if (this.prints.length > RING) this.prints.splice(0, this.prints.length - RING);
  }

  drain(): Print[] {
    const out = this.fresh;
    this.fresh = [];
    return out;
  }

  summary(sinceTs: number): TradeSummary {
    let buy = 0, sell = 0, count = 0, notional = 0;
    let last: Print | null = null;
    for (const p of this.prints) {
      if (p.ts < sinceTs) continue;
      count++;
      if (p.side === "buy") buy += p.size;
      else sell += p.size;
      notional += p.size * p.price;
      last = p;
    }
    const vol = buy + sell;
    return {
      count,
      buyQty: buy,
      sellQty: sell,
      cvd: buy - sell,
      vwap: vol > 0 ? notional / vol : null,
      lastPrice: last?.price ?? null,
      lastSide: last?.side ?? null,
    };
  }

  recent(n: number): Print[] {
    return this.prints.slice(-n);
  }
}

export function takerSide(raw: string | undefined): Side | null {
  if (raw === "Buy") return "buy";
  if (raw === "Sell") return "sell";
  return null;
}
