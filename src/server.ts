import { config } from "./config.ts";
import type { Fill, Meta, Quote, TickEvent } from "./types.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/**
 * GET / snapshot. GET /history per-symbol events. GET /events SSE
 * (`snapshot`, `block`, `quote`, `fill`, `status`, `ping`).
 */
export function startServer(meta: () => Meta, history: () => Record<string, TickEvent[]>, port = config.port) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try {
      c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      clients.delete(c);
    }
  };
  const ping = setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  const snapshot = () => {
    const books = history();
    const latest: Record<string, TickEvent | null> = {};
    for (const [symbol, events] of Object.entries(books)) latest[symbol] = events.at(-1) ?? null;
    return { ...meta(), latest, history: books };
  };

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (url.pathname === "/") return json(snapshot());
      if (url.pathname === "/history") return json(history());
      if (url.pathname.startsWith("/history/")) {
        const symbol = decodeURIComponent(url.pathname.slice("/history/".length)).toUpperCase();
        const events = history()[symbol];
        if (!events) return json({ error: "unknown symbol" }, 404);
        return json(events);
      }
      if (url.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            clients.add(c);
            send(c, "snapshot", snapshot());
          },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, {
          headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    port: server.port,
    stop() {
      clearInterval(ping);
      server.stop();
    },
    broadcast: (e: TickEvent) => broadcast("block", e),
    broadcastQuote: (symbol: string, tick: number, quote: Quote) => broadcast("quote", { symbol, tick, block: tick, quote }),
    broadcastFill: (symbol: string, tick: number, fill: Fill) => broadcast("fill", { symbol, tick, block: tick, fill }),
    broadcastStatus: () => broadcast("status", meta()),
  };
}
