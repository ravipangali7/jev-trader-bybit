"use client";

import type { ConnectionState, Meta, SymbolBook } from "@/lib/types";
import { fmtInt } from "@/lib/format";
import styles from "./Header.module.css";

export interface HeaderProps {
  meta: Meta | null;
  connection: ConnectionState;
  books: Record<string, SymbolBook>;
}

const OFFLINE_LABEL: Partial<Record<ConnectionState, string>> = {
  connecting: "connecting",
  reconnecting: "reconnecting",
};

export default function Header({ meta, connection, books }: HeaderProps) {
  const model = meta?.model ?? null;
  const isJev = (model ?? "").toLowerCase().startsWith("jev");
  const offline = OFFLINE_LABEL[connection] ?? null;
  const bookDown = meta?.marketData === "reconnecting" ? "book reconnecting" : null;
  const symbols = meta?.symbols?.length ? meta.symbols : Object.keys(books);
  const mode = meta?.dryRun ? "dry run" : meta?.testnet ? "testnet" : meta ? "live" : "dry run";

  return (
    <div className={styles.header}>
      <span className={styles.brand}>Jev Trader</span>
      {symbols.map((symbol) => (
        <span key={symbol} className={styles.block}>
          {symbol.replace("USDT", "")} {books[symbol]?.latest ? fmtInt(books[symbol].latest.tick) : "-"}
        </span>
      ))}
      <span className={styles.spacer} />
      {offline ? <span className={styles.offline}>{offline}</span> : null}
      {bookDown ? <span className={styles.offline}>{bookDown}</span> : null}
      {meta?.killed ? <span className={styles.offline}>halted</span> : null}
      <span className={styles.wallet}>{meta ? `${meta.category} ${mode}` : mode}</span>
      {model ? (
        <span
          className={styles.badge}
          style={{
            background: isJev ? "var(--badge-jev-bg)" : "var(--badge-standin-bg)",
            color: isJev ? "var(--badge-jev-fg)" : "var(--badge-standin-fg)",
          }}
        >
          {model}
        </span>
      ) : null}
    </div>
  );
}
