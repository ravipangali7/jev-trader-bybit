import type { Category, Side } from "../types.ts";
import { BybitError, BybitRest, RateLimiter } from "./rest.ts";
import { sign, wsSignPayload } from "./sign.ts";

export interface LiveOrder {
  symbol: string;
  side: Side;
  qty: string;
  price: string;
  orderLinkId: string;
}

export interface LiveExecution {
  symbol: string;
  side: Side;
  size: number;
  price: number;
  orderId: string;
  execId: string;
  fee: number;
  feeCurrency: string;
  ts: number;
}

export interface LiveOrderUpdate {
  symbol: string;
  orderId: string;
  orderStatus: string;
  rejectReason: string;
  leavesQty: number;
  side: Side;
  price: number;
}

interface ExecRow {
  symbol?: string;
  side?: string;
  execQty?: string;
  execPrice?: string;
  orderId?: string;
  execId?: string;
  execFee?: string;
  feeCurrency?: string;
  execType?: string;
  execTime?: string;
}

interface OrderRow {
  symbol?: string;
  orderId?: string;
  orderStatus?: string;
  rejectReason?: string;
  leavesQty?: string;
  side?: string;
  price?: string;
}

/**
 * Private order entry. REST places, amends, and cancels. The private WebSocket reports fills.
 * Every order request waits on the shared rate limiter.
 */
export class BybitVenue {
  readonly limiter: RateLimiter;
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private attempt = 0;

  onExecution: (e: LiveExecution) => void = () => {};
  onOrder: (o: LiveOrderUpdate) => void = () => {};

  constructor(
    private rest: BybitRest,
    private opts: {
      category: Category;
      apiKey: string;
      apiSecret: string;
      privateWs: string;
      positionIdx: number;
      maxOrdersPerSec: number;
    },
  ) {
    this.limiter = new RateLimiter(opts.maxOrdersPerSec);
  }

  startPrivateWs() {
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }

  async place(order: LiveOrder): Promise<{ orderId: string }> {
    await this.limiter.take();
    const body: Record<string, unknown> = {
      category: this.opts.category,
      symbol: order.symbol,
      side: order.side === "buy" ? "Buy" : "Sell",
      orderType: "Limit",
      qty: order.qty,
      price: order.price,
      timeInForce: "PostOnly",
      orderLinkId: order.orderLinkId,
    };
    if (this.opts.category === "linear") body.positionIdx = this.opts.positionIdx;
    const result = await this.rest.privatePost<{ orderId?: string }>("/v5/order/create", body);
    if (!result.orderId) throw new BybitError(-1, "Bybit create returned no orderId");
    return { orderId: result.orderId };
  }

  async amend(symbol: string, orderId: string, qty: string, price: string): Promise<void> {
    await this.limiter.take();
    await this.rest.privatePost("/v5/order/amend", {
      category: this.opts.category,
      symbol,
      orderId,
      qty,
      price,
    });
  }

  async cancel(symbol: string, orderId: string): Promise<void> {
    await this.limiter.take();
    try {
      await this.rest.privatePost("/v5/order/cancel", {
        category: this.opts.category,
        symbol,
        orderId,
      });
    } catch (e) {
      if (e instanceof BybitError && (e.retCode === 110001 || e.retCode === 170213)) return;
      throw e;
    }
  }

  async cancelAll(symbol: string): Promise<void> {
    await this.limiter.take();
    await this.rest.privatePost("/v5/order/cancel-all", {
      category: this.opts.category,
      symbol,
    });
  }

  async cancelAllSymbols(symbols: string[]): Promise<void> {
    for (const s of symbols) {
      try {
        await this.cancelAll(s);
      } catch (e) {
        console.error(`cancel-all ${s}:`, (e as Error).message);
      }
    }
  }

  /** Recent trades, newest first. Used to backfill a private-socket gap. */
  async recentExecutions(symbol: string): Promise<LiveExecution[]> {
    const result = await this.rest.privateGet<{ list?: ExecRow[] }>("/v5/execution/list", {
      category: this.opts.category,
      symbol,
      limit: "50",
    });
    const out: LiveExecution[] = [];
    for (const row of result.list ?? []) {
      const parsed = parseExec(row);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  async linearPosition(symbol: string): Promise<{ qty: number; entry: number } | null> {
    const result = await this.rest.privateGet<{ list?: { side?: string; size?: string; avgPrice?: string }[] }>(
      "/v5/position/list",
      { category: "linear", symbol },
    );
    const row = result.list?.[0];
    if (!row) return null;
    const size = Number(row.size ?? 0);
    if (!size) return { qty: 0, entry: 0 };
    const qty = row.side === "Sell" ? -size : size;
    return { qty, entry: Number(row.avgPrice ?? 0) };
  }

  async coinBalance(coin: string): Promise<number | null> {
    const result = await this.rest.privateGet<{
      list?: { totalAvailableBalance?: string; coin?: { coin?: string; walletBalance?: string; availableToWithdraw?: string }[] }[];
    }>("/v5/account/wallet-balance", { accountType: "UNIFIED" });
    const acc = result.list?.[0];
    if (!acc) return null;
    if (coin === "USDT" && acc.totalAvailableBalance) return Number(acc.totalAvailableBalance);
    const row = acc.coin?.find((c) => c.coin === coin);
    if (!row) return 0;
    const avail = row.availableToWithdraw && row.availableToWithdraw !== "" ? row.availableToWithdraw : row.walletBalance;
    return Number(avail ?? 0);
  }

  async feeRate(symbol: string): Promise<{ maker: number; taker: number } | null> {
    const result = await this.rest.privateGet<{ list?: { makerFeeRate?: string; takerFeeRate?: string }[] }>(
      "/v5/account/fee-rate",
      { category: this.opts.category, symbol },
    );
    const row = result.list?.[0];
    if (!row?.makerFeeRate || !row.takerFeeRate) return null;
    return { maker: Number(row.makerFeeRate), taker: Number(row.takerFeeRate) };
  }

  private connect() {
    const ws = new WebSocket(this.opts.privateWs);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      const expires = Date.now() + 10_000;
      const sig = sign(this.opts.apiSecret, wsSignPayload(expires));
      ws.send(JSON.stringify({ op: "auth", args: [this.opts.apiKey, expires, sig] }));
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
      }, 20_000);
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      if (this.closed) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt);
      this.attempt++;
      console.warn(`private websocket closed, retrying in ${delay}ms`);
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, delay);
    };
    ws.onerror = () => {};
  }

  private onMessage(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.op === "auth") {
      if (msg.success === false) {
        console.error(`Bybit private auth failed: ${String(msg.ret_msg ?? "unknown")}`);
        return;
      }
      this.ws?.send(JSON.stringify({ op: "subscribe", args: ["order", "execution", "position"] }));
      return;
    }
    if (msg.op) return;
    const topic = String(msg.topic ?? "");
    const rows = Array.isArray(msg.data) ? (msg.data as Record<string, unknown>[]) : [];
    if (topic === "execution") {
      for (const row of rows) {
        const parsed = parseExec(row as ExecRow);
        if (parsed) this.onExecution(parsed);
      }
    } else if (topic === "order") {
      for (const row of rows) {
        const parsed = parseOrder(row as OrderRow);
        if (parsed) this.onOrder(parsed);
      }
    }
  }
}

export function parseExec(row: ExecRow): LiveExecution | null {
  if (row.execType && row.execType !== "Trade") return null;
  const side = row.side === "Buy" ? "buy" : row.side === "Sell" ? "sell" : null;
  if (!side || !row.symbol || !row.execId) return null;
  const size = Number(row.execQty);
  const price = Number(row.execPrice);
  if (!(size > 0) || !(price > 0)) return null;
  return {
    symbol: row.symbol,
    side,
    size,
    price,
    orderId: row.orderId ?? "",
    execId: row.execId,
    fee: Number(row.execFee ?? 0),
    feeCurrency: row.feeCurrency ?? "USDT",
    ts: Number(row.execTime ?? 0),
  };
}

function parseOrder(row: OrderRow): LiveOrderUpdate | null {
  const side = row.side === "Buy" ? "buy" : row.side === "Sell" ? "sell" : null;
  if (!side || !row.symbol || !row.orderId) return null;
  return {
    symbol: row.symbol,
    orderId: row.orderId,
    orderStatus: row.orderStatus ?? "",
    rejectReason: row.rejectReason ?? "",
    leavesQty: Number(row.leavesQty ?? 0),
    side,
    price: Number(row.price ?? 0),
  };
}

const BALANCE_CODES = new Set([110004, 110007, 110012, 110014, 110045, 170131, 170132]);

export function isBalanceError(e: unknown): boolean {
  return e instanceof BybitError && BALANCE_CODES.has(e.retCode);
}

export function isMissingOrder(e: unknown): boolean {
  return e instanceof BybitError && (e.retCode === 110001 || e.retCode === 170213);
}
