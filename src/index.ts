import { buildMetrics, replayFills, type MetricInput } from "./account.ts";
import { config, specsFor, symbolStartUsd } from "./config.ts";
import { scheduleFees } from "./bybit/fees.ts";
import { inferInstrument, parseInstrument } from "./bybit/instrument.ts";
import { PublicFeed, waitForBooks } from "./bybit/public.ts";
import { BybitRest } from "./bybit/rest.ts";
import { BybitVenue } from "./bybit/venue.ts";
import { createModel } from "./model.ts";
import { startServer } from "./server.ts";
import { PaperStore, type EquityRow } from "./store.ts";
import { SymbolTrader } from "./trader.ts";
import type { BookView, Fill, Instrument, Meta, Print, Side, TickEvent } from "./types.ts";

const specs = specsFor(config.symbols);
const model = createModel();
const rest = new BybitRest({ base: config.restUrl, apiKey: config.apiKey, apiSecret: config.apiSecret });
const feed = new PublicFeed({ url: config.publicWs, symbols: config.symbols, depth: validDepth(config.category, config.orderbookDepth) });

const schedule = scheduleFees(config.category);
let makerFee = config.makerFeeRate ?? schedule.maker;
let takerFee = config.takerFeeRate ?? schedule.taker;
let feeSource = config.makerFeeRate !== null ? "env" : "schedule";

const risk = { killed: false, reason: null as string | null };
const marketData = () => feed.status;

const traders = new Map<string, SymbolTrader>();
let venue: BybitVenue | null = null;
const balances = { usdt: null as number | null, base: new Map<string, number>() };

function portfolioPnl() {
  let n = 0;
  for (const t of traders.values()) n += t.pnlUsd;
  return n;
}

function meta(): Meta {
  return {
    model: model.name,
    dryRun: config.dryRun,
    testnet: config.testnet,
    category: config.category,
    symbols: config.symbols,
    startedAt,
    killed: risk.killed,
    killReason: risk.reason,
    marketData: marketData(),
    wallet: config.dryRun ? null : "bybit",
    fees: { maker: makerFee, taker: takerFee, source: feeSource },
    loopMs: config.loopMs,
  };
}

const store = new PaperStore(config.paperDb);
if (config.resetPaper) {
  console.warn(`RESET_PAPER=true, wiping ${config.paperDb}`);
  store.reset();
}
const startedAt = store.startedAt();
const starts = new Map(config.symbols.map((s) => [s, symbolStartUsd(process.env, s)]));

function emptyInput(startUsd: number): MetricInput {
  return {
    startUsd, fills: 0, roundTrips: 0, wins: 0, realizedUsd: 0, unrealizedUsd: 0, feesUsd: 0, positionQty: 0, peakEquityUsd: startUsd,
  };
}

function metricsFor(symbol: string) {
  const trader = traders.get(symbol);
  const start = starts.get(symbol) ?? 100;
  const mid = data.view(symbol)?.mid ?? 0;
  const view = trader?.accountView(mid) ?? emptyInput(start);
  const equity = start + view.realizedUsd + view.unrealizedUsd - view.feesUsd;
  const peak = Math.max(store.peak(symbol), store.maxEquity(symbol), equity, start);
  store.setPeak(symbol, peak);
  return buildMetrics({ ...view, startUsd: start, peakEquityUsd: peak });
}

function combinedMetrics() {
  const parts = config.symbols.map((s) => metricsFor(s));
  const sum = (pick: (m: MetricInput) => number) => parts.reduce((n, m) => n + pick(m), 0);
  const equity = sum((m) => m.startUsd + m.realizedUsd + m.unrealizedUsd - m.feesUsd);
  const start = sum((m) => m.startUsd);
  const peak = Math.max(store.peak("COMBINED"), store.maxEquity("COMBINED"), equity, start);
  store.setPeak("COMBINED", peak);
  return buildMetrics({
    startUsd: start,
    fills: sum((m) => m.fills),
    roundTrips: sum((m) => m.roundTrips),
    wins: sum((m) => m.wins),
    realizedUsd: sum((m) => m.realizedUsd),
    unrealizedUsd: sum((m) => m.unrealizedUsd),
    feesUsd: sum((m) => m.feesUsd),
    positionQty: 0,
    peakEquityUsd: peak,
  });
}

function equityRow(symbol: string, input: MetricInput, ts: number): EquityRow {
  const m = buildMetrics(input);
  return {
    symbol, ts,
    equityUsd: m.equityUsd,
    realizedUsd: m.realizedUsd,
    unrealizedUsd: m.unrealizedUsd,
    feesUsd: m.feesUsd,
    positionQty: m.positionQty,
    pnlUsd: m.pnlUsd,
  };
}

function snapshotEquity(ts = Date.now()) {
  let start = 0;
  let realized = 0;
  let unreal = 0;
  let fees = 0;
  let pnl = 0;
  let equity = 0;
  let ready = 0;
  for (const symbol of config.symbols) {
    const trader = traders.get(symbol);
    if (!trader) continue;
    const mid = data.view(symbol)?.mid ?? 0;
    if (!(mid > 0) && trader.accountView().fills === 0) continue;
    const view = trader.accountView(mid);
    const row = equityRow(symbol, { ...view, peakEquityUsd: store.peak(symbol) }, ts);
    store.insertEquity(row);
    store.setPeak(symbol, Math.max(store.peak(symbol), row.equityUsd));
    start += view.startUsd;
    realized += view.realizedUsd;
    unreal += view.unrealizedUsd;
    fees += view.feesUsd;
    pnl += row.pnlUsd;
    equity += row.equityUsd;
    ready++;
  }
  if (ready === 0) return;
  store.insertEquity({
    symbol: "COMBINED", ts, equityUsd: equity, realizedUsd: realized, unrealizedUsd: unreal, feesUsd: fees, positionQty: 0, pnlUsd: pnl,
  });
  store.setPeak("COMBINED", Math.max(store.peak("COMBINED"), equity, start));
}

const server = startServer(meta, () => {
  const out: Record<string, TickEvent[]> = {};
  for (const s of config.symbols) out[s] = traders.get(s)?.history ?? [];
  return out;
}, config.port, {
  summary: () => ({ startedAt, runMs: Date.now() - startedAt, symbols: Object.fromEntries(config.symbols.map((s) => [s, metricsFor(s)])), combined: combinedMetrics() }),
  trades: (opts) => store.trades(opts),
  equity: () => {
    const out: Record<string, EquityRow[]> = { COMBINED: store.equitySeries("COMBINED") };
    for (const s of config.symbols) out[s] = store.equitySeries(s);
    return out;
  },
});

function kill(reason: string) {
  if (risk.killed) return;
  risk.killed = true;
  risk.reason = reason;
  console.error(`HALT ${reason}`);
  server.broadcastStatus();
  if (venue) void venue.cancelAllSymbols(config.symbols);
}

function fundsOk(symbol: string, side: Side, qty: number, price: number): boolean {
  if (config.category === "linear") {
    if (balances.usdt === null) return true;
    return balances.usdt >= qty * price;
  }
  if (side === "buy") {
    if (balances.usdt === null) return true;
    return balances.usdt >= qty * price;
  }
  const base = balances.base.get(symbol);
  if (base === undefined) return true;
  return base >= qty;
}

const data = {
  view(symbol: string): BookView | null {
    return feed.book(symbol)?.view() ?? null;
  },
  drainPrints(symbol: string): Print[] {
    return feed.tapes.get(symbol)?.drain() ?? [];
  },
  summary(symbol: string, sinceTs: number) {
    return feed.tapes.get(symbol)?.summary(sinceTs) ?? { count: 0, buyQty: 0, sellQty: 0, cvd: 0, vwap: null, lastPrice: null, lastSide: null };
  },
  recent(symbol: string, n: number): Print[] {
    return feed.tapes.get(symbol)?.recent(n) ?? [];
  },
};

function logTick(e: TickEvent, timing?: { readMs: number; loopMs: number }) {
  server.broadcast(e);
  if (!e.decision || e.decision.late) {
    if (e.decision?.late) console.log(`${e.symbol} #${e.tick} late`);
    return;
  }
  const p = e.decision.probabilities;
  const q = e.quote;
  const px = e.priceDecimals;
  const quote = !q
    ? " no quote"
    : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(px)}${q.capped ? " capped" : ""} (${q.status})`;
  const loop = timing ? ` loop ${timing.loopMs}ms` : "";
  console.log(`${e.symbol} #${e.tick} ${e.mid.toFixed(px)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd.toFixed(4)}${loop}`);
}

function onFill(symbol: string, tick: number, fill: Fill) {
  server.broadcastFill(symbol, tick, fill);
  console.log(`${symbol} #${tick} FILL ${fill.side} ${fill.size} @ ${fill.price}${fill.simulated ? " (sim)" : ` fee $${fill.feeUsd.toFixed(4)}`}`);
}

async function loadInstrument(symbol: string): Promise<Instrument | null> {
  try {
    const result = await rest.publicGet<{ list?: Record<string, unknown>[] }>("/v5/market/instruments-info", {
      category: config.category,
      symbol,
    });
    const row = result.list?.find((r) => r.symbol === symbol) ?? result.list?.[0];
    if (!row) throw new Error("empty list");
    return parseInstrument(config.category, row);
  } catch (e) {
    console.warn(`${symbol} instruments-info: ${(e as Error).message}`);
    return null;
  }
}

function infer(symbol: string): Instrument | null {
  const raw = feed.book(symbol)?.rawLevels();
  if (!raw) return null;
  return inferInstrument(config.category, symbol, raw.bids, raw.asks);
}

async function main() {
  const where = config.testnet ? "testnet" : "mainnet";
  console.log(`jev-trader | Bybit ${config.category} ${where} | ${config.symbols.join(" ")} | ${config.dryRun ? "DRY RUN" : "LIVE"} | model ${model.name} | loop ${config.loopMs}ms | :${server.port} | paper ${config.paperDb}`);
  console.log(config.dryRunReason);
  if (!config.dryRun && !config.testnet) console.log("LIVE mainnet orders are enabled");
  if (!config.dryRun && config.testnet) console.log("LIVE testnet orders are enabled");

  feed.start();
  await waitForBooks(feed, 15_000);
  console.log(`books live | ${config.symbols.map((s) => {
    const b = feed.book(s)?.view();
    return b ? `${s} ${b.bid}/${b.ask}` : s;
  }).join(" | ")}`);

  const instruments = new Map<string, Instrument>();
  for (const symbol of config.symbols) {
    let inst = await loadInstrument(symbol);
    if (!inst) {
      if (!config.dryRun) {
        console.error(`refusing to trade ${symbol} live without instruments-info. Check BYBIT_REST_URL and network access.`);
        process.exit(1);
      }
      inst = infer(symbol);
      if (!inst) {
        console.error(`${symbol} has no instrument filters and the book could not supply them`);
        process.exit(1);
      }
      console.warn(`${symbol} filters inferred from the book (tick ${inst.tickSize}, qty step ${inst.qtyStep}, min qty ${inst.minOrderQty}, min notional ${inst.minNotional} assumed). Replace when instruments-info is reachable.`);
    } else {
      console.log(`${symbol} tick ${inst.tickSize} qty step ${inst.qtyStep} min ${inst.minOrderQty} min notional ${inst.minNotional}`);
    }
    instruments.set(symbol, inst);
  }

  if (!config.dryRun) {
    venue = new BybitVenue(rest, {
      category: config.category,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      privateWs: config.privateWs,
      positionIdx: config.positionIdx,
      maxOrdersPerSec: config.maxOrdersPerSec,
    });
    if (config.makerFeeRate === null) {
      const sample = config.symbols[0];
      if (sample) {
        const rates = await venue.feeRate(sample).catch((e) => {
          console.warn(`fee-rate: ${(e as Error).message}`);
          return null;
        });
        if (rates) {
          makerFee = rates.maker;
          takerFee = config.takerFeeRate ?? rates.taker;
          feeSource = "account";
          console.log(`account fees maker ${makerFee} taker ${takerFee}`);
        }
      }
    }
    venue.onExecution = (ex) => traders.get(ex.symbol)?.onLiveFill(ex);
    venue.onOrder = (o) => traders.get(o.symbol)?.onOrderUpdate(o);
    venue.startPrivateWs();
    console.log("cancelling leftover open orders");
    await venue.cancelAllSymbols(config.symbols);
  }

  for (const spec of specs) {
    const inst = instruments.get(spec.symbol)!;
    const trader = new SymbolTrader({
      spec,
      instrument: inst,
      model,
      data,
      venue,
      loopMs: config.loopMs,
      horizonTicks: config.horizonTicks,
      bankrollUsd: config.bankrollUsd,
      maxLossUsd: config.maxLossUsd,
      makerFee,
      jevUsdPerMTok: config.jevUsdPerMTok,
      historySize: config.historySize,
      portfolioPnl,
      kill,
      isKilled: () => risk.killed,
      onEvent: logTick,
      onFill: (tick, fill) => onFill(spec.symbol, tick, fill),
      onAccountFill: (row) => {
        store.insertTrade(row);
        store.setPeak(row.symbol, row.equityUsd);
      },
      startUsd: starts.get(spec.symbol) ?? 100,
      leverage: config.leverage,
      modelTimeoutMs: config.modelTimeoutMs,
      funds: config.dryRun ? undefined : (side, qty, price) => fundsOk(spec.symbol, side, qty, price),
      logFile: "data/events.jsonl",
    });
    const prior = replayFills(store.allTrades(spec.symbol));
    if (prior.fills > 0) {
      trader.restore(prior);
      console.log(`${spec.symbol} restored ${prior.fills} fills, position ${prior.qty}, realized $${prior.realizedUsd.toFixed(4)}, fees $${prior.feesUsd.toFixed(4)}`);
    }
    traders.set(spec.symbol, trader);
  }

  if (venue && config.category === "linear") {
    for (const symbol of config.symbols) {
      const pos = await venue.linearPosition(symbol).catch((e) => {
        console.warn(`${symbol} position: ${(e as Error).message}`);
        return null;
      });
      if (pos && pos.qty) {
        traders.get(symbol)?.seed(pos.qty, pos.entry);
        console.log(`${symbol} seeded position ${pos.qty} @ ${pos.entry}`);
      }
    }
  }
  if (venue && config.category === "spot") {
    for (const symbol of config.symbols) {
      const base = symbol.slice(0, -4);
      const qty = await venue.coinBalance(base).catch(() => null);
      if (qty && qty > 0) {
        const mid = feed.book(symbol)?.view()?.mid ?? 0;
        traders.get(symbol)?.seed(qty, mid);
        balances.base.set(symbol, qty);
        console.log(`${symbol} seeded spot balance ${qty} ${base}`);
      }
    }
  }

  for (const t of traders.values()) t.startedAt = startedAt;
  snapshotEquity();

  const stagger = Math.floor(config.loopMs / Math.max(1, config.symbols.length));
  config.symbols.forEach((symbol, i) => {
    const trader = traders.get(symbol)!;
    setTimeout(() => {
      setInterval(() => {
        trader.onTick().catch((e) => console.error(`${symbol}:`, (e as Error).message));
      }, config.loopMs);
    }, i * stagger);
  });

  setInterval(() => server.broadcastStatus(), 5_000);
  setInterval(() => {
    try {
      snapshotEquity();
    } catch (e) {
      console.error("equity snapshot:", (e as Error).message);
    }
  }, config.equitySnapshotMs);

  if (config.dryRun) {
    setInterval(() => {
      for (const symbol of config.symbols) {
        const trader = traders.get(symbol);
        if (!trader || trader.instrument.source === "exchange") continue;
        void loadInstrument(symbol).then((inst) => {
          if (!inst) return;
          console.log(`${symbol} instruments-info recovered, tick ${inst.tickSize} qty step ${inst.qtyStep}`);
          trader.updateInstrument(inst);
        });
      }
    }, 60_000);
  }

  if (venue) {
    const refreshBalances = async () => {
      const usdt = await venue!.coinBalance("USDT").catch(() => null);
      if (usdt !== null) balances.usdt = usdt;
      if (config.category === "spot") {
        for (const symbol of config.symbols) {
          const qty = await venue!.coinBalance(symbol.slice(0, -4)).catch(() => null);
          if (qty !== null) balances.base.set(symbol, qty);
        }
      }
    };
    await refreshBalances().catch(() => {});
    setInterval(() => {
      void refreshBalances();
      for (const symbol of config.symbols) {
        void venue!.recentExecutions(symbol).then((rows) => {
          for (const row of rows) traders.get(symbol)?.onLiveFill(row);
        }).catch(() => {});
      }
    }, 15_000);
  }
}

function validDepth(category: string, depth: number): number {
  const ok = category === "spot" ? [1, 50, 200, 1000] : [1, 50, 200, 500, 1000];
  if (ok.includes(depth)) return depth;
  console.warn(`ORDERBOOK_DEPTH ${depth} is not valid for ${category}, using 50`);
  return 50;
}

let shutting = false;
async function shutdown(sig: string) {
  if (shutting) return;
  shutting = true;
  risk.killed = true;
  console.log(`${sig}: cancelling open orders`);
  feed.stop();
  try {
    snapshotEquity();
  } catch (e) {
    console.error("equity snapshot:", (e as Error).message);
  }
  if (venue) await venue.cancelAllSymbols(config.symbols);
  venue?.stop();
  server.stop();
  store.close();
  process.exit(0);
}

process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err instanceof Error ? err.message : err);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await main();
