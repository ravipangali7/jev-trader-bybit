import { LocalBook, TradeTape, takerSide } from "./book.ts";
import type { Print } from "../types.ts";

interface TradeRow {
  T?: number;
  s?: string;
  S?: string;
  v?: string;
  p?: string;
  i?: string;
}

/**
 * Public market data for every symbol on one WebSocket.
 * Order book (snapshot + delta) and public trades. No API key.
 * Bybit closes a socket that never pings, so we ping every 20s.
 */
export class PublicFeed {
  readonly books = new Map<string, LocalBook>();
  readonly tapes = new Map<string, TradeTape>();
  status: "connecting" | "live" | "reconnecting" = "connecting";
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private attempt = 0;
  private seen = new Set<string>();

  constructor(
    private opts: { url: string; symbols: string[]; depth: number },
  ) {
    for (const s of opts.symbols) {
      this.books.set(s, new LocalBook());
      this.tapes.set(s, new TradeTape());
    }
  }

  start() {
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }

  book(symbol: string): LocalBook | undefined {
    return this.books.get(symbol);
  }

  ready(symbols = this.opts.symbols): boolean {
    return symbols.every((s) => this.books.get(s)?.ready);
  }

  private connect() {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.status = "live";
      this.seen.clear();
      const depth = this.opts.depth;
      const args = this.opts.symbols.flatMap((s) => [`orderbook.${depth}.${s}`, `publicTrade.${s}`]);
      ws.send(JSON.stringify({ op: "subscribe", args }));
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
      }, 20_000);
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => this.onDown();
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private onDown() {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    for (const b of this.books.values()) b.ready = false;
    if (this.closed) return;
    this.status = "reconnecting";
    const delay = Math.min(10_000, 500 * 2 ** this.attempt);
    this.attempt++;
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  private resubscribe(symbol: string) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const topic = `orderbook.${this.opts.depth}.${symbol}`;
    ws.send(JSON.stringify({ op: "unsubscribe", args: [topic] }));
    ws.send(JSON.stringify({ op: "subscribe", args: [topic] }));
  }

  private onMessage(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.op === "ping") {
      this.ws?.send(JSON.stringify({ op: "pong" }));
      return;
    }
    if (msg.op) return;
    const topic = String(msg.topic ?? "");
    if (topic.startsWith("orderbook.")) {
      const book = this.bookOfTopic(topic);
      if (!book) return;
      const result = book.apply(msg as { type?: string; data?: { s?: string; b?: [string, string][]; a?: [string, string][]; u?: number } });
      if (result === "gap") {
        const symbol = topic.split(".").pop() ?? "";
        console.warn(`${symbol} order book gap, resubscribing`);
        this.resubscribe(symbol);
      }
      return;
    }
    if (topic.startsWith("publicTrade.")) {
      const rows = Array.isArray(msg.data) ? (msg.data as TradeRow[]) : [];
      for (const row of rows) {
        const symbol = row.s ?? topic.split(".").pop() ?? "";
        const tape = this.tapes.get(symbol);
        const side = takerSide(row.S);
        if (!tape || !side || !row.p || !row.v) continue;
        const id = row.i ?? `${row.T}-${row.p}-${row.v}`;
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        if (this.seen.size > 5000) this.seen.clear();
        const print: Print = {
          ts: Number(row.T ?? Date.now()),
          price: Number(row.p),
          size: Number(row.v),
          side,
          id,
        };
        if (print.price > 0 && print.size > 0) tape.push(print);
      }
    }
  }

  private bookOfTopic(topic: string): LocalBook | undefined {
    const symbol = topic.split(".").pop() ?? "";
    return this.books.get(symbol);
  }
}

export async function waitForBooks(feed: PublicFeed, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (feed.ready()) return;
    await Bun.sleep(100);
  }
  const missing = [...feed.books.entries()].filter(([, b]) => !b.ready).map(([s]) => s);
  throw new Error(`order book not ready for ${missing.join(", ")} after ${timeoutMs}ms`);
}
