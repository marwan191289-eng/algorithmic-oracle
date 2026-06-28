/**
 * Synthetic Cumulative Volume Delta (CVD)
 *
 * aggTrade WebSocket is blocked in Replit sandbox.
 * We compute a synthetic CVD from order-book snapshots:
 *
 *   Taker buy  ≈ ask side absorbed (ask_usd decreased since last snapshot)
 *   Taker sell ≈ bid side absorbed (bid_usd decreased since last snapshot)
 *   delta      = taker_buy − taker_sell
 *   CVD        = Σ delta  (running accumulation)
 *
 * Additionally we layer in a price-direction signal:
 *   when price ticks up   → buy-side initiated → adds to delta
 *   when price ticks down → sell-side initiated → subtracts from delta
 * This hybrid gives a more stable proxy than book-only or price-only alone.
 */
import { useEffect, useRef, useState } from "react";
import type { OrderBook } from "@/lib/binance";

export interface CVDPoint {
  t: number;
  cvd: number;         // cumulative USD delta
  delta: number;       // this tick delta
  price: number;
  buyUsd: number;      // estimated taker buy this tick
  sellUsd: number;     // estimated taker sell this tick
}

export interface CVDStats {
  cvd: number;
  delta: number;
  trend: "bullish" | "bearish" | "neutral";  // last 10-tick slope direction
  divergence: boolean;    // price up but CVD down (or vice versa) for 5+ ticks
  points: CVDPoint[];
}

const TOP_N = 100;  // top N levels to sum for stability

export function useCVD(
  book: OrderBook | null,
  mid: number,
  maxPoints = 80
): CVDStats {
  const [points, setPoints] = useState<CVDPoint[]>([]);
  const cvdRef     = useRef(0);
  const prevBid    = useRef<number | null>(null);
  const prevAsk    = useRef<number | null>(null);
  const prevMid    = useRef<number | null>(null);

  useEffect(() => {
    if (!book || !mid) return;

    // Sum top-N USD on each side
    let bidUsd = 0, askUsd = 0;
    for (const l of book.bids.slice(0, TOP_N)) bidUsd += l.qty * l.price;
    for (const l of book.asks.slice(0, TOP_N)) askUsd += l.qty * l.price;

    if (prevBid.current !== null && prevAsk.current !== null) {
      const prevB = prevBid.current;
      const prevA = prevAsk.current;

      // Book-absorption signals
      const askAbsorbed = Math.max(0, prevA - askUsd);  // asks consumed → buy pressure
      const bidAbsorbed = Math.max(0, prevB - bidUsd);  // bids consumed → sell pressure

      // Price-direction reinforcement
      let priceSig = 0;
      if (prevMid.current !== null && mid !== prevMid.current) {
        const pctChange = (mid - prevMid.current) / prevMid.current;
        // weight: 30% of total book size per 0.01% move
        const bookSize  = (bidUsd + askUsd) * 0.5;
        priceSig = pctChange * bookSize * 30;
      }

      // Blend 60% absorption + 40% price signal
      const bookDelta = askAbsorbed - bidAbsorbed;
      const delta     = bookDelta * 0.6 + priceSig * 0.4;

      // Filter micro-noise (< $500)
      if (Math.abs(delta) >= 500) {
        cvdRef.current += delta;
        const pt: CVDPoint = {
          t: Date.now(),
          cvd: cvdRef.current,
          delta,
          price: mid,
          buyUsd: askAbsorbed + Math.max(0, priceSig),
          sellUsd: bidAbsorbed + Math.max(0, -priceSig),
        };
        setPoints(prev => [...prev, pt].slice(-maxPoints));
      }
    }

    prevBid.current = bidUsd;
    prevAsk.current = askUsd;
    prevMid.current = mid;
  }, [book, mid, maxPoints]);

  // Derive stats
  const cvd = cvdRef.current;
  const delta = points.length ? points[points.length - 1].delta : 0;

  // Trend: linear slope of last 10 CVD values
  let trend: CVDStats["trend"] = "neutral";
  if (points.length >= 10) {
    const last10 = points.slice(-10);
    const slope  = (last10[9].cvd - last10[0].cvd) / 9;
    trend = slope > 500 ? "bullish" : slope < -500 ? "bearish" : "neutral";
  }

  // Divergence: price direction vs CVD direction over last 8 ticks
  let divergence = false;
  if (points.length >= 8) {
    const last = points.slice(-8);
    const priceUp = last[7].price > last[0].price;
    const cvdUp   = last[7].cvd   > last[0].cvd;
    divergence = priceUp !== cvdUp;
  }

  return { cvd, delta, trend, divergence, points };
}
