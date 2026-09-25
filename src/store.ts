import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { AccountFill } from "./account.ts";
import type { Side } from "./types.ts";

export interface EquityRow {
  symbol: string;
  ts: number;
  equityUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  positionQty: number;
  pnlUsd: number;
}

interface TradeRow {
  id: number;
  symbol: string;
  ts: number;
  side: Side;
  size: number;
  price: number;
  fee_usd: number;
  realized_usd: number;
  position_qty: number;
  equity_usd: number;
  simulated: number;
  order_id: string | null;
  exec_id: string | null;
}

interface EquitySql {
  symbol: string;
  ts: number;
  equity_usd: number;
  realized_usd: number;
  unrealized_usd: number;
  fees_usd: number;
  position_qty: number;
  pnl_usd: number;
}

/**
 * Paper fills and equity snapshots. WAL so a crash keeps the last commit.
 * `symbol` on equity rows is a pair such as SOLUSDT, or COMBINED.
 */
export class PaperStore {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        price REAL NOT NULL,
        fee_usd REAL NOT NULL,
        realized_usd REAL NOT NULL,
        position_qty REAL NOT NULL,
        equity_usd REAL NOT NULL,
        simulated INTEGER NOT NULL,
        order_id TEXT,
        exec_id TEXT
      );
      CREATE INDEX IF NOT EXISTS trades_symbol_id ON trades(symbol, id);
      CREATE TABLE IF NOT EXISTS equity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        equity_usd REAL NOT NULL,
        realized_usd REAL NOT NULL,
        unrealized_usd REAL NOT NULL,
        fees_usd REAL NOT NULL,
        position_qty REAL NOT NULL,
        pnl_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS equity_symbol_ts ON equity(symbol, ts);
    `);
  }

  close() {
    this.db.close();
  }

  reset() {
    this.db.exec("DELETE FROM trades; DELETE FROM equity; DELETE FROM meta;");
  }

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** First process start of this paper run. Stable across restarts until reset. */
  startedAt(): number {
    const existing = this.getMeta("started_at");
    if (existing) {
      const n = Number(existing);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const now = Date.now();
    this.setMeta("started_at", String(now));
    return now;
  }

  peak(symbol: string): number {
    const n = Number(this.getMeta(`peak:${symbol}`) ?? "0");
    return Number.isFinite(n) ? n : 0;
  }

  setPeak(symbol: string, equity: number) {
    if (!(equity > this.peak(symbol))) return;
    this.setMeta(`peak:${symbol}`, String(equity));
  }

  maxEquity(symbol: string): number {
    const row = this.db.query("SELECT MAX(equity_usd) AS m FROM equity WHERE symbol = ?").get(symbol) as { m: number | null } | null;
    return row?.m ?? 0;
  }

  insertTrade(fill: AccountFill) {
    this.db.query(`
      INSERT INTO trades (symbol, ts, side, size, price, fee_usd, realized_usd, position_qty, equity_usd, simulated, order_id, exec_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fill.symbol,
      fill.ts,
      fill.side,
      fill.size,
      fill.price,
      fill.feeUsd,
      fill.realizedUsd,
      fill.positionQty,
      fill.equityUsd,
      fill.simulated ? 1 : 0,
      fill.orderId,
      fill.execId,
    );
  }

  /** Oldest first, for replay. */
  allTrades(symbol?: string): AccountFill[] {
    const rows = symbol
      ? this.db.query("SELECT * FROM trades WHERE symbol = ? ORDER BY id ASC").all(symbol) as TradeRow[]
      : this.db.query("SELECT * FROM trades ORDER BY id ASC").all() as TradeRow[];
    return rows.map(toFill);
  }

  /** Newest first. */
  trades(opts: { symbol?: string; limit: number; offset: number }): { trades: AccountFill[]; total: number } {
    const limit = Math.min(500, Math.max(1, Math.floor(opts.limit)));
    const offset = Math.max(0, Math.floor(opts.offset));
    if (opts.symbol) {
      const total = (this.db.query("SELECT COUNT(*) AS n FROM trades WHERE symbol = ?").get(opts.symbol) as { n: number }).n;
      const rows = this.db.query("SELECT * FROM trades WHERE symbol = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(opts.symbol, limit, offset) as TradeRow[];
      return { trades: rows.map(toFill), total };
    }
    const total = (this.db.query("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
    const rows = this.db.query("SELECT * FROM trades ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as TradeRow[];
    return { trades: rows.map(toFill), total };
  }

  insertEquity(row: EquityRow) {
    this.db.query(`
      INSERT INTO equity (symbol, ts, equity_usd, realized_usd, unrealized_usd, fees_usd, position_qty, pnl_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.symbol, row.ts, row.equityUsd, row.realizedUsd, row.unrealizedUsd, row.feesUsd, row.positionQty, row.pnlUsd);
  }

  /** Oldest first, capped so a long run stays readable. */
  equitySeries(symbol: string, limit = 5000): EquityRow[] {
    const rows = this.db.query(
      "SELECT symbol, ts, equity_usd, realized_usd, unrealized_usd, fees_usd, position_qty, pnl_usd FROM equity WHERE symbol = ? ORDER BY id DESC LIMIT ?",
    ).all(symbol, limit) as EquitySql[];
    return rows.reverse().map((r) => ({
      symbol: r.symbol,
      ts: r.ts,
      equityUsd: r.equity_usd,
      realizedUsd: r.realized_usd,
      unrealizedUsd: r.unrealized_usd,
      feesUsd: r.fees_usd,
      positionQty: r.position_qty,
      pnlUsd: r.pnl_usd,
    }));
  }
}

function toFill(r: TradeRow): AccountFill {
  return {
    symbol: r.symbol,
    ts: r.ts,
    side: r.side,
    size: r.size,
    price: r.price,
    feeUsd: r.fee_usd,
    realizedUsd: r.realized_usd,
    positionQty: r.position_qty,
    equityUsd: r.equity_usd,
    simulated: r.simulated === 1,
    orderId: r.order_id,
    execId: r.exec_id,
  };
}
