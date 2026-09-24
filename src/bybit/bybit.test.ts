import { expect, test } from "bun:test";
import { LocalBook } from "./book.ts";
import { inferInstrument, parseInstrument } from "./instrument.ts";
import { minTradableQty, orderQty, quotePrice, snapStep } from "./num.ts";
import { restSignPayload, sign, wsSignPayload } from "./sign.ts";
import { feeToUsd, scheduleFees } from "./fees.ts";

test("quote price steps inside and clamps to the touch", () => {
  expect(quotePrice("buy", 100, 100.05, 0.01, 1)).toBe(100.01);
  expect(quotePrice("sell", 100, 100.05, 0.01, 1)).toBe(100.04);
  expect(quotePrice("buy", 100, 100.01, 0.01, 1)).toBe(100);
  expect(quotePrice("sell", 100, 100.01, 0.01, 1)).toBe(100.01);
  expect(quotePrice("buy", 1.5383, 1.5384, 0.0001, 1)).toBe(1.5383);
  expect(quotePrice("sell", 1.5383, 1.5384, 0.0001, 2)).toBe(1.5384);
});

test("qty aligns to the step and clears min notional", () => {
  expect(orderQty(0.15, 100, 0.1, 0.1, 1000, 5)).toBe(0.1);
  expect(minTradableQty(1.5, 0.1, 0.1, 5)).toBe(3.4);
  expect(orderQty(1, 1.5, 0.1, 0.1, 1000, 5)).toBe(3.4);
});

test("snapStep lands on a decimal tick", () => {
  expect(snapStep(0.01)).toBe(0.01);
  expect(snapStep(0.0001)).toBe(0.0001);
  expect(snapStep(1.5384 - 1.5383)).toBe(0.0001);
});

test("book snapshot, delta, delete, and gap", () => {
  const book = new LocalBook();
  const snapBids: [string, string][] = [["100", "1"], ["99", "2"]];
  const snapAsks: [string, string][] = [["101", "1.5"], ["102", "3"]];
  expect(book.apply({ type: "snapshot", data: { b: snapBids, a: snapAsks, u: 10 } })).toBe("snapshot");
  const view = book.view();
  expect(view?.bid).toBe(100);
  expect(view?.ask).toBe(101);
  const deltaBids: [string, string][] = [["100", "0"], ["100.5", "4"]];
  expect(book.apply({ type: "delta", data: { b: deltaBids, a: [], u: 11 } })).toBe("delta");
  expect(book.view()?.bid).toBe(100.5);
  expect(book.apply({ type: "delta", data: { b: [], a: [], u: 13 } })).toBe("gap");
  expect(book.ready).toBe(false);
});

test("infer filters from a live-shaped book", () => {
  const sol = inferInstrument("linear", "SOLUSDT", [
    ["117.020", "79.3"], ["117.010", "153.7"], ["117.000", "386.0"],
  ], [
    ["117.030", "325.1"], ["117.040", "444.1"],
  ]);
  expect(sol?.tickSize).toBe(0.01);
  expect(sol?.qtyStep).toBe(0.1);
  expect(sol?.minOrderQty).toBe(0.1);
  expect(sol?.source).toBe("book");

  const xrp = inferInstrument("linear", "XRPUSDT", [
    ["1.5383", "16278.8"], ["1.5382", "853.3"],
  ], [
    ["1.5384", "136.9"], ["1.5385", "20.2"],
  ]);
  expect(xrp?.tickSize).toBe(0.0001);
  expect(xrp?.qtyStep).toBe(0.1);
});

test("parse instruments-info for linear and spot", () => {
  const linear = parseInstrument("linear", {
    symbol: "SOLUSDT",
    priceFilter: { tickSize: "0.010" },
    lotSizeFilter: { qtyStep: "0.1", minOrderQty: "0.1", maxOrderQty: "5000", minNotionalValue: "5" },
  });
  expect(linear.tickSize).toBe(0.01);
  expect(linear.qtyStep).toBe(0.1);
  expect(linear.minNotional).toBe(5);
  expect(linear.priceDecimals).toBe(2);

  const spot = parseInstrument("spot", {
    symbol: "XRPUSDT",
    priceFilter: { tickSize: "0.0001" },
    lotSizeFilter: { basePrecision: "0.01", minOrderQty: "0.1", maxOrderQty: "100000", minOrderAmt: "1" },
  });
  expect(spot.qtyStep).toBe(0.01);
  expect(spot.minNotional).toBe(1);
});

test("rest and private websocket signatures", () => {
  const payload = restSignPayload("1658384431891", "XXXXXXXXXX", "5000", "category=linear&symbol=SOLUSDT");
  expect(sign("test-secret", payload)).toBe("54e871555ee4072c70301d3875d25a9925c60cbe19ee3e8901d164a55474233f");
  expect(sign("test-secret", wsSignPayload(1658384431891))).toBe("b6d2f2e3b157ae528491668fa49526e44e5de01a6752ee451e832456fddfca2d");
});

test("fee schedule and currency conversion", () => {
  expect(scheduleFees("linear")).toEqual({ maker: 0.0002, taker: 0.00055 });
  expect(scheduleFees("spot").maker).toBe(0.001);
  expect(feeToUsd(0.02, "USDT", 100)).toBe(0.02);
  expect(feeToUsd(0.01, "SOL", 100)).toBe(1);
});
