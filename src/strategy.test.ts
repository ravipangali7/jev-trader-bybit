import { expect, test } from "bun:test";
import { resolveDryRun } from "./config.ts";
import type { Model } from "./model.ts";
import { applyFill, flat, shouldKill } from "./pnl.ts";
import { simHit, SymbolTrader } from "./trader.ts";
import type { BookView, Instrument, Print, Quote, TradeSummary } from "./types.ts";
import { startServer } from "./server.ts";

const inst: Instrument = {
  symbol: "SOLUSDT", category: "linear", tickSize: 0.01, qtyStep: 0.1, minOrderQty: 0.1,
  maxOrderQty: 1000, minNotional: 5, priceDecimals: 2, qtyDecimals: 1, source: "exchange",
};

function book(bid = 100, ask = 100.05): BookView {
  const mid = (bid + ask) / 2;
  return {
    bid, ask, mid, spreadBps: ((ask - bid) / mid) * 10_000, imbalance: 0,
    levels: { bids: [[bid, 10]], asks: [[ask, 10]] },
    depthBps: { "10": { bid: 10, ask: 10 }, "25": { bid: 10, ask: 10 }, "50": { bid: 10, ask: 10 }, "100": { bid: 10, ask: 10 } },
  };
}

class FakeData {
  book = book();
  prints: Print[] = [];
  view() { return this.book; }
  drainPrints() { const p = this.prints; this.prints = []; return p; }
  summary(): TradeSummary { return { count: 0, buyQty: 0, sellQty: 0, cvd: 0, vwap: null, lastPrice: null, lastSide: null }; }
  recent() { return []; }
}

const buyModel: Model = {
  name: "buy",
  async decide() {
    return { action: "buy", probabilities: { buy: 0.8, sell: 0.2, hold: 0 }, upIn10: 0.8, latencyMs: 1, inputTokens: 10 };
  },
};

function make(data: FakeData, extra: { maxPosition?: number; maxLossUsd?: number; model?: Model } = {}) {
  let killed = false;
  let reason = "";
  const events: Quote[] = [];
  const box: { trader: SymbolTrader | null } = { trader: null };
  const trader = new SymbolTrader({
    spec: { symbol: "SOLUSDT", size: 0.1, insideTicks: 1, maxPosition: extra.maxPosition ?? 1 },
    instrument: inst,
    model: extra.model ?? buyModel,
    data,
    venue: null,
    loopMs: 300,
    horizonTicks: 100,
    bankrollUsd: 100,
    maxLossUsd: extra.maxLossUsd ?? 25,
    makerFee: 0.0002,
    jevUsdPerMTok: 0.042,
    historySize: 100,
    portfolioPnl: () => box.trader?.pnlUsd ?? 0,
    kill(r) { killed = true; reason = r; },
    isKilled: () => killed,
    onEvent: (e) => { if (e.quote) events.push(e.quote); },
    onFill: () => {},
  });
  box.trader = trader;
  return { trader, events, killed: () => killed, reason: () => reason };
}

test("dry run is the default and live requires keys plus DRY_RUN=false", () => {
  expect(resolveDryRun({}).dryRun).toBe(true);
  expect(resolveDryRun({ DRY_RUN: "true", BYBIT_API_KEY: "k", BYBIT_API_SECRET: "s" }).dryRun).toBe(true);
  expect(resolveDryRun({ DRY_RUN: "false" }).dryRun).toBe(true);
  expect(resolveDryRun({ DRY_RUN: "false", BYBIT_API_KEY: "k", BYBIT_API_SECRET: "s" }).dryRun).toBe(false);
});

test("a crossing public trade fills the simulated bid", async () => {
  const data = new FakeData();
  const { trader } = make(data);
  await trader.onTick();
  const quote = trader.history.at(-1)?.quote;
  expect(quote?.status).toBe("sim");
  expect(quote?.side).toBe("buy");
  expect(quote?.price).toBe(100.01);
  data.prints.push({ ts: Date.now() + 5_000, price: 100.01, size: 0.1, side: "sell", id: "t1" });
  await trader.onTick();
  expect(trader.positionQty).toBeCloseTo(0.1, 8);
  expect(trader.history.at(0)?.fill?.simulated).toBe(true);
  expect(trader.history.at(0)?.fill?.price).toBe(100.01);
});

test("position cap flips the quote to the reducing side", async () => {
  const data = new FakeData();
  const { trader } = make(data, { maxPosition: 0.1 });
  await trader.onTick();
  data.prints.push({ ts: Date.now() + 5_000, price: 100, size: 0.1, side: "sell", id: "t1" });
  await trader.onTick();
  const quote = trader.history.at(-1)?.quote;
  expect(quote?.side).toBe("sell");
  expect(quote?.capped).toBe(true);
  expect(trader.history.at(-1)?.decision?.probabilities.buy).toBe(0.8);
});

test("max loss cancels quoting", async () => {
  const data = new FakeData();
  const { trader, killed } = make(data, { maxLossUsd: 0.00001 });
  await trader.onTick();
  data.prints.push({ ts: Date.now() + 5_000, price: 100.01, size: 0.1, side: "sell", id: "t1" });
  data.book = book(90, 90.05);
  await trader.onTick();
  expect(killed()).toBe(true);
  const before = trader.history.length;
  await trader.onTick();
  expect(trader.history.length).toBe(before);
});

test("a tick that arrives while one is in flight is late", async () => {
  const data = new FakeData();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const model: Model = {
    name: "slow",
    async decide() {
      await gate;
      return { action: "buy", probabilities: { buy: 1, sell: 0, hold: 0 }, upIn10: 1, latencyMs: 1, inputTokens: 0 };
    },
  };
  const { trader } = make(data, { model });
  const first = trader.onTick();
  await Bun.sleep(20);
  await trader.onTick();
  release();
  await first;
  expect(trader.history.some((e) => e.decision?.late)).toBe(true);
});

test("simHit only fills when a later print crosses", () => {
  const order = { side: "buy" as const, price: 100, size: 1, placedTs: 1_000 };
  expect(simHit(order, { ts: 1_000, price: 100, size: 1, side: "sell", id: "a" })).toBe(0);
  expect(simHit(order, { ts: 1_001, price: 100, size: 0.4, side: "sell", id: "b" })).toBe(0.4);
  expect(simHit(order, { ts: 1_001, price: 100, size: 1, side: "buy", id: "c" })).toBe(0);
  expect(simHit({ side: "sell", price: 101, size: 2, placedTs: 1 }, { ts: 2, price: 101, size: 5, side: "buy", id: "d" })).toBe(2);
});

test("inventory accounting and the kill switch", () => {
  const inv = flat();
  expect(applyFill(inv, "buy", 2, 10)).toBe(0);
  expect(applyFill(inv, "sell", 2, 12)).toBeCloseTo(4, 8);
  expect(inv.qty).toBe(0);
  expect(shouldKill(-25, 25)).toBe(true);
  expect(shouldKill(-24.99, 25)).toBe(false);
  expect(shouldKill(1, 25)).toBe(false);
});

test("snapshot endpoint lists both symbols", async () => {
  const server = startServer(
    () => ({
      model: "mock", dryRun: true, testnet: false, category: "linear", symbols: ["SOLUSDT", "XRPUSDT"],
      startedAt: 1, killed: false, killReason: null, marketData: "live", wallet: null,
      fees: { maker: 0.0002, taker: 0.00055, source: "schedule" }, loopMs: 300,
    }),
    () => ({ SOLUSDT: [], XRPUSDT: [] }),
    0,
  );
  const res = await fetch(`http://127.0.0.1:${server.port}/`);
  const body = await res.json() as { dryRun: boolean; symbols: string[]; latest: Record<string, unknown> };
  expect(body.dryRun).toBe(true);
  expect(body.symbols).toEqual(["SOLUSDT", "XRPUSDT"]);
  expect(body.latest.SOLUSDT).toBeNull();
  server.stop();
});
