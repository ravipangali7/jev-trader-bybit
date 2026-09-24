"use client";

import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import StatsRow from "@/components/StatsRow/StatsRow";
import { useFeed } from "@/lib/useFeed";
import styles from "./page.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export default function Page() {
  const feed = useFeed(API_URL);
  const symbols = feed.meta?.symbols?.length ? feed.meta.symbols : ["SOLUSDT", "XRPUSDT"];
  const category = feed.meta?.category ?? "linear";
  const testnet = feed.meta?.testnet ?? false;
  const venue = `Bybit ${category}`;

  return (
    <div className="card">
      <Header meta={feed.meta} connection={feed.connection} books={feed.books} />
      <StatsRow meta={feed.meta} books={feed.books} />
      {feed.meta?.killed ? (
        <div className={styles.halt}>{feed.meta.killReason ?? "quoting stopped"}</div>
      ) : null}
      <div className={styles.columns}>
        {symbols.map((symbol) => {
          const book = feed.books[symbol];
          const latest = book?.latest ?? null;
          return (
            <section key={symbol} className={styles.column}>
              <div className={styles.chartWrap}>
                <FlowChart
                  events={book?.events ?? []}
                  latest={latest}
                  symbol={symbol}
                  priceDecimals={latest?.priceDecimals ?? (symbol === "XRPUSDT" ? 4 : 2)}
                  venue={venue}
                />
              </div>
              <div className={styles.lower}>
                <DecisionPanel latest={latest} symbol={symbol} />
                <Feed events={book?.events ?? []} symbol={symbol} testnet={testnet} category={category} />
              </div>
            </section>
          );
        })}
      </div>
      <p className={styles.footer}>Experimental. Paper trading until DRY_RUN is false. Not financial advice.</p>
    </div>
  );
}
