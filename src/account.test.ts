import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetrics, closeNet, closingSize, equityUsd, replayFills, type AccountFill } from "./account.ts";
import { symbolSpec, symbolStartUsd } from "./config.ts";
import { PaperStore } from "./store.ts";
import { startServer } from "./server.ts";

function fill(partial: Partial<AccountFill> & Pick<AccountFill, "side" | "size" | "price">): AccountFill {
  return {
    symbol: "SOLUSDT",
    ts: 1,
    feeUsd: 0,
    realizedUsd: 0,
    positionQty: 0,
    equityUsd: 100,
    simulated: true,
    orderId: null,
    execId: null,
    ...partial,
  };
}

test("equity is start plus realized plus unrealized minus fees", () => {
  expect(equityUsd(100, 2, -1, 0.5)).toBeCloseTo(100.5, 8);
  const m = buildMetrics({
    startUsd: 100, fills: 2, roundTrips: 1, wins: 1, realizedUsd: 2, unrealizedUsd: -1, feesUsd: 0.5, positionQty: 0.1, peakEquityUsd: 103,
  });
  expect(m.equityUsd).toBeCloseTo(100.5, 8);
  expect(m.pnlUsd).toBeCloseTo(0.5, 8);
  expect(m.roiPct).toBeCloseTo(0.5, 8);
  expect(m.drawdownUsd).toBeCloseTo(2.5, 8);
  expect(m.drawdownPct).toBeCloseTo((2.5 / 103) * 100, 6);
  expect(m.winRate).toBe(1);
});

test("a round trip wins only when net of the fee share is positive", () => {
  expect(closingSize(0.1, "sell", 0.1)).toBeCloseTo(0.1, 8);
  expect(closingSize(0.1, "buy", 0.1)).toBe(0);
  expect(closeNet(0.01, 0.02, 0.1, 0.1)).toBeCloseTo(-0.01, 8);
  const replay = replayFills([
    fill({ side: "buy", size: 0.1, price: 100, feeUsd: 0.002, execId: "a" }),
    fill({ side: "sell", size: 0.1, price: 101, feeUsd: 0.002, execId: "b" }),
  ]);
  expect(replay.qty).toBe(0);
  expect(replay.realizedUsd).toBeCloseTo(0.1, 8);
  expect(replay.roundTrips).toBe(1);
  expect(replay.wins).toBe(1);
  expect(replay.execIds).toEqual(["a", "b"]);
});

test("combined drawdown uses the combined peak", () => {
  const m = buildMetrics({
    startUsd: 200, fills: 4, roundTrips: 0, wins: 0, realizedUsd: 0, unrealizedUsd: -20, feesUsd: 1, positionQty: 0, peakEquityUsd: 210,
  });
  expect(m.equityUsd).toBeCloseTo(179, 8);
  expect(m.drawdownUsd).toBeCloseTo(31, 8);
  expect(m.winRate).toBeNull();
});

test("starting balances default to 100 and the position cap is opt-in", () => {
  expect(symbolStartUsd({}, "SOLUSDT")).toBe(100);
  expect(symbolStartUsd({ SOLUSDT_START_USD: "250" }, "SOLUSDT")).toBe(250);
  expect(symbolStartUsd({ BANKROLL_USD: "80" }, "XRPUSDT")).toBe(80);
  expect(symbolSpec({}, "SOLUSDT")).toEqual({ symbol: "SOLUSDT", size: 0.1, insideTicks: 1, maxPosition: null });
  expect(symbolSpec({}, "XRPUSDT").size).toBe(5);
  expect(symbolSpec({ SOLUSDT_MAX_POSITION: "0.2" }, "SOLUSDT").maxPosition).toBe(0.2);
});

test("sqlite keeps fills and equity across a reopen, and reset clears them", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-"));
  const path = join(dir, "paper.sqlite");
  const first = new PaperStore(path);
  const started = first.startedAt();
  first.insertTrade(fill({ side: "buy", size: 0.1, price: 100, feeUsd: 0.002, positionQty: 0.1, equityUsd: 99.8, execId: "e1" }));
  first.insertEquity({ symbol: "SOLUSDT", ts: 10, equityUsd: 99.8, realizedUsd: 0, unrealizedUsd: 0, feesUsd: 0.002, positionQty: 0.1, pnlUsd: -0.002 });
  first.insertEquity({ symbol: "COMBINED", ts: 10, equityUsd: 199.8, realizedUsd: 0, unrealizedUsd: 0, feesUsd: 0.002, positionQty: 0, pnlUsd: -0.002 });
  first.setPeak("SOLUSDT", 100);
  first.close();

  const second = new PaperStore(path);
  expect(second.startedAt()).toBe(started);
  const loaded = second.allTrades("SOLUSDT");
  expect(loaded).toHaveLength(1);
  expect(loaded[0]?.execId).toBe("e1");
  expect(replayFills(loaded).qty).toBeCloseTo(0.1, 8);
  expect(second.equitySeries("COMBINED")).toHaveLength(1);
  expect(second.peak("SOLUSDT")).toBe(100);
  const page = second.trades({ limit: 10, offset: 0 });
  expect(page.total).toBe(1);
  expect(page.trades[0]?.side).toBe("buy");
  second.reset();
  expect(second.allTrades()).toHaveLength(0);
  expect(second.getMeta("started_at")).toBeNull();
  second.close();
});

test("summary, trades, and equity endpoints", async () => {
  const metrics = buildMetrics({
    startUsd: 100, fills: 1, roundTrips: 0, wins: 0, realizedUsd: 0, unrealizedUsd: 0.2, feesUsd: 0.01, positionQty: 0.1, peakEquityUsd: 100.2,
  });
  const server = startServer(
    () => ({
      model: "mock", dryRun: true, testnet: false, category: "linear", symbols: ["SOLUSDT"],
      startedAt: 1_000, killed: false, killReason: null, marketData: "live", wallet: null,
      fees: { maker: 0.0002, taker: 0.00055, source: "schedule" }, loopMs: 300,
    }),
    () => ({ SOLUSDT: [] }),
    0,
    {
      summary: () => ({ startedAt: 1_000, runMs: 5_000, symbols: { SOLUSDT: metrics }, combined: metrics }),
      trades: () => ({ trades: [fill({ side: "buy", size: 0.1, price: 100 })], total: 1 }),
      equity: () => ({ SOLUSDT: [], COMBINED: [] }),
    },
  );
  const summary = await (await fetch(`http://127.0.0.1:${server.port}/summary`)).json() as { runMs: number; symbols: { SOLUSDT: { equityUsd: number } } };
  expect(summary.runMs).toBe(5_000);
  expect(summary.symbols.SOLUSDT.equityUsd).toBeCloseTo(100.19, 6);
  const trades = await (await fetch(`http://127.0.0.1:${server.port}/trades?limit=10`)).json() as { total: number };
  expect(trades.total).toBe(1);
  const equity = await (await fetch(`http://127.0.0.1:${server.port}/equity`)).json() as { COMBINED: unknown[] };
  expect(equity.COMBINED).toEqual([]);
  server.stop();
});
