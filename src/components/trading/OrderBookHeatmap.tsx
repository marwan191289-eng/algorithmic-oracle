import { useMemo } from "react";
import type { OrderBook } from "@/lib/binance";
import { fmtPrice, fmtQty, fmtUsd } from "@/lib/binance";
import type { BookMetrics } from "@/lib/analysis";
import { cn } from "@/lib/utils";

export function OrderBookHeatmap({
  book,
  metrics,
  rows = 16,
}: {
  book: OrderBook;
  metrics: BookMetrics;
  rows?: number;
}) {
  const bids = book.bids.slice(0, rows);
  const asks = book.asks.slice(0, rows).reverse(); // ascending visually top→down with best near mid

  const maxQty = useMemo(() => {
    const m = Math.max(
      ...bids.map((b) => b.qty),
      ...asks.map((a) => a.qty),
      1
    );
    return m;
  }, [bids, asks]);

  return (
    <div className="font-mono text-[12px] select-none">
      <div className="grid grid-cols-[1.2fr_1fr_1fr] px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
        <span className="text-right">السعر</span>
        <span className="text-center">الكمية</span>
        <span className="text-left">القيمة (USDT)</span>
      </div>

      {/* Asks (top, descending toward mid) */}
      <div>
        {asks.map((a) => {
          const w = (a.qty / maxQty) * 100;
          return (
            <Row
              key={`a-${a.price}`}
              side="ask"
              price={a.price}
              qty={a.qty}
              usd={a.qty * a.price}
              fillPct={w}
            />
          );
        })}
      </div>

      {/* Spread */}
      <div className="px-3 py-2 border-y border-primary/40 bg-primary/5 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">الفارق</span>
        <span className="text-primary font-semibold mono">
          {metrics.spread.toFixed(metrics.mid > 100 ? 2 : 4)} (
          {metrics.spreadPct.toFixed(3)}%)
        </span>
        <span className="text-primary font-bold mono">
          {fmtPrice(metrics.mid)}
        </span>
      </div>

      {/* Bids */}
      <div>
        {bids.map((b) => {
          const w = (b.qty / maxQty) * 100;
          return (
            <Row
              key={`b-${b.price}`}
              side="bid"
              price={b.price}
              qty={b.qty}
              usd={b.qty * b.price}
              fillPct={w}
            />
          );
        })}
      </div>
    </div>
  );
}

function Row({
  side,
  price,
  qty,
  usd,
  fillPct,
}: {
  side: "bid" | "ask";
  price: number;
  qty: number;
  usd: number;
  fillPct: number;
}) {
  const isBid = side === "bid";
  return (
    <div
      className="relative grid grid-cols-[1.2fr_1fr_1fr] px-3 py-[3px] hover:bg-accent/30 transition-colors"
    >
      <div
        className={cn(
          "absolute inset-y-0 right-0 transition-all",
          isBid ? "bg-[var(--bull-soft)]" : "bg-[var(--bear-soft)]"
        )}
        style={{ width: `${fillPct}%` }}
      />
      <span
        className={cn(
          "relative text-right font-semibold",
          isBid ? "text-bull" : "text-bear"
        )}
      >
        {fmtPrice(price)}
      </span>
      <span className="relative text-center text-foreground/90">
        {fmtQty(qty)}
      </span>
      <span className="relative text-left text-muted-foreground">
        {fmtUsd(usd)}
      </span>
    </div>
  );
}
