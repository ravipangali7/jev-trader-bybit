import type { Category } from "./types.ts";

const env = process.env;

export interface SymbolSpec {
  symbol: string;
  /** Null means "use the exchange minimum that clears min notional". */
  size: number | null;
  insideTicks: number;
  /** Null means 10 times the order size, once that size is known. */
  maxPosition: number | null;
}

export function resolveDryRun(source: Record<string, string | undefined> = env): { dryRun: boolean; reason: string } {
  const keys = Boolean(source.BYBIT_API_KEY && source.BYBIT_API_SECRET);
  if (source.DRY_RUN === "false" && keys) return { dryRun: false, reason: "DRY_RUN=false and API keys are set" };
  if (source.DRY_RUN === "false" && !keys) return { dryRun: true, reason: "DRY_RUN=false but BYBIT_API_KEY or BYBIT_API_SECRET is missing, so this stays a dry run" };
  return { dryRun: true, reason: "DRY_RUN is not false" };
}

export function resolveCategory(raw: string | undefined): Category {
  if (!raw || raw === "linear") return "linear";
  if (raw === "spot") return "spot";
  throw new Error(`BYBIT_CATEGORY must be "linear" or "spot" (got ${raw})`);
}

export function parseSymbols(raw: string | undefined): string[] {
  const list = (raw ?? "SOLUSDT,XRPUSDT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!list.length) throw new Error("SYMBOLS is empty");
  for (const s of list) {
    if (!s.endsWith("USDT")) throw new Error(`${s} is not a USDT pair. This bot quotes USDT markets only.`);
  }
  return list;
}

function num(source: Record<string, string | undefined>, key: string): number | undefined {
  const v = source[key];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} is not a number`);
  return n;
}

function defaultSize(symbol: string): number | null {
  if (symbol === "SOLUSDT") return 0.1;
  if (symbol === "XRPUSDT") return 5;
  return null;
}

function defaultCap(symbol: string): number | null {
  if (symbol === "SOLUSDT") return 1;
  if (symbol === "XRPUSDT") return 50;
  return null;
}

export function symbolSpec(source: Record<string, string | undefined>, symbol: string): SymbolSpec {
  const size = num(source, `${symbol}_SIZE`) ?? num(source, "ORDER_SIZE") ?? defaultSize(symbol);
  const maxPosition = num(source, `${symbol}_MAX_POSITION`) ?? num(source, "MAX_POSITION") ?? defaultCap(symbol);
  const insideTicks = num(source, `${symbol}_INSIDE_TICKS`) ?? num(source, "QUOTE_INSIDE_TICKS") ?? 1;
  return { symbol, size: size ?? null, insideTicks, maxPosition: maxPosition ?? null };
}

export function restBase(testnet: boolean, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  return testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
}

export function publicWsUrl(testnet: boolean, category: Category, override?: string): string {
  if (override) return override;
  const host = testnet ? "stream-testnet.bybit.com" : "stream.bybit.com";
  return `wss://${host}/v5/public/${category}`;
}

export function privateWsUrl(testnet: boolean, override?: string): string {
  if (override) return override;
  const host = testnet ? "stream-testnet.bybit.com" : "stream.bybit.com";
  return `wss://${host}/v5/private`;
}

const mode = resolveDryRun(env);

export const config = {
  testnet: env.BYBIT_TESTNET === "true",
  category: resolveCategory(env.BYBIT_CATEGORY),
  apiKey: env.BYBIT_API_KEY ?? "",
  apiSecret: env.BYBIT_API_SECRET ?? "",
  dryRun: mode.dryRun,
  dryRunReason: mode.reason,
  symbols: parseSymbols(env.SYMBOLS),
  loopMs: Math.max(50, Number(env.LOOP_MS ?? "300")),
  horizonTicks: Math.max(1, Number(env.HORIZON_TICKS ?? "100")),
  bankrollUsd: Number(env.BANKROLL_USD ?? "100"),
  maxLossUsd: Number(env.MAX_LOSS_USD ?? "25"),
  maxOrdersPerSec: Math.max(1, Number(env.MAX_ORDERS_PER_SEC ?? "8")),
  orderbookDepth: Number(env.ORDERBOOK_DEPTH ?? "50"),
  positionIdx: Number(env.BYBIT_POSITION_IDX ?? "0"),
  makerFeeRate: env.MAKER_FEE_RATE !== undefined && env.MAKER_FEE_RATE !== "" ? Number(env.MAKER_FEE_RATE) : null,
  takerFeeRate: env.TAKER_FEE_RATE !== undefined && env.TAKER_FEE_RATE !== "" ? Number(env.TAKER_FEE_RATE) : null,
  model: (env.MODEL ?? "mock") as "mock" | "jev",
  jevModelId: env.JEV_MODEL_ID ?? "jev-latest",
  jevUsdPerMTok: 0.042,
  port: Number(env.PORT ?? "3000"),
  historySize: 1000,
  restUrl: restBase(env.BYBIT_TESTNET === "true", env.BYBIT_REST_URL),
  publicWs: publicWsUrl(env.BYBIT_TESTNET === "true", resolveCategory(env.BYBIT_CATEGORY), env.BYBIT_PUBLIC_WS_URL),
  privateWs: privateWsUrl(env.BYBIT_TESTNET === "true", env.BYBIT_PRIVATE_WS_URL),
};

export function specsFor(symbols: string[], source: Record<string, string | undefined> = env): SymbolSpec[] {
  return symbols.map((s) => symbolSpec(source, s));
}
