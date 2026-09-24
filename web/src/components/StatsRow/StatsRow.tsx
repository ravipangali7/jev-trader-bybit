"use client";

import { useEffect, useState } from "react";
import type { Meta, SymbolBook } from "@/lib/types";
import { fmtInt, uptime } from "@/lib/format";
import styles from "./StatsRow.module.css";

const DASH = "-";

export default function StatsRow({
  meta,
  books,
}: {
  meta: Meta | null;
  books: Record<string, SymbolBook>;
}) {
  const startedAt = meta?.startedAt ?? null;
  const [up, setUp] = useState<string | null>(null);

  useEffect(() => {
    if (startedAt == null) {
      setUp(null);
      return;
    }
    const tick = () => setUp(uptime(startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  let decisions = 0;
  let fills = 0;
  let latSum = 0;
  let latN = 0;
  for (const book of Object.values(books)) {
    const t = book.latest?.totals;
    if (t) {
      decisions += t.decisions;
      fills += t.fills;
    }
    if (book.avgLatencyMs > 0) {
      latSum += book.avgLatencyMs;
      latN++;
    }
  }
  const avg = latN > 0 ? `${Math.round(latSum / latN)}ms` : DASH;
  const fee = meta ? `${(meta.fees.maker * 100).toFixed(3)}% maker` : DASH;

  return (
    <div className={styles.stats}>
      <span>avg {avg}</span>
      <span className={styles.nowrap}>{decisions ? fmtInt(decisions) : DASH} calls</span>
      <span className={styles.nowrap}>{fills ? fmtInt(fills) : DASH} fills</span>
      <span>{fee}</span>
      <span className={styles.spacer} />
      <span>uptime {up ?? "00:00:00"}</span>
    </div>
  );
}
