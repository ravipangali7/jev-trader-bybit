import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config.ts";
import type { Action } from "./types.ts";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: string;
  tick: number;
  /** The question is about the move over this many updates. */
  horizonTicks: number;
  intervalMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number;
  /** Cumulative resting base size within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string;
  /** Taker prints over the horizon. cvd = taker buy size - taker sell size. */
  trades: {
    count: number;
    buyQty: number;
    sellQty: number;
    cvd: number;
    vwap: number | null;
    lastPrice: number | null;
    lastSide: "buy" | "sell" | null;
  };
  recentTrades: string[];
  allowed: { buy: boolean; sell: boolean };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will the mid be higher or lower than now after `horizonTicks` more updates?",
      goal: "Quote this USDT pair on Bybit. Updates arrive about every `intervalMs` ms. One post-only limit order is placed on the side you choose, a few ticks inside the touch, and it earns the spread if a taker hits it. The horizon is `horizonTicks` updates (about 30 seconds at the default cadence).",
      timing: "The order rests on the book until the next update replaces it. It does not cross the spread.",
      inputs: "Taker flow is the strongest signal: `trades.cvd` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book. `depth` and `book` show resting liquidity per side at several distances from mid. Thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. If `allowed.buy` is false the order will be a sell regardless, and vice versa.",
    },
    criteria: {
      buy: "Buy now: mid more likely to be higher after `horizonTicks` updates.",
      sell: "Sell now: mid more likely to be lower after `horizonTicks` updates.",
    },
  },
} as const;

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. The SDK reads TYPESAFE_AI_API_KEY. */
export class JevModel implements Model {
  readonly name: string;
  private model;

  constructor(modelId = config.jevModelId) {
    this.name = modelId;
    this.model = typeSafeAi.evaluationModel(modelId);
  }

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as never, questions: QUESTIONS, maxRetries: 0 });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0;
    const sell = p.sell ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/** Deterministic stand-in: momentum + imbalance + taker flow, pulled around 50/50 so it trades both ways. */
export class MockModel implements Model {
  readonly name = "mock";
  /** Tests pass 0 to skip the inference stand-in. Production keeps 80ms so a slow model still shows up as late. */
  constructor(private sleepMs = 80) {}

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const flow = state.trades.buyQty + state.trades.sellQty ? state.trades.cvd / (state.trades.buyQty + state.trades.sellQty) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.tick);
    const buy = 1 / (1 + Math.exp(-signal));
    const probabilities = { buy, sell: 1 - buy, hold: 0 };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    if (this.sleepMs > 0) await Bun.sleep(this.sleepMs);
    return {
      action,
      probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(tick: number) {
    let h = (tick * 2654435761) >>> 0;
    h ^= h >>> 15;
    h = (h * 2246822519) >>> 0;
    h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
