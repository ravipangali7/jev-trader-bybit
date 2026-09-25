"use client";

import { useEffect, useState } from "react";
import styles from "./Performance.module.css";

interface Metrics {
  startUsd: number;
  fills: number;
  roundTrips: number;
  wins: number;
  winRate: number | null;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  pnlUsd: number;
  roiPct: number;
  drawdownUsd: number;
  drawdownPct: number;
  equityUsd: number;
  positionQty: number;
  peakEquityUsd: number;
}

interface Summary {
  startedAt: number;
  runMs: number;
  symbols: Record<string, Metrics>;
  combined: Metrics;
}

interface Trade {
  symbol: string;
  ts: number;
  side: "buy" | "sell";
  size: number;
  price: number;
  feeUsd: number;
  realizedUsd: number;
  positionQty: number;
}

interface EquityPoint {
  symbol: string;
  ts: number;
  equityUsd: number;
  pnlUsd: number;
}

const PAGE = 25;
const COLORS: Record<string, string> = {
  SOLUSDT: "#0FA968",
  XRPUSDT: "#7B6ED9",
  COMBINED: "#0A0A0A",
};

function money(n: number, d = 2): string {
  const v = Number.isFinite(n) ? n : 0;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`;
}

function signed(n: number, d = 4): string {
  const v = Number.isFinite(n) ? n : 0;
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(d)}`;
}

function pct(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function runTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function qty(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 1e8) / 1e8);
}

function tone(n: number): string {
  if (n > 1e-9) return styles.pos;
  if (n < -1e-9) return styles.neg;
  return "";
}

function Card({ title, m, position }: { title: string; m: Metrics; position?: number }) {
  const win = m.winRate === null ? "none yet" : `${(m.winRate * 100).toFixed(1)}%`;
  return (
    <article className={styles.card}>
      <h3>{title}</h3>
      <p className={`${styles.equity} ${tone(m.pnlUsd)}`}>{money(m.equityUsd)}</p>
      <p className={styles.sub}>
        P&L <span className={tone(m.pnlUsd)}>{signed(m.pnlUsd)}</span>
        <span className={styles.gap}>ROI {pct(m.roiPct)}</span>
      </p>
      <dl>
        <div><dt>Realized</dt><dd className={tone(m.realizedUsd)}>{signed(m.realizedUsd)}</dd></div>
        <div><dt>Unrealized</dt><dd className={tone(m.unrealizedUsd)}>{signed(m.unrealizedUsd)}</dd></div>
        <div><dt>Fees</dt><dd>{money(m.feesUsd, 4)}</dd></div>
        <div><dt>Fills</dt><dd>{m.fills}</dd></div>
        <div><dt>Round trips</dt><dd>{m.roundTrips}</dd></div>
        <div><dt>Win rate</dt><dd>{win}</dd></div>
        <div><dt>Max drawdown</dt><dd>{money(m.drawdownUsd)} ({m.drawdownPct.toFixed(2)}%)</dd></div>
        {position === undefined ? null : <div><dt>Position</dt><dd>{position.toFixed(4)}</dd></div>}
        <div><dt>Start</dt><dd>{money(m.startUsd)}</dd></div>
      </dl>
    </article>
  );
}

function Chart({ series }: { series: { name: string; points: EquityPoint[] }[] }) {
  const width = 800;
  const height = 220;
  const left = 52;
  const right = 12;
  const top = 16;
  const bottom = 28;
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) {
    return <p className={styles.empty}>Equity snapshots appear after the first sample. The chart fills in as the run continues.</p>;
  }
  let min = Math.min(...all.map((p) => p.pnlUsd));
  let max = Math.max(...all.map((p) => p.pnlUsd));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const t0 = Math.min(...all.map((p) => p.ts));
  const t1 = Math.max(...all.map((p) => p.ts));
  const span = Math.max(1, t1 - t0);
  const x = (ts: number) => left + ((ts - t0) / span) * (width - left - right);
  const y = (v: number) => top + ((max - v) / (max - min)) * (height - top - bottom);
  const yZero = y(0);
  const ticks = [max, (max + min) / 2, min];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={styles.chart} role="img" aria-label="P and L over time">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={left} x2={width - right} y1={y(v)} y2={y(v)} className={styles.grid} />
          <text x={left - 8} y={y(v) + 4} textAnchor="end" className={styles.axis}>{money(v)}</text>
        </g>
      ))}
      <line x1={left} x2={width - right} y1={yZero} y2={yZero} className={styles.zero} />
      {series.map((s) => {
        if (s.points.length < 2) return null;
        const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.pnlUsd).toFixed(1)}`).join(" ");
        return <path key={s.name} d={d} fill="none" stroke={COLORS[s.name] ?? "#0A0A0A"} strokeWidth={1.6} />;
      })}
    </svg>
  );
}

export default function Performance({ api, symbols }: { api: string; symbols: string[] }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [equity, setEquity] = useState<Record<string, EquityPoint[]>>({});
  const [trades, setTrades] = useState<Trade[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const [s, e, t] = await Promise.all([
          fetch(`${api}/summary`),
          fetch(`${api}/equity`),
          fetch(`${api}/trades?limit=${PAGE}&offset=${offset}`),
        ]);
        if (!s.ok || !e.ok || !t.ok) throw new Error("performance API unavailable");
        const summaryBody = await s.json() as Summary;
        const equityBody = await e.json() as Record<string, EquityPoint[]>;
        const tradeBody = await t.json() as { trades: Trade[]; total: number };
        if (stop) return;
        setSummary(summaryBody);
        setEquity(equityBody);
        setTrades(tradeBody.trades);
        setTotal(tradeBody.total);
        setError(null);
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "performance API unavailable");
      }
    };
    void load();
    const id = setInterval(() => void load(), 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [api, offset]);

  const names = symbols.length ? symbols : ["SOLUSDT", "XRPUSDT"];
  const series = [
    ...names.map((name) => ({ name, points: equity[name] ?? [] })),
    { name: "COMBINED", points: equity.COMBINED ?? [] },
  ];

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <h2>Paper performance</h2>
        <p>{summary ? `Run time ${runTime(summary.runMs)}` : "Waiting for the bot"}{error ? `. ${error}` : ""}</p>
      </div>
      <div className={styles.cards}>
        {names.map((name) => {
          const m = summary?.symbols[name];
          return m ? <Card key={name} title={name} m={m} position={m.positionQty} /> : <article key={name} className={styles.card}><h3>{name}</h3><p className={styles.empty}>Waiting for a book</p></article>;
        })}
        {summary ? <Card title="Combined" m={summary.combined} /> : null}
      </div>
      <div className={styles.panel}>
        <div className={styles.legend}>
          <span>P&L over time</span>
          {series.map((s) => (
            <span key={s.name} className={styles.key}><i style={{ background: COLORS[s.name] ?? "#0A0A0A" }} />{s.name === "COMBINED" ? "Combined" : s.name}</span>
          ))}
        </div>
        <Chart series={series} />
      </div>
      <div className={styles.panel}>
        <div className={styles.legend}>
          <span>Trades</span>
          <span className={styles.pager}>
            <button type="button" disabled={offset === 0} onClick={() => setOffset((n) => Math.max(0, n - PAGE))}>Newer</button>
            <button type="button" disabled={offset + trades.length >= total} onClick={() => setOffset((n) => n + PAGE)}>Older</button>
          </span>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>Fee</th>
                <th>Realized P&L</th>
                <th>Position</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr><td colSpan={8} className={styles.empty}>No fills yet. A simulated fill lands when a public trade crosses the resting order.</td></tr>
              ) : trades.map((t, i) => (
                <tr key={`${t.ts}-${t.symbol}-${i}`}>
                  <td>{clock(t.ts)}</td>
                  <td>{t.symbol}</td>
                  <td className={t.side === "buy" ? styles.pos : styles.neg}>{t.side}</td>
                  <td>{qty(t.size)}</td>
                  <td>{t.price}</td>
                  <td>{money(t.feeUsd, 4)}</td>
                  <td className={tone(t.realizedUsd)}>{signed(t.realizedUsd)}</td>
                  <td>{qty(t.positionQty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
