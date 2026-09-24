"use client";

import { useEffect, useReducer } from "react";
import type { ConnectionState, FeedState, Fill, Meta, Quote, SymbolBook, TickEvent } from "./types";

export { useUptime } from "./useUptime";

const CAP = 1000;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 10_000;
const STALE_MS = 45_000;

interface BookAcc extends SymbolBook {
  latSum: number;
  latCount: number;
}

interface State {
  meta: Meta | null;
  connection: ConnectionState;
  books: Record<string, BookAcc>;
}

type Action =
  | { type: "snapshot"; meta: Meta | null; history: Record<string, TickEvent[]> }
  | { type: "block"; event: TickEvent }
  | { type: "fill"; symbol: string; tick: number; fill: Fill }
  | { type: "quote"; symbol: string; tick: number; quote: Quote }
  | { type: "status"; meta: Meta }
  | { type: "connection"; connection: ConnectionState };

const emptyBook = (): BookAcc => ({ events: [], latest: null, avgLatencyMs: 0, latSum: 0, latCount: 0 });

function latencyOf(e: TickEvent): number | null {
  const d = e?.decision;
  if (!d || d.late || typeof d.latencyMs !== "number" || !Number.isFinite(d.latencyMs)) return null;
  return d.latencyMs;
}

function indexOfTick(events: TickEvent[], tick: number): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].tick === tick) return i;
  return -1;
}

function avg(latSum: number, latCount: number): number {
  return latCount > 0 ? Math.round(latSum / latCount) : 0;
}

function loadHistory(events: TickEvent[]): BookAcc {
  const capped = events.length > CAP ? events.slice(events.length - CAP) : events;
  let latSum = 0;
  let latCount = 0;
  for (const e of capped) {
    const l = latencyOf(e);
    if (l !== null) {
      latSum += l;
      latCount++;
    }
  }
  return {
    events: capped,
    latest: capped.length ? capped[capped.length - 1] : null,
    avgLatencyMs: avg(latSum, latCount),
    latSum,
    latCount,
  };
}

function append(book: BookAcc, ev: TickEvent): BookAcc {
  const prev = book.events;
  const last = prev.length ? prev[prev.length - 1] : null;
  if (last && ev.tick <= last.tick) {
    const idx = indexOfTick(prev, ev.tick);
    if (idx < 0) return book;
    const events = prev.slice();
    const old = events[idx];
    events[idx] = ev;
    let latSum = book.latSum;
    let latCount = book.latCount;
    const o = latencyOf(old);
    if (o !== null) {
      latSum -= o;
      latCount--;
    }
    const n = latencyOf(ev);
    if (n !== null) {
      latSum += n;
      latCount++;
    }
    return { events, latest: events[events.length - 1], avgLatencyMs: avg(latSum, latCount), latSum, latCount };
  }
  let latSum = book.latSum;
  let latCount = book.latCount;
  const n = latencyOf(ev);
  if (n !== null) {
    latSum += n;
    latCount++;
  }
  let events = prev.concat(ev);
  if (events.length > CAP) {
    const drop = events.length - CAP;
    for (let i = 0; i < drop; i++) {
      const l = latencyOf(events[i]);
      if (l !== null) {
        latSum -= l;
        latCount--;
      }
    }
    events = events.slice(drop);
  }
  return { events, latest: ev, avgLatencyMs: avg(latSum, latCount), latSum, latCount };
}

function patch(book: BookAcc, tick: number, patcher: (e: TickEvent) => TickEvent): BookAcc {
  const idx = indexOfTick(book.events, tick);
  if (idx < 0) return book;
  const events = book.events.slice();
  events[idx] = patcher(events[idx]);
  return { ...book, events, latest: idx === events.length - 1 ? events[idx] : book.latest };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };
    case "status":
      return { ...state, meta: action.meta };
    case "snapshot": {
      const books: Record<string, BookAcc> = {};
      for (const [symbol, events] of Object.entries(action.history)) books[symbol] = loadHistory(events);
      return { ...state, meta: action.meta ?? state.meta, books, connection: "live" };
    }
    case "block": {
      const ev = action.event;
      if (!ev || typeof ev.tick !== "number" || !ev.symbol) return state;
      const book = state.books[ev.symbol] ?? emptyBook();
      return { ...state, books: { ...state.books, [ev.symbol]: append(book, ev) } };
    }
    case "fill": {
      const book = state.books[action.symbol];
      if (!book) return state;
      return {
        ...state,
        books: { ...state.books, [action.symbol]: patch(book, action.tick, (e) => ({ ...e, fill: action.fill })) },
      };
    }
    case "quote": {
      const book = state.books[action.symbol];
      if (!book) return state;
      return {
        ...state,
        books: { ...state.books, [action.symbol]: patch(book, action.tick, (e) => ({ ...e, quote: action.quote })) },
      };
    }
    default:
      return state;
  }
}

function parseMeta(raw: Record<string, unknown> | null): Meta | null {
  if (!raw) return null;
  const fees = (raw.fees ?? {}) as Record<string, unknown>;
  const category = raw.category === "spot" ? "spot" : "linear";
  const marketData = raw.marketData === "live" || raw.marketData === "reconnecting" ? raw.marketData : "connecting";
  return {
    model: typeof raw.model === "string" ? raw.model : "",
    dryRun: raw.dryRun !== false,
    testnet: Boolean(raw.testnet),
    category,
    symbols: Array.isArray(raw.symbols) ? raw.symbols.filter((s): s is string => typeof s === "string") : ["SOLUSDT", "XRPUSDT"],
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
    killed: Boolean(raw.killed),
    killReason: typeof raw.killReason === "string" ? raw.killReason : null,
    marketData,
    wallet: typeof raw.wallet === "string" ? raw.wallet : null,
    fees: {
      maker: typeof fees.maker === "number" ? fees.maker : 0,
      taker: typeof fees.taker === "number" ? fees.taker : 0,
      source: typeof fees.source === "string" ? fees.source : "",
    },
    loopMs: typeof raw.loopMs === "number" ? raw.loopMs : 300,
  };
}

const initial: State = { meta: null, connection: "connecting", books: {} };

/** Live feed over SSE. One connection, one book per symbol. */
export function useFeed(apiUrl: string): FeedState {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const base = (apiUrl || "").replace(/\/+$/, "");
    let closed = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (!closed) scheduleReconnect();
      }, STALE_MS);
    };
    const teardown = () => {
      if (es) {
        es.onopen = null;
        es.onerror = null;
        es.close();
        es = null;
      }
      if (staleTimer) clearTimeout(staleTimer);
    };
    const scheduleReconnect = () => {
      if (closed) return;
      teardown();
      dispatch({ type: "connection", connection: "reconnecting" });
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
      attempt++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };
    const handle = (type: string, fn: (data: unknown) => void) => {
      es?.addEventListener(type, (raw: Event) => {
        armStaleTimer();
        const payload = (raw as MessageEvent).data;
        if (typeof payload !== "string" || !payload) return;
        let data: unknown;
        try { data = JSON.parse(payload); } catch { return; }
        fn(data);
      });
    };

    function connect() {
      if (closed) return;
      dispatch({ type: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" });
      es = new EventSource(`${base}/events`);
      es.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connection: "live" });
        armStaleTimer();
      };
      es.onerror = () => { if (!closed) scheduleReconnect(); };
      handle("snapshot", (data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        const history = d.history && typeof d.history === "object" && !Array.isArray(d.history)
          ? d.history as Record<string, TickEvent[]>
          : {};
        dispatch({ type: "snapshot", meta: parseMeta(d), history });
      });
      handle("block", (data) => dispatch({ type: "block", event: data as TickEvent }));
      handle("fill", (data) => {
        const d = (data ?? {}) as { symbol?: string; tick?: number; fill?: Fill };
        if (!d.symbol || typeof d.tick !== "number" || !d.fill) return;
        dispatch({ type: "fill", symbol: d.symbol, tick: d.tick, fill: d.fill });
      });
      handle("quote", (data) => {
        const d = (data ?? {}) as { symbol?: string; tick?: number; quote?: Quote };
        if (!d.symbol || typeof d.tick !== "number" || !d.quote) return;
        dispatch({ type: "quote", symbol: d.symbol, tick: d.tick, quote: d.quote });
      });
      handle("status", (data) => {
        const meta = parseMeta((data ?? {}) as Record<string, unknown>);
        if (meta) dispatch({ type: "status", meta });
      });
      handle("ping", () => dispatch({ type: "connection", connection: "live" }));
    }

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
    };
  }, [apiUrl]);

  const books: FeedState["books"] = {};
  for (const [symbol, book] of Object.entries(state.books)) {
    books[symbol] = { events: book.events, latest: book.latest, avgLatencyMs: book.avgLatencyMs };
  }
  return { meta: state.meta, connection: state.connection, books };
}

export default useFeed;
