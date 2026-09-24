import type { Category } from "../types.ts";

/**
 * Bybit's published non-VIP schedule, used until /v5/account/fee-rate returns the account's rates.
 * Linear USDT perps: maker 0.02%, taker 0.055%. Spot: 0.10% both sides.
 * A maker rebate comes back as a negative rate and reduces cost.
 */
export function scheduleFees(category: Category): { maker: number; taker: number } {
  if (category === "spot") return { maker: 0.001, taker: 0.001 };
  return { maker: 0.0002, taker: 0.00055 };
}

/** Fee in USDT. Quote-currency fees are already USDT. Base-currency fees are marked at the fill price. */
export function feeToUsd(fee: number, feeCurrency: string, fillPrice: number): number {
  if (!Number.isFinite(fee) || fee === 0) return 0;
  const c = feeCurrency.toUpperCase();
  if (c === "USDT" || c === "USDC" || c === "USD" || c === "") return fee;
  return fee * fillPrice;
}
